'use strict';

const assert = require('assert');
const { OrderCommandRuntime } = require('../order-command-runtime');
const { OrderControlPlaneRunner } = require('../order-control-plane-runner');

const MACHINE_CODE = 'YC-7F3K-92MX';
const NOW = Date.parse('2026-08-13T00:00:00.000Z');

function makeTask(command = 'exception.order.check') {
  return {
    protocol_version: '1.0',
    task_id: 'task-001',
    trace_id: 'wf-001',
    command,
    order_id: '3588401003348721',
    idempotency_key: 'idem-001',
    created_at: new Date(NOW - 1000).toISOString(),
    expires_at: new Date(NOW + 60_000).toISOString(),
    requested_by: { actor_id: 'dianxiaoer', actor_type: 'system', display_name: '店小二网店管家' },
    target: { machine_code: MACHINE_CODE },
    params: { order_no: '3588401003348721', order_year: 2026 }
  };
}

(async () => {
  let executorState = null;
  const runtime = new OrderCommandRuntime({
    machineCode: MACHINE_CODE,
    now: () => NOW,
    loadState: () => executorState,
    saveState: next => { executorState = JSON.parse(JSON.stringify(next)); }
  });
  let executeCalls = 0;
  runtime.executor.registerAdapter('exception.order.check', {
    validateParams: () => ({ valid: true }),
    execute: async params => {
      executeCalls++;
      assert.deepStrictEqual(params, { order_no: '3588401003348721', order_year: 2026 });
      return { exception_count: 0, queried_at: '2026-08-13T00:00:00.000Z', exceptions: [], exception_snapshot_ref: '' };
    }
  });

  const events = [];
  const client = {
    waitForCommand: async () => ({ task: makeTask(), retry_after_seconds: 0 }),
    reportResult: async (task, response) => {
      events.push('result');
      assert.strictEqual(response.status, 'succeeded');
      return { accepted: true, task_id: task.task_id, recorded_at: '2026-08-13T00:00:01.000Z', replayed: false };
    }
  };
  const runner = new OrderControlPlaneRunner({ client, runtime });
  const result = await runner.waitAndRun();
  assert.strictEqual(result.response.status, 'succeeded');
  assert.strictEqual(executeCalls, 1);
  assert.deepStrictEqual(events, ['result']);

  const replay = await runner.runTask(makeTask());
  assert.strictEqual(replay.response.delivery.replayed, true);
  assert.strictEqual(executeCalls, 1, '重复 task 不得再次执行业务查询');

  console.log('Simple command service runner tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
