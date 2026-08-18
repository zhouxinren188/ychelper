'use strict';

const EXCEPTION_QUERY_TIMEOUT_MS = 1_000;
const EXCEPTION_QUERY_MAX_RETRIES = 3;
const EXCEPTION_QUERY_RETRY_DELAY_MS = 200;
const CONTEXT_ERROR_CODE = 'abnormal_query_context_unavailable';
const TIMEOUT_ERROR_CODE = 'exception_query_timeout';
const EXCEPTION_QUERY_TIMEOUT_MESSAGE = '云仓异常订单查询超时，请稍后重试';
const MERCHANT_SESSION_EXPIRED_CODE = 'merchant_session_expired';
const MERCHANT_SESSION_EXPIRED_MESSAGE = '云仓助手商家登录已失效，请在绑定机器码的云仓助手重新登录后再试';

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

function makeMerchantSessionExpiredError() {
  return makeSafeError(MERCHANT_SESSION_EXPIRED_CODE, MERCHANT_SESSION_EXPIRED_MESSAGE);
}

function readResponseHeader(response, name) {
  const headers = response && response.headers;
  if (!headers) return '';
  if (typeof headers.get === 'function') return normalizeText(headers.get(name));
  const target = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === target) return normalizeText(value);
  }
  return '';
}

function isMerchantLoginLocation(value) {
  const raw = normalizeText(value);
  if (!raw) return false;
  try {
    const parsed = new URL(raw, 'https://o.jdl.com');
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    return host.includes('passport') || /\/(?:login|logon|sso)(?:\/|$)/.test(pathname);
  } catch (_) {
    return /passport|\/(?:login|logon|sso)(?:[/?#]|$)/i.test(raw);
  }
}

function looksLikeMerchantLoginHtml(text) {
  const body = String(text || '');
  if (!/<(?:!doctype\s+html|html|form)\b/i.test(body)) return false;
  return /passport\.(?:jd|jdl)\.com|账号登录|商家登录|登录商家端|请重新登录|(?:name|id)=["'](?:loginname|loginform|username|password)["']/i.test(body);
}

function jsonIndicatesMerchantSessionExpired(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidates = [value];
  if (value.data && typeof value.data === 'object' && !Array.isArray(value.data)) {
    candidates.push(value.data);
  }
  const expiredCodes = new Set([
    '401', '403', 'not_login', 'not_logged_in', 'login_required',
    'session_expired', 'session_invalid', 'unauthorized'
  ]);
  const messagePattern = /(?:未登录|登录(?:已)?失效|会话(?:已)?失效|登录状态(?:已)?失效|请(?:先|重新)?登录)/;
  for (const candidate of candidates) {
    for (const key of ['code', 'status', 'resultCode', 'errorCode']) {
      if (expiredCodes.has(normalizeText(candidate[key]).toLowerCase())) return true;
    }
    for (const key of ['isLogin', 'loggedIn', 'loginValid', 'authenticated']) {
      if (candidate[key] === false) return true;
    }
    for (const key of ['message', 'msg', 'error', 'errorMessage', 'tipMsg']) {
      if (messagePattern.test(normalizeText(candidate[key]))) return true;
    }
  }
  return false;
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
  const expired = results.find(result => result && result.status === 'rejected' &&
    result.reason && result.reason.code === MERCHANT_SESSION_EXPIRED_CODE);
  if (expired) throw makeMerchantSessionExpiredError();
  const timedOut = results.find(result => result && result.status === 'rejected' &&
    result.reason && result.reason.code === TIMEOUT_ERROR_CODE);
  if (timedOut) throw makeSafeError(TIMEOUT_ERROR_CODE, EXCEPTION_QUERY_TIMEOUT_MESSAGE);
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

async function measureExceptionSource(source, operation, options = {}) {
  if (typeof operation !== 'function') throw new TypeError('operation must be a function');
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const startedAt = now();
  let outcome = 'failed';
  let count = 0;
  try {
    const value = await operation();
    outcome = 'succeeded';
    count = value && Array.isArray(value.aaData) ? value.aaData.length : 0;
    return value;
  } finally {
    const measurement = {
      source: String(source || 'unknown'),
      duration_ms: Math.max(0, Math.round(now() - startedAt)),
      outcome,
      count
    };
    if (typeof options.onComplete === 'function') options.onComplete(measurement);
  }
}

async function retryTimedOutExceptionQuery(operation, options = {}) {
  if (typeof operation !== 'function') throw new TypeError('operation must be a function');
  const maxRetries = Number.isInteger(options.maxRetries)
    ? Math.max(0, options.maxRetries)
    : EXCEPTION_QUERY_MAX_RETRIES;
  const retryDelayMs = Number.isFinite(options.retryDelayMs)
    ? Math.max(0, options.retryDelayMs)
    : EXCEPTION_QUERY_RETRY_DELAY_MS;
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : delayMs => new Promise(resolve => setTimeout(resolve, delayMs));

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await operation(attempt + 1);
    } catch (error) {
      if (!error || error.code !== TIMEOUT_ERROR_CODE || attempt >= maxRetries) throw error;
      await sleep(retryDelayMs);
    }
  }
  throw makeSafeError(TIMEOUT_ERROR_CODE, EXCEPTION_QUERY_TIMEOUT_MESSAGE);
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
    EXCEPTION_QUERY_TIMEOUT_MESSAGE
  );

  const operation = Promise.resolve().then(async () => {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const status = Number(response && response.status) || 0;
    if (status === 401 || status === 403) throw makeMerchantSessionExpiredError();
    const location = readResponseHeader(response, 'location');
    if ((response && response.redirected === true && isMerchantLoginLocation(response.url)) ||
        ([301, 302, 303, 307, 308].includes(status) && isMerchantLoginLocation(location))) {
      throw makeMerchantSessionExpiredError();
    }
    const text = await response.text();
    if (looksLikeMerchantLoginHtml(text)) throw makeMerchantSessionExpiredError();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      if (status && (status < 200 || status >= 300)) {
        throw makeSafeError('exception_query_http_error', '异常订单查询接口请求失败');
      }
      throw error;
    }
    if (jsonIndicatesMerchantSessionExpired(parsed)) throw makeMerchantSessionExpiredError();
    if (status && (status < 200 || status >= 300)) {
      throw makeSafeError('exception_query_http_error', '异常订单查询接口请求失败');
    }
    return parsed;
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
  EXCEPTION_QUERY_MAX_RETRIES,
  EXCEPTION_QUERY_RETRY_DELAY_MS,
  EXCEPTION_QUERY_TIMEOUT_MS,
  EXCEPTION_QUERY_TIMEOUT_MESSAGE,
  MERCHANT_SESSION_EXPIRED_CODE,
  MERCHANT_SESSION_EXPIRED_MESSAGE,
  TIMEOUT_ERROR_CODE,
  assertRequiredExceptionSources,
  fetchJsonWithTimeout,
  isMerchantLoginLocation,
  jsonIndicatesMerchantSessionExpired,
  looksLikeMerchantLoginHtml,
  measureExceptionSource,
  retryTimedOutExceptionQuery,
  resolveAbnormalQueryContext
};
