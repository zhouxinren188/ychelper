'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  CONTEXT_ERROR_CODE,
  TIMEOUT_ERROR_CODE,
  assertRequiredExceptionSources,
  fetchJsonWithTimeout,
  resolveAbnormalQueryContext
} = require('../abnormal-query-support');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
assert.match(mainSource, /return fetchJsonWithTimeout\(merchantSession\.fetch\.bind\(merchantSession\), url/,
  '两个异常查询来源必须通过统一的完整响应超时读取');
assert.strictEqual(
  (mainSource.match(/return fetchJsonWithTimeout\(merchantSession\.fetch\.bind\(merchantSession\), url/g) || []).length,
  2,
  'billexception 与 soExceptionCentre 都必须启用超时'
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
    error => error.code === 'exception_query_incomplete'
  );
}

(async () => {
  await assertPendingFetchTimesOut();
  await assertPendingBodyTimesOut();
  await assertSuccessfulFetchClearsTimer();
  await assertFailedFetchClearsTimer();
  await assertOneSuccessfulSourceCannotHideTimeout();
  console.log('abnormal-query-support tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
