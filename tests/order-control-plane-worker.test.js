'use strict';

const assert = require('assert');
const { OrderControlPlaneWorker } = require('../order-control-plane-worker');

(async () => {
  const timers = [];
  let waitCalls = 0;
  let runCalls = 0;
  const task = { task_id: 'task-001' };
  const client = {
    getStatus: () => ({ configured: true, authenticated: true }),
    waitForCommand: async () => {
      waitCalls++;
      return waitCalls === 1
        ? { task: null, retry_after_seconds: 0 }
        : { task, retry_after_seconds: 0 };
    }
  };
  const runner = {
    runtime: {
      executor: {
        getCapabilities: () => [{ command: 'exception.order.check', enabled: true }]
      }
    },
    runTask: async received => {
      assert.strictEqual(received, task);
      runCalls++;
    }
  };
  const worker = new OrderControlPlaneWorker({
    client,
    runner,
    now: () => Date.parse('2026-08-13T00:00:00.000Z'),
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: timer => { if (timer) timer.cleared = true; },
    logger: { error() {} }
  });

  assert.strictEqual(worker.start(), true);
  const generation = worker.generation;
  await worker._wait(generation);
  assert.strictEqual(worker.getStatus().online, true);
  assert.strictEqual(worker.getStatus().state, 'waiting');
  await worker._wait(generation);
  assert.strictEqual(runCalls, 1);
  assert.strictEqual(worker.getStatus().last_task_at, '2026-08-13T00:00:00.000Z');
  worker.stop();
  assert.strictEqual(worker.getStatus().online, false);

  let cancelledSignal = null;
  const cancellingWorker = new OrderControlPlaneWorker({
    client: {
      getStatus: () => ({ configured: true, authenticated: true }),
      waitForCommand: ({ signal }) => {
        cancelledSignal = signal;
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), {
            code: 'request_aborted'
          })), { once: true });
        });
      }
    },
    runner,
    setTimer: () => 1,
    clearTimer: () => {},
    logger: { error() {} }
  });
  assert.strictEqual(cancellingWorker.start(), true);
  const cancellingWait = cancellingWorker._wait(cancellingWorker.generation);
  assert.strictEqual(cancelledSignal.aborted, false);
  cancellingWorker.stop();
  await cancellingWait;
  assert.strictEqual(cancelledSignal.aborted, true);
  assert.strictEqual(cancellingWorker.waitInFlight, false);
  assert.strictEqual(cancellingWorker.getStatus().state, 'stopped');

  const unauthenticated = new OrderControlPlaneWorker({
    client: { getStatus: () => ({ configured: true, authenticated: false }) },
    runner,
    setTimer: () => 1,
    clearTimer: () => {}
  });
  assert.strictEqual(unauthenticated.start(), false);
  assert.strictEqual(unauthenticated.getStatus().state, 'login_required');

  console.log('Simple command service worker tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
