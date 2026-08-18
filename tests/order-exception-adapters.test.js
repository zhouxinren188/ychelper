'use strict';

const assert = require('assert');
const { OrderCommandExecutor } = require('../order-command-executor');
const {
  createExceptionOrderAdapters,
  registerExceptionOrderAdapters,
  validateCheckParams,
  validateResolveParams
} = require('../order-exception-adapters');
const { ExceptionSnapshotStore } = require('../order-exception-snapshot-store');

const MACHINE_CODE = 'YC-7F3K-92MX';
const ORDER_NO = '3588401003348721';
const NOW = Date.parse('2026-08-12T12:00:00.000Z');

function makeTask(command, suffix, overrides = {}) {
  const isWrite = command === 'exception.order.resolve';
  return {
    protocol_version: '1.0',
    task_id: `task-${suffix}`,
    trace_id: `workflow-${suffix}`,
    command,
    order_id: ORDER_NO,
    idempotency_key: `idem-${suffix}`,
    created_at: new Date(NOW - 1000).toISOString(),
    expires_at: new Date(NOW + (isWrite ? 60_000 : 5 * 60_000)).toISOString(),
    requested_by: {
      actor_id: 'sub-account-001',
      actor_type: 'user',
      display_name: '子账号测试用户'
    },
    target: { machine_code: MACHINE_CODE },
    ...(isWrite ? {
      confirmation: {
        confirmed: true,
        confirmed_at: new Date(NOW - 500).toISOString(),
        actor_id: 'sub-account-001',
        action: command
      }
    } : {}),
    params: isWrite
      ? { order_no: ORDER_NO, order_year: 2026, exception_snapshot_ref: 'exsnap-00000000000000000000000000000001' }
      : { order_no: ORDER_NO, order_year: 2026 },
    ...overrides
  };
}

function createHarness(overrides = {}) {
  let executorState = null;
  let snapshotState = null;
  let randomCounter = 1;
  const snapshotStore = new ExceptionSnapshotStore({
    machineCode: MACHINE_CODE,
    now: () => NOW,
    randomBytes: size => {
      const buffer = Buffer.alloc(size);
      buffer.writeUInt32BE(randomCounter++, size - 4);
      return buffer;
    },
    loadState: () => snapshotState,
    saveState: next => {
      snapshotState = JSON.parse(JSON.stringify(next));
      return true;
    }
  });
  const baseServices = {
    queryExceptionRecords: async () => ({ records: [], queried_at: '2026-08-12T12:00:00.000Z' }),
    resolveExceptionRecords: async () => ({ all_succeeded: true, processed_count: 0 }),
    ...overrides
  };
  const services = {
    ...baseServices,
    createExceptionSnapshot: args => snapshotStore.create(args),
    getExceptionSnapshot: (ref, options) => snapshotStore.get(ref, options),
    assertExceptionSnapshotRecords: (ref, records, options) => {
      return snapshotStore.assertRecordsMatch(ref, records, options);
    },
    claimExceptionSnapshot: (ref, options) => snapshotStore.claim(ref, options)
  };
  const executor = new OrderCommandExecutor({
    machineCode: MACHINE_CODE,
    now: () => NOW,
    loadState: () => executorState,
    saveState: next => { executorState = JSON.parse(JSON.stringify(next)); },
    logger: { error() {} }
  });
  registerExceptionOrderAdapters(executor, services);
  return { executor, services, snapshotStore };
}

assert.deepStrictEqual(validateCheckParams({ order_no: ORDER_NO, order_year: 2026 }), { valid: true });
assert.strictEqual(validateCheckParams({}).valid, false);
assert.strictEqual(validateCheckParams({ platform_order_no: 'remote-value' }).valid, false);
assert.strictEqual(validateResolveParams({}).valid, false);
assert.strictEqual(validateResolveParams({ exception_snapshot_ref: 'bad' }).valid, false);
assert.strictEqual(validateResolveParams({
  order_no: ORDER_NO,
  order_year: 2026,
  exception_snapshot_ref: 'exsnap-00000000000000000000000000000001'
}).valid, true);
assert.throws(() => createExceptionOrderAdapters({}), /queryExceptionRecords/);

