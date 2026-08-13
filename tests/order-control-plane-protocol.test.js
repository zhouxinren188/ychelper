'use strict';

const assert = require('assert');
const {
  CONTROL_PLANE_PATHS,
  buildResultRequest,
  buildWaitRequest,
  normalizeControlPlaneBaseUrl,
  validateWaitResponse
} = require('../order-control-plane-protocol');

const MACHINE_CODE = 'YC-7F3K-92MX';
const NOW = Date.parse('2026-08-13T00:00:00.000Z');

function makeTask(overrides = {}) {
  return {
    protocol_version: '1.0',
    task_id: 'task-001',
    trace_id: 'wf-001',
    command: 'exception.order.check',
    order_id: '3588401003348721',
    idempotency_key: 'idem-001',
    created_at: new Date(NOW - 1000).toISOString(),
    expires_at: new Date(NOW + 5 * 60 * 1000).toISOString(),
    requested_by: { actor_id: '123', actor_type: 'user', display_name: 'operator' },
    target: { machine_code: MACHINE_CODE },
    params: { order_no: '3588401003348721', order_year: 2026 },
    ...overrides
  };
}

assert.strictEqual(normalizeControlPlaneBaseUrl('https://central.example.com/'), 'https://central.example.com');
assert.throws(() => normalizeControlPlaneBaseUrl('http://central.example.com'), /HTTPS/);
assert.throws(() => normalizeControlPlaneBaseUrl('https://central.example.com/custom'), /HTTPS/);
assert.strictEqual(
  CONTROL_PLANE_PATHS.commandResult('task/unsafe'),
  '/api/cloud-warehouse/executor/v1/commands/task%2Funsafe/result'
);

const waitRequest = buildWaitRequest({
  machineCode: MACHINE_CODE,
  capabilities: [{ command: 'exception.order.check', enabled: true }]
});
assert.strictEqual(waitRequest.machine_code, MACHINE_CODE);
assert.strictEqual(waitRequest.wait_seconds, 25);
assert.strictEqual(waitRequest.capabilities['exception.order.check'], true);
assert.strictEqual(waitRequest.capabilities['warehouse.order.print'], false);

const waited = validateWaitResponse({ task: makeTask(), retry_after_seconds: 0 }, MACHINE_CODE, NOW);
assert.strictEqual(waited.task.target.machine_code, MACHINE_CODE);
assert.strictEqual(waited.task.params.order_year, 2026);
assert.deepStrictEqual(validateWaitResponse({ task: null, retry_after_seconds: 1 }, MACHINE_CODE, NOW), {
  task: null,
  retry_after_seconds: 1
});
assert.throws(() => validateWaitResponse({
  task: makeTask({ target: { machine_code: 'YC-AAAA-BBBB' } })
}, MACHINE_CODE, NOW), /机器码|machine_code/);

const resultBody = buildResultRequest({
  machineCode: MACHINE_CODE,
  response: {
    protocol_version: '1.0',
    task_id: 'task-001',
    trace_id: 'wf-001',
    command: 'exception.order.check',
    order_id: '3588401003348721',
    idempotency_key: 'idem-001',
    status: 'succeeded',
    reason: 'query_completed',
    message: '',
    delivery: { received: true, executed: true, replayed: false, receipt_id: 'receipt-001', business_confirmed: true },
    result: {},
    verification: null,
    executor: { machine_code: MACHINE_CODE },
    completed_at: '2026-08-13T00:00:01.000Z'
  }
});
assert.deepStrictEqual(resultBody.response.executor, { machine_code: MACHINE_CODE });
assert.strictEqual(JSON.stringify(resultBody).includes('executor_instance_id'), false);
assert.strictEqual(JSON.stringify(resultBody).includes('device_id'), false);

console.log('Simple command service protocol tests passed');
