'use strict';

const EXCEPTION_QUERY_TIMEOUT_MS = 30_000;
const CONTEXT_ERROR_CODE = 'abnormal_query_context_unavailable';
const TIMEOUT_ERROR_CODE = 'exception_query_timeout';

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeIdentity(value) {
  return normalizeText(value).toLocaleLowerCase();
}

function makeSafeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function resolveAbnormalQueryContext(state = {}, request = {}) {
  const currentUsername = normalizeText(state.currentUsername);
  const commandIdentity = normalizeText(state.orderCommandAccountIdentity);
  const activeAccountId = normalizeText(state.activeMerchantAccountId);
  const csrfToken = normalizeText(state.csrfToken);
  const sellerId = normalizeText(state.sellerId);
  const userData = state.userData && typeof state.userData === 'object' ? state.userData : null;
  const merchantAccounts = Array.isArray(state.merchantAccounts) ? state.merchantAccounts : [];

  const fail = () => {
    throw makeSafeError(
      CONTEXT_ERROR_CODE,
      '当前商家账号或事业部查询上下文不可用，请重新登录并选择事业部后重试'
    );
  };

  if (!currentUsername || !commandIdentity || normalizeIdentity(currentUsername) !== normalizeIdentity(commandIdentity)) fail();
  if (!activeAccountId || !csrfToken || !sellerId || !userData) fail();

  const activeAccount = merchantAccounts.find(account => normalizeText(account && account.id) === activeAccountId);
  if (!activeAccount || normalizeIdentity(activeAccount.username) !== normalizeIdentity(currentUsername)) fail();

  const deptPairs = Array.isArray(userData.deptPairs) ? userData.deptPairs : [];
  const selectedDeptNo = normalizeText(userData.selectedDeptId);
  const selectedDeptName = normalizeText(userData.selectedDeptName);
  const requestedDeptNo = normalizeText(request.requestedDeptNo);
  const requireSelectedDepartment = request.requireSelectedDepartment === true;
  const contextDeptNo = requestedDeptNo || selectedDeptNo;
  const contextPair = deptPairs.find(pair => normalizeText(pair && pair.deptNo) === contextDeptNo);

  if (!contextDeptNo || !contextPair) fail();
  if (requireSelectedDepartment && (!selectedDeptNo || contextDeptNo !== selectedDeptNo)) fail();
  if (selectedDeptName && contextDeptNo === selectedDeptNo &&
      normalizeText(contextPair.deptName) !== selectedDeptName) fail();
  if (normalizeText(contextPair.sellerId) && normalizeText(contextPair.sellerId) !== sellerId) fail();

  const requestedMerchantName = normalizeText(request.requestedMerchantName);
  if (requestedMerchantName && normalizeText(contextPair.sellerName) !== requestedMerchantName) fail();

  return {
    csrfToken,
    sellerId,
    sellerNo: `CCP00${sellerId}`,
    // 手工页面的事业部下拉值实际是 deptNo，并沿用既有调用链写入该接口的 deptName 字段。
    billExceptionDeptValue: requestedDeptNo || (requireSelectedDepartment ? selectedDeptNo : ''),
    contextDeptNo,
    contextDeptName: normalizeText(contextPair.deptName),
    contextMerchantName: normalizeText(contextPair.sellerName)
  };
}

function assertRequiredExceptionSources(results, requireAllSources) {
  if (requireAllSources !== true) return;
  const sources = [
    ['billexception', '异常中心'],
    ['soExceptionCentre', '异常订单中心']
  ];
  for (let index = 0; index < sources.length; index += 1) {
    const result = results[index];
    if (!result || result.status !== 'fulfilled' || !result.value || !Array.isArray(result.value.aaData)) {
      const error = makeSafeError(
        'exception_query_incomplete',
        `${sources[index][1]}查询失败，无法确认订单完整异常状态`
      );
      error.source = sources[index][0];
      throw error;
    }
  }
}

async function fetchJsonWithTimeout(fetchImpl, url, options = {}, config = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : EXCEPTION_QUERY_TIMEOUT_MS;
  const setTimer = config.setTimer || setTimeout;
  const clearTimer = config.clearTimer || clearTimeout;
  const AbortControllerImpl = config.AbortControllerImpl || AbortController;
  const controller = new AbortControllerImpl();
  let timeoutId;
  let timedOut = false;

  const timeoutError = () => makeSafeError(
    TIMEOUT_ERROR_CODE,
    '异常订单查询接口响应超时，请稍后重试'
  );

  const operation = Promise.resolve().then(async () => {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const text = await response.text();
    return JSON.parse(text);
  });
  // Promise.race 保证即便底层实现没有及时响应 abort，调用者也会在固定时间内结算。
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimer(() => {
      timedOut = true;
      try { controller.abort(); } catch (_) {}
      reject(timeoutError());
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (timedOut || (controller.signal && controller.signal.aborted)) throw timeoutError();
    throw error;
  } finally {
    clearTimer(timeoutId);
  }
}

module.exports = {
  CONTEXT_ERROR_CODE,
  EXCEPTION_QUERY_TIMEOUT_MS,
  TIMEOUT_ERROR_CODE,
  assertRequiredExceptionSources,
  fetchJsonWithTimeout,
  resolveAbnormalQueryContext
};
