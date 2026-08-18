'use strict';

const assert = require('assert');
const { OrderCommandExecutor } = require('../order-command-executor');
const {
  PROTOCOL_VERSION,
  OrderCommandProtocolError,
  validateTaskEnvelope
} = require('../order-command-protocol');

const NOW = Date.parse('2026-08-12T12:00:00.000Z');
const MACHINE_CODE = 'YC-7F3K-92MX';

function createPersistence(initialState = null) {
  let persisted = initialState;
  return {
    loadState: () => persisted,
    saveState: state => { persisted = JSON.parse(JSON.stringify(state)); },
    snapshot: () => JSON.parse(JSON.stringify(persisted))
  };
}

function createExecutor(persistence, overrides = {}) {
  return new OrderCommandExecutor({
    machineCode: MACHINE_CODE,
    loadState: persistence.loadState,
    saveState: persistence.saveState,
    now: () => NOW,
    logger: { error() {} },
    ...overrides
  });
}

function makeTask(command, overrides = {}) {
  const isWrite = ['exception.order.resolve', 'warehouse.order.print', 'warehouse.order.outbound'].includes(command);
  const task = {
    protocol_version: PROTOCOL_VERSION,
    task_id: overrides.task_id || `task-${command.replace(/\./g, '-')}`,
    trace_id: overrides.trace_id || 'workflow-test-001',
    command,
    order_id: overrides.order_id || 'order-ref-10001',
    idempotency_key: overrides.idempotency_key || `idem-${command.replace(/\./g, '-')}`,
    created_at: new Date(NOW - 1000).toISOString(),
    expires_at: new Date(NOW + 60 * 1000).toISOString(),
    requested_by: {
      actor_id: 'user-001',
      actor_type: 'user',
      display_name: '测试用户'
    },
    target: { machine_code: MACHINE_CODE },
    params: overrides.params || {}
  };
  if (isWrite) {
    task.confirmation = {
      confirmed: true,
      confirmed_at: new Date(NOW - 500).toISOString(),
      actor_id: 'user-001',
      action: command
    };
  }
  return { ...task, ...overrides };
}

function expectProtocolError(task, code) {
  assert.throws(
    () => validateTaskEnvelope(task, { nowMs: NOW, expectedMachineCode: MACHINE_CODE }),
    error => error instanceof OrderCommandProtocolError && error.code === code
  );
}

