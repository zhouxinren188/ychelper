'use strict';

const crypto = require('crypto');

const SNAPSHOT_STATE_VERSION = 1;
const DEFAULT_SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_SNAPSHOTS = 200;
const SNAPSHOT_REF_PATTERN = /^exsnap-[a-f0-9]{32}$/;

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprintRecords(records) {
  if (!Array.isArray(records)) throw new Error('异常快照记录必须为数组');
  const canonicalRecords = records.map(record => stableStringify(record)).sort();
  return crypto.createHash('sha256').update(stableStringify(canonicalRecords)).digest('hex');
}

function defaultState() {
  return { version: SNAPSHOT_STATE_VERSION, snapshots: {}, snapshot_order: [] };
}

class ExceptionSnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExceptionSnapshotError';
    this.code = code;
  }
}

class ExceptionSnapshotStore {
  constructor(options = {}) {
    if (!options.machineCode || typeof options.loadState !== 'function' || typeof options.saveState !== 'function') {
      throw new Error('ExceptionSnapshotStore 需要 machineCode、loadState 和 saveState');
    }
    this.machineCode = String(options.machineCode);
    this.loadState = options.loadState;
    this.saveState = options.saveState;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.ttlMs = options.ttlMs || DEFAULT_SNAPSHOT_TTL_MS;
    this.maxSnapshots = options.maxSnapshots || DEFAULT_MAX_SNAPSHOTS;
    this.randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
    this.state = this._load();
  }

  _load() {
    const loaded = this.loadState();
    if (loaded === null || loaded === undefined) return defaultState();
    const state = cloneJson(loaded);
    if (!state || state.version !== SNAPSHOT_STATE_VERSION ||
        !state.snapshots || typeof state.snapshots !== 'object' || Array.isArray(state.snapshots) ||
        !Array.isArray(state.snapshot_order)) {
      throw new Error('异常订单快照状态损坏，已安全停用异常处理能力');
    }
    return state;
  }

  _save() {
    if (this.saveState(cloneJson(this.state)) === false) {
      throw new Error('异常订单快照无法持久化');
    }
  }

  _cleanup() {
    const nowMs = this.now();
    this.state.snapshot_order = this.state.snapshot_order.filter(ref => {
      const snapshot = this.state.snapshots[ref];
      if (!snapshot) return false;
      const expired = Date.parse(snapshot.expires_at) <= nowMs;
      if (expired) {
        delete this.state.snapshots[ref];
        return false;
      }
      return true;
    });
    if (this.state.snapshot_order.length >= this.maxSnapshots) {
      throw new Error('异常订单快照存储已满，禁止淘汰仍在有效期内的确认快照');
    }
  }

  create({ orderId, locator, records }) {
    if (!orderId || !locator || !Array.isArray(records) || records.length === 0) {
      throw new Error('仅有待处理异常的有效订单才能创建异常快照');
    }
    this._cleanup();
    let ref;
    do {
      ref = `exsnap-${this.randomBytes(16).toString('hex')}`;
    } while (this.state.snapshots[ref]);
    const createdAtMs = this.now();
    this.state.snapshots[ref] = {
      snapshot_ref: ref,
      machine_code: this.machineCode,
      order_id: String(orderId),
      locator: cloneJson(locator),
      records: cloneJson(records),
      records_fingerprint: fingerprintRecords(records),
      status: 'available',
      created_at: new Date(createdAtMs).toISOString(),
      expires_at: new Date(createdAtMs + this.ttlMs).toISOString(),
      claimed_at: '',
      claimed_by_task_id: ''
    };
    this.state.snapshot_order.push(ref);
    this._save();
    return this.get(ref, { orderId });
  }

  get(ref, { orderId } = {}) {
    if (!SNAPSHOT_REF_PATTERN.test(String(ref || ''))) {
      throw new ExceptionSnapshotError('invalid_snapshot_ref', 'exception_snapshot_ref 格式无效');
    }
    const snapshot = this.state.snapshots[ref];
    if (!snapshot || snapshot.machine_code !== this.machineCode) {
      throw new ExceptionSnapshotError('snapshot_not_found', '异常快照不存在或不属于本机');
    }
    if (orderId && snapshot.order_id !== String(orderId)) {
      throw new ExceptionSnapshotError('snapshot_order_mismatch', '异常快照与当前 order_ref_id 不一致');
    }
    if (Date.parse(snapshot.expires_at) <= this.now()) {
      throw new ExceptionSnapshotError('snapshot_expired', '异常快照已过期，请重新查询并确认');
    }
    if (snapshot.status !== 'available') {
      throw new ExceptionSnapshotError('snapshot_already_claimed', '异常快照已经用于处理，禁止重复执行');
    }
    return cloneJson(snapshot);
  }

  assertRecordsMatch(ref, records, options) {
    const snapshot = this.get(ref, options);
    if (snapshot.records_fingerprint !== fingerprintRecords(records)) {
      throw new ExceptionSnapshotError('snapshot_changed', '待处理异常集合已变化，请重新查询并确认');
    }
    return snapshot;
  }

  claim(ref, { orderId, taskId }) {
    const snapshot = this.get(ref, { orderId });
    snapshot.status = 'claimed';
    snapshot.claimed_at = new Date(this.now()).toISOString();
    snapshot.claimed_by_task_id = String(taskId || '');
    this.state.snapshots[ref] = snapshot;
    this._save();
    return cloneJson(snapshot);
  }
}

module.exports = {
  DEFAULT_MAX_SNAPSHOTS,
  DEFAULT_SNAPSHOT_TTL_MS,
  ExceptionSnapshotError,
  ExceptionSnapshotStore,
  SNAPSHOT_REF_PATTERN,
  SNAPSHOT_STATE_VERSION,
  fingerprintRecords
};
