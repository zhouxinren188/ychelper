'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
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
  measureExceptionSource,
  retryTimedOutExceptionQuery,
  resolveAbnormalQueryContext
} = require('../abnormal-query-support');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
assert.strictEqual(EXCEPTION_QUERY_TIMEOUT_MS, 1000, '单次异常来源请求必须在1秒后超时');
assert.strictEqual(EXCEPTION_QUERY_MAX_RETRIES, 3, '异常来源超时后必须重试3次');
assert.strictEqual(EXCEPTION_QUERY_RETRY_DELAY_MS, 200, '异常来源重试间隔必须为200毫秒');
assert.match(mainSource, /return retryTimedOutExceptionQuery\(\(\) => fetchJsonWithTimeout\(merchantSession\.fetch\.bind\(merchantSession\), url/,
  '两个异常查询来源必须分别使用1秒超时和本机重试');
assert.strictEqual(
  (mainSource.match(/return retryTimedOutExceptionQuery\(\(\) => fetchJsonWithTimeout\(merchantSession\.fetch\.bind\(merchantSession\), url/g) || []).length,
  2,
  'billexception 与 soExceptionCentre 都必须独立启用超时重试'
);
assert.strictEqual(
  (mainSource.match(/measureExceptionSource\('(billexception|soExceptionCentre)'/g) || []).length,
  2,
  '两路异常来源必须独立记录安全耗时'
);
assert.strictEqual(
  (mainSource.match(/handlerAction: item\.handlerAction \|\| ''/g) || []).length,
  2,
  '两个来源只能透传真实上游 handlerAction，缺失时必须为空字符串'
);
assert.match(mainSource, /\{ requireAllSources: true, contextMode: 'remote' \}/,
  '远程查询必须强制全部来源成功并使用当前本机事业部上下文');
assert.doesNotMatch(mainSource, /查询异常订单:', JSON\.stringify\(\{ sellerNo/,
  '异常查询日志不得写入本机 sellerNo');

function createContextState(overrides = {}) {
  return {
    currentUsername: 'merchant-user',
    orderCommandAccountIdentity: 'merchant-user',
    activeMerchantAccountId: 'merchant-account-1',
    csrfToken: 'local-csrf-value',
    sellerId: '20000000001',
    merchantAccounts: [{ id: 'merchant-account-1', username: 'merchant-user' }],
    userData: {
      selectedDeptId: 'CBU0001',
      selectedDeptName: '第一事业部',
      deptPairs: [
        {
          deptNo: 'CBU0001',
          deptName: '第一事业部',
          sellerId: '20000000001',
          sellerName: '测试商家'
        },
        {
          deptNo: 'CBU0002',
          deptName: '第二事业部',
          sellerId: '20000000001',
          sellerName: '测试商家'
        }
      ]
    },
    ...overrides
  };
}

const remoteContext = resolveAbnormalQueryContext(createContextState(), {
  requireSelectedDepartment: true
});
assert.strictEqual(remoteContext.billExceptionDeptValue, 'CBU0001');
assert.strictEqual(remoteContext.contextDeptNo, 'CBU0001');
assert.strictEqual(remoteContext.sellerNo, 'CCP0020000000001');

const manualContext = resolveAbnormalQueryContext(createContextState(), {
  requestedDeptNo: 'CBU0002',
  requestedMerchantName: '测试商家'
});
assert.strictEqual(manualContext.billExceptionDeptValue, 'CBU0002');
assert.strictEqual(manualContext.contextDeptNo, 'CBU0002');

assert.throws(
  () => resolveAbnormalQueryContext(createContextState({ orderCommandAccountIdentity: 'different-user' }), {
    requireSelectedDepartment: true
  }),
  error => error.code === CONTEXT_ERROR_CODE && !error.message.includes('different-user')
);
assert.throws(
  () => resolveAbnormalQueryContext(createContextState(), {
    requestedDeptNo: 'CBU9999'
  }),
  error => error.code === CONTEXT_ERROR_CODE
);
assert.throws(
  () => resolveAbnormalQueryContext(createContextState(), {
    requestedDeptNo: 'CBU0001',
    requestedMerchantName: '不匹配商家'
  }),
  error => error.code === CONTEXT_ERROR_CODE && !error.message.includes('不匹配商家')
);

assert.doesNotThrow(() => assertRequiredExceptionSources([
  { status: 'fulfilled', value: { aaData: [] } },
  { status: 'fulfilled', value: { aaData: [] } }
], true));
assert.throws(() => assertRequiredExceptionSources([
  { status: 'fulfilled', value: { aaData: [] } },
  { status: 'rejected', reason: new Error('timeout') }
], true), error => error.code === 'exception_query_incomplete');
assert.throws(() => assertRequiredExceptionSources([
  { status: 'fulfilled', value: { aaData: [] } },
  { status: 'rejected', reason: Object.assign(new Error('hidden upstream detail'), {
    code: MERCHANT_SESSION_EXPIRED_CODE
  }) }
], true), error => error.code === MERCHANT_SESSION_EXPIRED_CODE &&
  error.message === MERCHANT_SESSION_EXPIRED_MESSAGE &&
  !error.message.includes('hidden upstream detail'));
assert.throws(() => assertRequiredExceptionSources([
  { status: 'fulfilled', value: { aaData: [] } },
  { status: 'rejected', reason: Object.assign(new Error('hidden timeout detail'), {
    code: TIMEOUT_ERROR_CODE
  }) }
], true), error => error.code === TIMEOUT_ERROR_CODE &&
  error.message === EXCEPTION_QUERY_TIMEOUT_MESSAGE &&
  !error.message.includes('hidden timeout detail'));

async function assertPendingFetchTimesOut() {
  let timeoutCallback;
  let clearCount = 0;
  let receivedSignal = null;
  const pending = fetchJsonWithTimeout((url, options) => {
    receivedSignal = options.signal;
    return new Promise(() => {});
  }, 'https://example.invalid/query', {}, {
    timeoutMs: 10,
    setTimer(callback) {
      timeoutCallback = callback;
      return 101;
    },
    clearTimer(id) {
      assert.strictEqual(id, 101);
      clearCount += 1;
    }
  });
  await Promise.resolve();
  timeoutCallback();
  await assert.rejects(pending, error => error.code === TIMEOUT_ERROR_CODE);
  assert.strictEqual(receivedSignal.aborted, true);
  assert.strictEqual(clearCount, 1);
}

async function assertPendingBodyTimesOut() {
  let timeoutCallback;
  let clearCount = 0;
  const pending = fetchJsonWithTimeout(async () => ({
    text: () => new Promise(() => {})
  }), 'https://example.invalid/query', {}, {
    timeoutMs: 10,
    setTimer(callback) {
      timeoutCallback = callback;
      return 202;
    },
    clearTimer(id) {
      assert.strictEqual(id, 202);
      clearCount += 1;
    }
  });
  await Promise.resolve();
  await Promise.resolve();
  timeoutCallback();
  await assert.rejects(pending, error => error.code === TIMEOUT_ERROR_CODE);
  assert.strictEqual(clearCount, 1);
}

async function assertSuccessfulFetchClearsTimer() {
  let clearCount = 0;
  const value = await fetchJsonWithTimeout(async () => ({
    text: async () => '{"aaData":[]}'
  }), 'https://example.invalid/query', {}, {
    setTimer() { return 303; },
    clearTimer(id) {
      assert.strictEqual(id, 303);
      clearCount += 1;
    }
  });
  assert.deepStrictEqual(value, { aaData: [] });
  assert.strictEqual(clearCount, 1);
}

async function assertFailedFetchClearsTimer() {
  let clearCount = 0;
  await assert.rejects(fetchJsonWithTimeout(async () => {
    throw new Error('network unavailable');
  }, 'https://example.invalid/query', {}, {
    setTimer() { return 404; },
    clearTimer(id) {
      assert.strictEqual(id, 404);
      clearCount += 1;
    }
  }), /network unavailable/);
  assert.strictEqual(clearCount, 1);
}

async function assertMerchantSessionFailuresAreClassified() {
  for (const status of [401, 403]) {
    await assert.rejects(fetchJsonWithTimeout(async () => ({
      status,
      text: async () => ''
    }), 'https://example.invalid/query'), error =>
      error.code === MERCHANT_SESSION_EXPIRED_CODE &&
      error.message === MERCHANT_SESSION_EXPIRED_MESSAGE);
  }

  await assert.rejects(fetchJsonWithTimeout(async () => ({
    status: 200,
    redirected: true,
    url: 'https://passport.jd.com/login',
    text: async () => { throw new Error('body must not be read'); }
  }), 'https://example.invalid/query'), error => error.code === MERCHANT_SESSION_EXPIRED_CODE);

  await assert.rejects(fetchJsonWithTimeout(async () => ({
    status: 200,
    text: async () => '<!doctype html><html><form id="loginForm"><input name="password"></form></html>'
  }), 'https://example.invalid/query'), error => error.code === MERCHANT_SESSION_EXPIRED_CODE);

  await assert.rejects(fetchJsonWithTimeout(async () => ({
    status: 200,
    text: async () => JSON.stringify({ code: 'SESSION_EXPIRED', message: 'session ended' })
  }), 'https://example.invalid/query'), error => error.code === MERCHANT_SESSION_EXPIRED_CODE);
}

async function assertGeneralFailuresAreNotSessionExpiry() {
  await assert.rejects(fetchJsonWithTimeout(async () => ({
    status: 200,
    text: async () => '<html><body>upstream gateway error</body></html>'
  }), 'https://example.invalid/query'), error =>
    error.code !== MERCHANT_SESSION_EXPIRED_CODE && error instanceof SyntaxError);

  await assert.rejects(fetchJsonWithTimeout(async () => ({
    status: 200,
    text: async () => '{bad-json'
  }), 'https://example.invalid/query'), error =>
    error.code !== MERCHANT_SESSION_EXPIRED_CODE && error instanceof SyntaxError);

  await assert.rejects(fetchJsonWithTimeout(async () => ({
    status: 500,
    text: async () => JSON.stringify({ code: 500, message: 'service unavailable' })
  }), 'https://example.invalid/query'), error =>
    error.code === 'exception_query_http_error');
}

async function assertOneSuccessfulSourceCannotHideTimeout() {
  let timeoutCallback;
  const slowSource = fetchJsonWithTimeout(() => new Promise(() => {}),
    'https://example.invalid/query', {}, {
      setTimer(callback) {
        timeoutCallback = callback;
        return 505;
      },
      clearTimer() {}
    });
  await Promise.resolve();
  timeoutCallback();
  const settled = await Promise.allSettled([
    Promise.resolve({ aaData: [] }),
    slowSource
  ]);
  assert.throws(
    () => assertRequiredExceptionSources(settled, true),
    error => error.code === TIMEOUT_ERROR_CODE &&
      error.message === EXCEPTION_QUERY_TIMEOUT_MESSAGE
  );
}

async function assertSourceMeasurementIsSafeAndDeterministic() {
  const measurements = [];
  const ticks = [1000, 1123];
  const value = await measureExceptionSource('billexception', async () => ({
    aaData: [{ internal_id: 'must-not-appear-in-measurement' }]
  }), {
    now: () => ticks.shift(),
    onComplete: measurement => measurements.push(measurement)
  });
  assert.strictEqual(value.aaData.length, 1);
  assert.deepStrictEqual(measurements, [{
    source: 'billexception',
    duration_ms: 123,
    outcome: 'succeeded',
    count: 1
  }]);
  assert.strictEqual(JSON.stringify(measurements).includes('internal_id'), false);
}

async function assertOnlyTimeoutsAreRetried() {
  const timeout = () => Object.assign(new Error('timed out'), { code: TIMEOUT_ERROR_CODE });
  const retryDelays = [];
  let attempts = 0;
  const recovered = await retryTimedOutExceptionQuery(async attempt => {
    attempts = attempt;
    if (attempt < 4) throw timeout();
    return { aaData: [] };
  }, {
    sleep: async delayMs => retryDelays.push(delayMs)
  });
  assert.strictEqual(recovered.aaData.length, 0, '正常0条响应不能触发额外重试');
  assert.strictEqual(attempts, 4, '首次超时后必须正好重试3次');
  assert.deepStrictEqual(retryDelays, [200, 200, 200]);

  let exhaustedAttempts = 0;
  await assert.rejects(retryTimedOutExceptionQuery(async () => {
    exhaustedAttempts += 1;
    throw timeout();
  }, { sleep: async () => {} }), error => error.code === TIMEOUT_ERROR_CODE);
  assert.strictEqual(exhaustedAttempts, 4, '连续超时最多只能请求4次（首次加3次重试）');

  let sessionAttempts = 0;
  await assert.rejects(retryTimedOutExceptionQuery(async () => {
    sessionAttempts += 1;
    throw Object.assign(new Error('expired'), { code: MERCHANT_SESSION_EXPIRED_CODE });
  }, { sleep: async () => { throw new Error('Cookie失效不应等待重试'); } }),
  error => error.code === MERCHANT_SESSION_EXPIRED_CODE);
  assert.strictEqual(sessionAttempts, 1, 'Cookie失效必须立即返回，不能重试');

  let ordinaryAttempts = 0;
  await assert.rejects(retryTimedOutExceptionQuery(async () => {
    ordinaryAttempts += 1;
    throw new Error('bad json');
  }, { sleep: async () => { throw new Error('普通失败不应等待重试'); } }), /bad json/);
  assert.strictEqual(ordinaryAttempts, 1, '普通接口失败不能伪装成超时重试');
}

(async () => {
  await assertPendingFetchTimesOut();
  await assertPendingBodyTimesOut();
  await assertSuccessfulFetchClearsTimer();
  await assertFailedFetchClearsTimer();
  await assertMerchantSessionFailuresAreClassified();
  await assertGeneralFailuresAreNotSessionExpiry();
  await assertOneSuccessfulSourceCannotHideTimeout();
  await assertSourceMeasurementIsSafeAndDeterministic();
  await assertOnlyTimeoutsAreRetried();
  console.log('abnormal-query-support tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