async function run() {
  expectProtocolError(makeTask('system.shell.run'), 'command_not_allowed');
  expectProtocolError(
    makeTask('exception.order.check', { params: { requestUrl: 'https://example.invalid' } }),
    'dangerous_params'
  );
  expectProtocolError(
    makeTask('exception.order.check', { params: { modulePath: './unsafe.js' } }),
    'dangerous_params'
  );
  expectProtocolError(
    makeTask('exception.order.check', { params: { apiKey: 'secret-value' } }),
    'sensitive_params'
  );
  expectProtocolError(
    makeTask('exception.order.check', { params: { note: 'Authorization: Bearer secret' } }),
    'sensitive_params'
  );
  expectProtocolError(
    makeTask('exception.order.check', { params: JSON.parse('{"__proto__":{"polluted":true}}') }),
    'dangerous_params'
  );
  expectProtocolError(
    makeTask('exception.order.check', { expires_at: new Date(NOW - 1).toISOString() }),
    'task_expired'
  );
  expectProtocolError(
    makeTask('exception.order.check', {
      created_at: new Date(NOW - 1000).toISOString(),
      expires_at: new Date(NOW + 10 * 60 * 1000).toISOString()
    }),
    'invalid_ttl'
  );
  expectProtocolError(makeTask('exception.order.check', { task_id: 'constructor' }), 'invalid_identifier');
  expectProtocolError(makeTask('exception.order.check', { target: undefined }), 'machine_code_target_required');
  expectProtocolError(
    makeTask('exception.order.check', { target: { machine_code: MACHINE_CODE, executor_instance_id: 'old' } }),
    'unknown_field'
  );
  expectProtocolError(
    makeTask('exception.order.check', { target: { device_id: 'old-device' } }),
    'unknown_field'
  );

  assert.throws(
    () => createExecutor(createPersistence({ version: 2, receipts: null, locks: {}, audit: [] })),
    /安全停用/
  );

  const mismatchExecutor = createExecutor(createPersistence());
  const mismatch = await mismatchExecutor.executeTask(makeTask('exception.order.check', {
    target: { machine_code: 'YC-2345-6789' }
  }));
  assert.strictEqual(mismatch.status, 'refused');
  assert.strictEqual(mismatch.reason, 'machine_code_mismatch');
  assert.strictEqual(mismatch.delivery.received, false);

  const unavailablePersistence = createPersistence();
  const unavailableExecutor = createExecutor(unavailablePersistence);
  assert.strictEqual(unavailableExecutor.getCapabilities().length, 5);
  assert.strictEqual(unavailableExecutor.getCapabilities().every(item => item.enabled === false), true);
  const unavailableTask = makeTask('exception.order.check');
  const unavailable = await unavailableExecutor.executeTask(unavailableTask);
  assert.strictEqual(unavailable.status, 'refused');
  assert.strictEqual(unavailable.reason, 'capability_unavailable');
  assert.strictEqual(unavailable.trace_id, unavailableTask.trace_id);
  assert.strictEqual(unavailable.idempotency_key, unavailableTask.idempotency_key);
  assert.strictEqual(unavailable.delivery.executed, false);
  assert.strictEqual(unavailable.delivery.replayed, false);
  assert.match(unavailable.delivery.receipt_id, /^receipt-[a-f0-9]{24}$/);
  assert.deepStrictEqual(unavailable.executor, { machine_code: MACHINE_CODE });
  const unavailableDuplicate = await unavailableExecutor.executeTask(unavailableTask);
  assert.strictEqual(unavailableDuplicate.duplicate, true);
  assert.strictEqual(unavailableDuplicate.delivery.replayed, true);
  assert.strictEqual(unavailableDuplicate.delivery.executed, false);
  assert.strictEqual(unavailableDuplicate.delivery.receipt_id, unavailable.delivery.receipt_id);

  const readPersistence = createPersistence();
  const readExecutor = createExecutor(readPersistence);
  let readExecutions = 0;
  readExecutor.registerAdapter('exception.order.check', {
    validateParams: params => ({ valid: Object.keys(params).length === 0, message: '测试参数必须为空' }),
    async execute() {
      readExecutions++;
      return {
        is_exception: true,
        cookie: 'pt_key=should-not-leak',
        nested: { accessToken: 'also-secret' },
        prototype_probe: JSON.parse('{"__proto__":{"polluted":true}}')
      };
    }
  });
  const readTask = makeTask('exception.order.check');
  const readResult = await readExecutor.executeTask(readTask);
  assert.strictEqual(readResult.status, 'succeeded');
  assert.strictEqual(readResult.delivery.business_confirmed, true);
  assert.strictEqual(readResult.result.cookie, '[REDACTED]');
  assert.strictEqual(readResult.result.nested.accessToken, '[REDACTED]');
  assert.strictEqual(readResult.result.prototype_probe.__proto__, '[REDACTED]');
  assert.strictEqual(Object.prototype.polluted, undefined);
  const readDuplicate = await readExecutor.executeTask(readTask);
  assert.strictEqual(readDuplicate.delivery.replayed, true);
  assert.strictEqual(readDuplicate.delivery.executed, true);
  assert.strictEqual(readExecutions, 1);

  const foundExecutor = createExecutor(createPersistence());
  foundExecutor.registerAdapter('exception.order.check', {
    validateParams: () => ({ valid: true }),
    execute: async () => ({ state: 'exception_found', exception_count: 1 })
  });
  const foundResult = await foundExecutor.executeTask(makeTask('exception.order.check'));
  assert.strictEqual(foundResult.status, 'succeeded');
  assert.strictEqual(foundResult.reason, 'query_completed');
  assert.strictEqual(foundResult.message, '查询到异常订单');

  const noExceptionExecutor = createExecutor(createPersistence());
  noExceptionExecutor.registerAdapter('exception.order.check', {
    validateParams: () => ({ valid: true }),
    execute: async () => ({ state: 'no_exception', exception_count: 0 })
  });
  const noExceptionResult = await noExceptionExecutor.executeTask(makeTask('exception.order.check'));
  assert.strictEqual(noExceptionResult.status, 'succeeded');
  assert.strictEqual(noExceptionResult.reason, 'query_completed');
  assert.strictEqual(noExceptionResult.message, '暂无异常订单');

  const expiredSessionExecutor = createExecutor(createPersistence());
  expiredSessionExecutor.registerAdapter('exception.order.check', {
    validateParams: () => ({ valid: true }),
    execute: async () => {
      const error = new Error('sensitive upstream detail');
      error.code = 'merchant_session_expired';
      throw error;
    }
  });
  const expiredSessionResult = await expiredSessionExecutor.executeTask(makeTask('exception.order.check'));
  assert.strictEqual(expiredSessionResult.status, 'failed');
  assert.strictEqual(expiredSessionResult.reason, 'merchant_session_expired');
  assert.strictEqual(
    expiredSessionResult.message,
    '云仓助手商家登录已失效，请在绑定机器码的云仓助手重新登录后再试'
  );
  assert.strictEqual(JSON.stringify(expiredSessionResult).includes('sensitive upstream detail'), false);

  const timedOutExecutor = createExecutor(createPersistence());
  timedOutExecutor.registerAdapter('exception.order.check', {
    validateParams: () => ({ valid: true }),
    execute: async () => {
      const error = new Error('sensitive timeout detail');
      error.code = 'exception_query_timeout';
      throw error;
    }
  });
  const timedOutResult = await timedOutExecutor.executeTask(makeTask('exception.order.check'));
  assert.strictEqual(timedOutResult.status, 'failed');
  assert.strictEqual(timedOutResult.reason, 'exception_query_timeout');
  assert.strictEqual(timedOutResult.message, '云仓异常订单查询超时，请稍后重试');
  assert.strictEqual(JSON.stringify(timedOutResult).includes('sensitive timeout detail'), false);

  const printPersistence = createPersistence();
  const printExecutor = createExecutor(printPersistence);
  let printExecutions = 0;
  printExecutor.registerAdapter('warehouse.order.print', {
    validateParams: () => true,
    preflight: async () => ({ ok: true, observed_status: 'arrived' }),
    execute: async () => {
      printExecutions++;
      return { printer_job_ref: 'local-job-001' };
    },
    verify: async () => ({ confirmed: true, observed_status: 'printed_unshipped' })
  });
  const printTask = makeTask('warehouse.order.print');
  const printResult = await printExecutor.executeTask(printTask);
  assert.strictEqual(printResult.status, 'succeeded');
  assert.strictEqual(printResult.delivery.executed, true);
  assert.strictEqual(printResult.delivery.business_confirmed, true);
  assert.strictEqual(printResult.verification.expected_status, 'printed_unshipped');
  assert.strictEqual(printResult.verification.observed_status, 'printed_unshipped');
  assert.strictEqual(printResult.verification.observed_at, new Date(NOW).toISOString());
  assert.strictEqual(JSON.stringify(printResult).includes('sameDevice'), false);
  assert.strictEqual(JSON.stringify(printResult).includes('executor_instance_id'), false);
  const printDuplicate = await printExecutor.executeTask(printTask);
  assert.strictEqual(printDuplicate.delivery.replayed, true);
  assert.strictEqual(printExecutions, 1);

  const collisionTask = makeTask('warehouse.order.print', {
    task_id: 'task-print-collision',
    idempotency_key: printTask.idempotency_key,
    order_id: 'order-ref-99999'
  });
  const collision = await printExecutor.executeTask(collisionTask);
  assert.strictEqual(collision.status, 'review_required');
  assert.strictEqual(collision.reason, 'idempotency_key_collision');
  assert.strictEqual(printExecutions, 1);

  const uncertainPersistence = createPersistence();
  const uncertainExecutor = createExecutor(uncertainPersistence);
  let uncertainExecutions = 0;
  uncertainExecutor.registerAdapter('exception.order.resolve', {
    validateParams: () => true,
    preflight: async () => ({ ok: true, observed_status: 'exception_found' }),
    execute: async () => {
      uncertainExecutions++;
      return { accepted: true };
    },
    verify: async () => ({ confirmed: false, message: '异常状态尚未解除' })
  });
  const uncertainTask = makeTask('exception.order.resolve');
  const uncertain = await uncertainExecutor.executeTask(uncertainTask);
  assert.strictEqual(uncertain.status, 'review_required');
  assert.strictEqual(uncertain.reason, 'business_state_unconfirmed');
  assert.strictEqual(uncertain.verification.expected_status, 'waiting_arrival');
  assert.strictEqual(uncertain.verification.observed_at, new Date(NOW).toISOString());
  const uncertainDuplicate = await uncertainExecutor.executeTask(uncertainTask);
  assert.strictEqual(uncertainDuplicate.delivery.replayed, true);
  assert.strictEqual(uncertainExecutions, 1);

  const wrongStateExecutor = createExecutor(createPersistence());
  wrongStateExecutor.registerAdapter('warehouse.order.outbound', {
    validateParams: () => true,
    preflight: async () => ({ ok: true, observed_status: 'printed_unshipped' }),
    execute: async () => ({ accepted: true }),
    verify: async () => ({ confirmed: true, observed_status: 'printed_unshipped' })
  });
  const wrongState = await wrongStateExecutor.executeTask(makeTask('warehouse.order.outbound'));
  assert.strictEqual(wrongState.status, 'review_required');
  assert.strictEqual(wrongState.reason, 'unexpected_business_state');
  assert.strictEqual(wrongState.verification.expected_status, 'shipped');

  const thrownExecutor = createExecutor(createPersistence());
  thrownExecutor.registerAdapter('exception.order.resolve', {
    validateParams: () => true,
    preflight: async () => ({ ok: true }),
    execute: async () => { throw new Error('连接中断 Cookie: session-secret'); },
    verify: async () => ({ confirmed: false })
  });
  const thrown = await thrownExecutor.executeTask(makeTask('exception.order.resolve', {
    task_id: 'task-write-thrown',
    idempotency_key: 'idem-write-thrown'
  }));
  assert.strictEqual(thrown.status, 'review_required');
  assert.strictEqual(thrown.reason, 'execution_result_unknown');
  assert.strictEqual(thrown.delivery.executed, true);
  assert.strictEqual(thrown.message, '[REDACTED]');

  const lockPersistence = createPersistence();
  const lockExecutor = createExecutor(lockPersistence);
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  lockExecutor.registerAdapter('exception.order.resolve', {
    validateParams: () => true,
    preflight: async () => ({ ok: true }),
    execute: async () => {
      await firstGate;
      return { accepted: true };
    },
    verify: async () => ({ confirmed: true, observed_status: 'waiting_arrival' })
  });
  const firstWrite = makeTask('exception.order.resolve', {
    task_id: 'task-lock-first',
    idempotency_key: 'idem-lock-first',
    order_id: 'order-ref-locked'
  });
  const secondWrite = makeTask('exception.order.resolve', {
    task_id: 'task-lock-second',
    idempotency_key: 'idem-lock-second',
    order_id: 'order-ref-locked'
  });
  const pendingFirst = lockExecutor.executeTask(firstWrite);
  await new Promise(resolve => setImmediate(resolve));
  const locked = await lockExecutor.executeTask(secondWrite);
  assert.strictEqual(locked.status, 'refused');
  assert.strictEqual(locked.reason, 'order_locked');
  assert.strictEqual(lockExecutor.getAuditSnapshot().some(item => item.event === 'order_lock_refused'), true);

  const recoveredExecutor = createExecutor(lockPersistence);
  const recovered = await recoveredExecutor.executeTask(firstWrite);
  assert.strictEqual(recovered.delivery.replayed, true);
  assert.strictEqual(recovered.status, 'review_required');
  assert.strictEqual(recovered.reason, 'interrupted_execution');
  assert.strictEqual(recovered.delivery.executed, true);

  releaseFirst();
  const firstCompleted = await pendingFirst;
  assert.strictEqual(firstCompleted.status, 'succeeded');

  const auditText = JSON.stringify(printExecutor.getAuditSnapshot());
  assert.strictEqual(auditText.includes('local-job-001'), false);
  assert.strictEqual(auditText.includes('pt_key'), false);

  console.log('订单命令执行器测试通过：机器码路由、白名单、TTL、脱敏、幂等、订单锁、三阶段复验与中断恢复均已覆盖');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
