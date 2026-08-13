'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const { OrderControlPlaneClient, createHttpsJsonTransport } = require('../order-control-plane-client');

const MACHINE_CODE = 'YC-7F3K-92MX';
const NOW = Date.parse('2026-08-13T00:00:00.000Z');

(async () => {
  const calls = [];
  const transport = async request => {
    const signal = request.signal;
    calls.push(JSON.parse(JSON.stringify(request)));
    calls[calls.length - 1].signal = signal;
    if (request.path.endsWith('/commands/wait')) {
      return { statusCode: 200, headers: {}, body: { task: null, retry_after_seconds: 0 } };
    }
    if (request.path.endsWith('/result')) {
      return {
        statusCode: 200,
        headers: {},
        body: { accepted: true, task_id: 'task-001', recorded_at: '2026-08-13T00:00:01.000Z', replayed: false }
      };
    }
    throw new Error(`unexpected path ${request.path}`);
  };

  const client = new OrderControlPlaneClient({
    baseUrl: 'https://central.example.com',
    machineCode: MACHINE_CODE,
    executorVersion: '1.0.79',
    now: () => NOW,
    transport,
    getSessionToken: () => 'existing-cloud-assistant-session',
    sleep: async () => {},
    random: () => 0
  });

  assert.deepStrictEqual(client.getStatus(), { configured: true, authenticated: true });
  const waitAbortController = new AbortController();
  await client.waitForCommand({
    capabilities: [],
    waitSeconds: 25,
    signal: waitAbortController.signal
  });
  const waitCall = calls.find(call => call.path.endsWith('/commands/wait'));
  assert.strictEqual(waitCall.sessionToken, 'existing-cloud-assistant-session');
  assert.strictEqual(waitCall.body.machine_code, MACHINE_CODE);
  assert.strictEqual(waitCall.signal, waitAbortController.signal);

  await client.reportResult({ task_id: 'task-001' }, {
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
  });

  const unauthenticated = new OrderControlPlaneClient({
    baseUrl: 'https://central.example.com',
    machineCode: MACHINE_CODE,
    executorVersion: '1.0.79',
    transport,
    getSessionToken: () => ''
  });
  await assert.rejects(
    unauthenticated.waitForCommand({ capabilities: [], waitSeconds: 25 }),
    error => error && error.code === 'executor_not_authenticated'
  );

  let destroyedWith = '';
  const cancellableTransport = createHttpsJsonTransport({
    baseUrl: 'https://central.example.com',
    requestImpl: () => {
      const request = new EventEmitter();
      request.end = () => {};
      request.destroy = error => {
        destroyedWith = error && error.message;
        request.emit('error', error);
      };
      return request;
    }
  });
  const transportAbortController = new AbortController();
  const cancelledRequest = cancellableTransport({
    path: '/api/cloud-warehouse/executor/v1/commands/wait',
    body: {},
    signal: transportAbortController.signal
  });
  transportAbortController.abort();
  await assert.rejects(cancelledRequest, error => error && error.code === 'request_aborted');
  assert.strictEqual(destroyedWith, 'request_aborted');

  console.log('Simple command service client tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
