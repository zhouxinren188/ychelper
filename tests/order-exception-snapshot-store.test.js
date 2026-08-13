'use strict';

const assert = require('assert');
const {
  ExceptionSnapshotError,
  ExceptionSnapshotStore,
  fingerprintRecords
} = require('../order-exception-snapshot-store');

const MACHINE_CODE = 'YC-7F3K-92MX';
let now = Date.parse('2026-08-12T12:00:00.000Z');
let state = null;
let randomCounter = 1;
const store = new ExceptionSnapshotStore({
  machineCode: MACHINE_CODE,
  now: () => now,
  ttlMs: 60_000,
  maxSnapshots: 3,
  randomBytes: size => {
    const buffer = Buffer.alloc(size);
    buffer.writeUInt32BE(randomCounter++, size - 4);
    return buffer;
  },
  loadState: () => state,
  saveState: next => {
    state = JSON.parse(JSON.stringify(next));
    return true;
  }
});

const records = [
  { source: 'bill_exception', id: 'internal-001', exception_code: 'E1' },
  { source: 'so_exception', id: 'internal-002', exception_code: 'E2' }
];
const snapshot = store.create({
  orderId: 'order-ref-001',
  locator: { platform_order_no: 'PO-001', order_year: '2026' },
  records
});
assert.match(snapshot.snapshot_ref, /^exsnap-[a-f0-9]{32}$/);
assert.strictEqual(snapshot.order_id, 'order-ref-001');
assert.deepStrictEqual(snapshot.records, records);
assert.strictEqual(snapshot.records_fingerprint, fingerprintRecords(records));
assert.strictEqual(state.snapshots[snapshot.snapshot_ref].machine_code, MACHINE_CODE);

const restartedStore = new ExceptionSnapshotStore({
  machineCode: MACHINE_CODE,
  now: () => now,
  ttlMs: 60_000,
  loadState: () => state,
  saveState: next => {
    state = JSON.parse(JSON.stringify(next));
    return true;
  }
});
assert.strictEqual(restartedStore.get(snapshot.snapshot_ref, { orderId: 'order-ref-001' }).status, 'available');
assert.throws(
  () => restartedStore.get(snapshot.snapshot_ref, { orderId: 'order-ref-002' }),
  error => error instanceof ExceptionSnapshotError && error.code === 'snapshot_order_mismatch'
);
assert.throws(
  () => restartedStore.assertRecordsMatch(snapshot.snapshot_ref, records.slice(0, 1), { orderId: 'order-ref-001' }),
  error => error instanceof ExceptionSnapshotError && error.code === 'snapshot_changed'
);
assert.doesNotThrow(() => {
  restartedStore.assertRecordsMatch(snapshot.snapshot_ref, records, { orderId: 'order-ref-001' });
});
assert.doesNotThrow(() => {
  restartedStore.assertRecordsMatch(snapshot.snapshot_ref, [...records].reverse(), { orderId: 'order-ref-001' });
});

const claimed = restartedStore.claim(snapshot.snapshot_ref, {
  orderId: 'order-ref-001',
  taskId: 'task-resolve-001'
});
assert.strictEqual(claimed.status, 'claimed');
assert.strictEqual(claimed.claimed_by_task_id, 'task-resolve-001');
assert.throws(
  () => restartedStore.get(snapshot.snapshot_ref, { orderId: 'order-ref-001' }),
  error => error instanceof ExceptionSnapshotError && error.code === 'snapshot_already_claimed'
);

const expiring = restartedStore.create({
  orderId: 'order-ref-expiring',
  locator: { platform_order_no: 'PO-EXPIRING', order_year: '2026' },
  records: [{ source: 'bill_exception', id: 'internal-expiring' }]
});
now += 60_001;
assert.throws(
  () => restartedStore.get(expiring.snapshot_ref, { orderId: 'order-ref-expiring' }),
  error => error instanceof ExceptionSnapshotError && error.code === 'snapshot_expired'
);

console.log('异常快照存储测试通过：持久化、机器码/订单绑定、集合指纹、过期和一次性领取均已覆盖');