(async () => {
  const queriedLocators = [];
  const checkHarness = createHarness({
    queryExceptionRecords: async locator => {
      queriedLocators.push(locator);
      return {
      records: [
        {
          source: 'billexception',
          internal_id: 'must-not-leak',
          exception_type: '联系电话 13812345678',
          exception_description: '详情 https://internal.example/order/123456789',
          handler_action: '请拨打 13812345678 处理'
        },
        { source: 'soExceptionCentre', internal_id: 'must-not-leak' }
      ],
      queried_at: '2026-08-12T12:00:00.000Z'
      };
    }
  });
  const checkTask = makeTask('exception.order.check', 'check');
  const checkResult = await checkHarness.executor.executeTask(checkTask);
  assert.strictEqual(checkResult.status, 'succeeded');
  assert.strictEqual(checkResult.reason, 'query_completed');
  assert.strictEqual(checkResult.message, '查询到异常订单');
  assert.strictEqual(checkResult.result.state, 'exception_found');
  assert.strictEqual(checkResult.result.exception_count, 2);
  assert.match(checkResult.result.exception_snapshot_ref, /^exsnap-[a-f0-9]{32}$/);
  assert.strictEqual(checkResult.result.exceptions.length, 2);
  assert.deepStrictEqual(Object.keys(checkResult.result.exceptions[0]).sort(), [
    'exception_type_masked',
    'reason_masked',
    'solution_masked',
    'source'
  ]);
  assert.strictEqual(checkResult.result.exceptions[0].source, 'billexception');
  assert.strictEqual(checkResult.result.exceptions[0].exception_type_masked, '联系电话 138****5678');
  assert.strictEqual(checkResult.result.exceptions[0].reason_masked, '详情 [链接已隐藏]');
  assert.strictEqual(checkResult.result.exceptions[0].solution_masked.includes('138****5678'), true);
  assert.strictEqual(checkResult.result.exceptions[1].solution_masked, '');
  assert.deepStrictEqual(Object.keys(checkResult.result).sort(), [
    'exception_count',
    'exception_snapshot_ref',
    'exceptions',
    'queried_at',
    'state'
  ]);
  assert.strictEqual(JSON.stringify(checkResult).includes('must-not-leak'), false);
  assert.deepStrictEqual(queriedLocators, [{ platform_order_no: ORDER_NO, order_year: 2026 }]);

  for (const source of ['billexception', 'soExceptionCentre']) {
    const singleSourceHarness = createHarness({
      queryExceptionRecords: async () => ({
        records: [{
          source,
          internal_id: 'single-source-local-only',
          exception_description: '真实异常原因',
          handler_action: source === 'billexception' ? '真实处理方案' : ''
        }],
        queried_at: '2026-08-12T12:00:00.000Z'
      })
    });
    const singleSource = await singleSourceHarness.executor.executeTask(
      makeTask('exception.order.check', `single-${source}`)
    );
    assert.strictEqual(singleSource.status, 'succeeded');
    assert.strictEqual(singleSource.message, '查询到异常订单');
    assert.strictEqual(singleSource.result.state, 'exception_found');
    assert.strictEqual(singleSource.result.exception_count, 1);
    assert.strictEqual(singleSource.result.exceptions[0].source, source);
    assert.strictEqual(singleSource.result.exceptions[0].reason_masked, '真实异常原因');
    assert.strictEqual(
      singleSource.result.exceptions[0].solution_masked,
      source === 'billexception' ? '真实处理方案' : ''
    );
  }

  const sensitiveSolutionHarness = createHarness({
    queryExceptionRecords: async () => ({
      records: [{
        source: 'billexception',
        internal_id: 'sensitive-solution-local-only',
        exception_description: '普通异常原因',
        handler_action: 'cookie=must-not-leak'
      }],
      queried_at: '2026-08-12T12:00:00.000Z'
    })
  });
  const sensitiveSolution = await sensitiveSolutionHarness.executor.executeTask(
    makeTask('exception.order.check', 'sensitive-solution')
  );
  assert.strictEqual(sensitiveSolution.result.exceptions[0].solution_masked, '[REDACTED]');
  assert.strictEqual(JSON.stringify(sensitiveSolution).includes('must-not-leak'), false);

  const noExceptionHarness = createHarness();
  const noException = await noExceptionHarness.executor.executeTask(
    makeTask('exception.order.check', 'none')
  );
  assert.strictEqual(noException.status, 'succeeded');
  assert.strictEqual(noException.reason, 'query_completed');
  assert.strictEqual(noException.message, '暂无异常订单');
  assert.deepStrictEqual({ ...noException.result }, {
    state: 'no_exception',
    exception_snapshot_ref: '',
    exception_count: 0,
    queried_at: '2026-08-12T12:00:00.000Z',
    exceptions: []
  });

  const expiredHarness = createHarness({
    queryExceptionRecords: async () => {
      const error = new Error('upstream detail must not escape');
      error.code = 'merchant_session_expired';
      throw error;
    }
  });
  const expired = await expiredHarness.executor.executeTask(
    makeTask('exception.order.check', 'expired')
  );
  assert.strictEqual(expired.status, 'failed');
  assert.strictEqual(expired.reason, 'merchant_session_expired');
  assert.strictEqual(expired.message, '云仓助手商家登录已失效，请在绑定机器码的云仓助手重新登录后再试');
  assert.strictEqual(JSON.stringify(expired).includes('upstream detail'), false);

  const generalFailureHarness = createHarness({
    queryExceptionRecords: async () => { throw new SyntaxError('bad upstream JSON'); }
  });
  const generalFailure = await generalFailureHarness.executor.executeTask(
    makeTask('exception.order.check', 'bad-json')
  );
  assert.strictEqual(generalFailure.status, 'failed');
  assert.strictEqual(generalFailure.reason, 'execution_failed');
  assert.notStrictEqual(generalFailure.reason, 'merchant_session_expired');

  let pending = true;
  let resolveCalls = 0;
  let queryCalls = 0;
  const resolveHarness = createHarness({
    queryExceptionRecords: async () => {
      queryCalls++;
      return {
        records: pending ? [{ source: 'billexception', internal_id: 'local-only' }] : [],
        queried_at: '2026-08-12T12:00:00.000Z'
      };
    },
    resolveExceptionRecords: async (locator, records) => {
      resolveCalls++;
      assert.strictEqual(records[0].internal_id, 'local-only');
      pending = false;
      return { all_succeeded: true, processed_count: 1 };
    }
  });
  const resolveCheckTask = makeTask('exception.order.check', 'resolve');
  const resolveCheck = await resolveHarness.executor.executeTask(resolveCheckTask);
  const resolveTask = makeTask('exception.order.resolve', 'resolve', {
    idempotency_key: 'idem-resolve-write',
    params: { order_no: ORDER_NO, order_year: 2026, exception_snapshot_ref: resolveCheck.result.exception_snapshot_ref }
  });
  const resolveResult = await resolveHarness.executor.executeTask(resolveTask);
  assert.strictEqual(resolveResult.status, 'succeeded');
  assert.strictEqual(resolveResult.verification.expected_status, 'waiting_arrival');
  assert.strictEqual(resolveResult.verification.observed_status, 'waiting_arrival');
  assert.strictEqual(resolveResult.verification.confirmed, true);
  assert.strictEqual(resolveCalls, 1);
  assert.strictEqual(queryCalls, 4, '查询快照后，写命令必须继续执行 preflight、写前最终复验和写后复验');
  assert.strictEqual(JSON.stringify(resolveResult).includes('local-only'), false);

  const reusedSnapshot = await resolveHarness.executor.executeTask(makeTask('exception.order.resolve', 'reuse', {
    order_id: resolveCheckTask.order_id,
    params: { order_no: ORDER_NO, order_year: 2026, exception_snapshot_ref: resolveCheck.result.exception_snapshot_ref }
  }));
  assert.strictEqual(reusedSnapshot.status, 'refused');
  assert.strictEqual(reusedSnapshot.reason, 'precondition_not_met');

  const unavailableParams = await checkHarness.executor.executeTask(makeTask('exception.order.check', 'params', {
    params: { platform_order_no: 'remote-order-number' }
  }));
  assert.strictEqual(unavailableParams.status, 'refused');
  assert.strictEqual(unavailableParams.reason, 'adapter_params_invalid');

  let changedCall = 0;
  const changedHarness = createHarness({
    queryExceptionRecords: async () => {
      changedCall++;
      return {
        records: [{ source: 'soExceptionCentre', internal_id: `local-${changedCall}` }],
        queried_at: '2026-08-12T12:00:00.000Z'
      };
    }
  });
  const changedCheck = await changedHarness.executor.executeTask(makeTask('exception.order.check', 'changed'));
  const changed = await changedHarness.executor.executeTask(makeTask('exception.order.resolve', 'changed', {
    idempotency_key: 'idem-changed-write',
    params: { order_no: ORDER_NO, order_year: 2026, exception_snapshot_ref: changedCheck.result.exception_snapshot_ref }
  }));
  assert.strictEqual(changed.status, 'refused');
  assert.strictEqual(changed.reason, 'precondition_not_met');
  assert.strictEqual(changed.delivery.executed, false);

  const locatorHarness = createHarness({
    queryExceptionRecords: async () => ({
      records: [{ source: 'billexception', internal_id: 'locator-local' }],
      queried_at: '2026-08-12T12:00:00.000Z'
    })
  });
  const locatorCheck = await locatorHarness.executor.executeTask(makeTask('exception.order.check', 'locator'));
  const locatorResolve = await locatorHarness.executor.executeTask(makeTask('exception.order.resolve', 'locator', {
    idempotency_key: 'idem-locator-write',
    params: { order_no: ORDER_NO, order_year: 2025, exception_snapshot_ref: locatorCheck.result.exception_snapshot_ref }
  }));
  assert.strictEqual(locatorResolve.status, 'refused');
  assert.strictEqual(locatorResolve.reason, 'precondition_not_met');
  assert.strictEqual(locatorResolve.result.reason, 'order_locator_changed');

  let partialPending = true;
  const partialHarness = createHarness({
    queryExceptionRecords: async () => ({
      records: partialPending ? [{ source: 'soExceptionCentre', internal_id: 'partial-local' }] : [],
      queried_at: '2026-08-12T12:00:00.000Z'
    }),
    resolveExceptionRecords: async () => ({
      all_succeeded: false,
      processed_count: 1,
      message: '仅部分异常处理成功'
    })
  });
  const partialCheck = await partialHarness.executor.executeTask(makeTask('exception.order.check', 'partial'));
  const partial = await partialHarness.executor.executeTask(makeTask('exception.order.resolve', 'partial', {
    idempotency_key: 'idem-partial-write',
    params: { order_no: ORDER_NO, order_year: 2026, exception_snapshot_ref: partialCheck.result.exception_snapshot_ref }
  }));
  assert.strictEqual(partial.status, 'review_required');
  assert.strictEqual(partial.reason, 'execution_result_unknown');
  assert.strictEqual(partial.delivery.executed, true);

  const capabilities = resolveHarness.executor.getCapabilities();
  assert.strictEqual(capabilities.find(item => item.command === 'exception.order.check').enabled, true);
  assert.strictEqual(capabilities.find(item => item.command === 'exception.order.resolve').enabled, true);
  assert.strictEqual(capabilities.filter(item => item.enabled).length, 2);

  console.log('异常订单适配器测试通过：不透明订单映射、持久快照引用、集合防漂移、三次写复验和部分成功转人工复核均已覆盖');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
