'use strict';

const { MACHINE_CODE_PATTERN } = require('./machine-code');

const PROTOCOL_VERSION = '1.0';

const COMMAND_DEFINITIONS = Object.freeze({
  'exception.order.check': Object.freeze({
    mode: 'read',
    maxTtlMs: 10 * 60 * 1000,
    requiresConfirmation: false,
    nextStates: Object.freeze(['exception_found', 'waiting_arrival', 'failed'])
  }),
  'exception.order.resolve': Object.freeze({
    mode: 'write',
    maxTtlMs: 2 * 60 * 1000,
    requiresConfirmation: true,
    successStates: Object.freeze(['waiting_arrival']),
    nextStates: Object.freeze(['waiting_arrival', 'review_required', 'failed'])
  }),
  'warehouse.order.check': Object.freeze({
    mode: 'read',
    maxTtlMs: 10 * 60 * 1000,
    requiresConfirmation: false,
    nextStates: Object.freeze(['waiting_arrival', 'arrived', 'printed_unshipped', 'shipped', 'failed'])
  }),
  'warehouse.order.print': Object.freeze({
    mode: 'write',
    maxTtlMs: 2 * 60 * 1000,
    requiresConfirmation: true,
    successStates: Object.freeze(['printed_unshipped']),
    nextStates: Object.freeze(['printed_unshipped', 'review_required', 'failed'])
  }),
  'warehouse.order.reprint': Object.freeze({
    mode: 'write',
    maxTtlMs: 2 * 60 * 1000,
    requiresConfirmation: true,
    successStates: Object.freeze(['reprinted']),
    nextStates: Object.freeze(['reprinted', 'review_required', 'failed'])
  }),
  'warehouse.order.outbound': Object.freeze({
    mode: 'write',
    maxTtlMs: 2 * 60 * 1000,
    requiresConfirmation: true,
    successStates: Object.freeze(['shipped']),
    nextStates: Object.freeze(['shipped', 'review_required', 'failed'])
  })
});

const WORKFLOW_STATES = Object.freeze([
  'checking_exception',
  'exception_found',
  'resolving_exception',
  'waiting_arrival',
  'arrived',
  'printing',
  'printed_unshipped',
  'reprinting',
  'reprinted',
  'outbound_processing',
  'shipped',
  'failed',
  'review_required'
]);

const TASK_KEYS = new Set([
  'protocol_version',
  'task_id',
  'trace_id',
  'command',
  'order_id',
  'idempotency_key',
  'created_at',
  'expires_at',
  'requested_by',
  'target',
  'confirmation',
  'params'
]);
const ACTOR_KEYS = new Set(['actor_id', 'actor_type', 'display_name']);
const TARGET_KEYS = new Set(['machine_code']);
const CONFIRMATION_KEYS = new Set(['confirmed', 'confirmed_at', 'actor_id', 'action']);
const SAFE_ID_PATTERN = /^[A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff._:@/-]{0,127}$/;
const DANGEROUS_PARAMETER_TOKENS = new Set([
  'url', 'uri', 'endpoint', 'host', 'hostname', 'script', 'shell', 'cmd', 'command',
  'commandline', 'executable', 'binary', 'eval', 'code', 'module', 'require',
  'adapter', 'handler', 'function', 'filepath', 'modulepath', 'workingdirectory',
  'header', 'headers', 'argument', 'arguments', 'args'
]);
const SENSITIVE_PARAMETER_TOKENS = new Set([
  'cookie', 'setcookie', 'authorization', 'authtoken', 'accesstoken', 'refreshtoken',
  'token', 'password', 'passwd', 'secret', 'credential', 'credentials', 'privatekey',
  'apikey'
]);
const SENSITIVE_TEXT = /(?:pt_key|pt_pin|authorization|cookie|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential|api[_-]?key)\s*[:=]|\bbearer\s+[A-Za-z0-9._~+/=-]+/i;
const MAX_PARAMS_BYTES = 16 * 1024;
const MAX_RESULT_STRING = 4000;
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 100;

class OrderCommandProtocolError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'OrderCommandProtocolError';
    this.code = code;
    this.details = details || null;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertAllowedKeys(value, allowedKeys, label) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new OrderCommandProtocolError('unknown_field', `${label} 包含未允许字段: ${key}`);
    }
  }
}

function assertSafeId(value, label) {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value) ||
      ['__proto__', 'prototype', 'constructor'].includes(normalized)) {
    throw new OrderCommandProtocolError('invalid_identifier', `${label} 格式无效`);
  }
}

function parseTimestamp(value, label) {
  if (typeof value !== 'string' || value.length > 40) {
    throw new OrderCommandProtocolError('invalid_timestamp', `${label} 必须为 ISO 时间字符串`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new OrderCommandProtocolError('invalid_timestamp', `${label} 不是有效时间`);
  }
  return timestamp;
}

function parameterKeyTokens(key) {
  const separated = String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const collapsed = separated.join('');
  return { separated, collapsed };
}

function hasForbiddenParameterKey(key) {
  const raw = String(key).toLowerCase();
  if (['__proto__', 'prototype', 'constructor'].includes(raw)) return true;
  const { separated, collapsed } = parameterKeyTokens(key);
  return separated.some(token => DANGEROUS_PARAMETER_TOKENS.has(token)) ||
    DANGEROUS_PARAMETER_TOKENS.has(collapsed);
}

function hasSensitiveParameterKey(key) {
  const { separated, collapsed } = parameterKeyTokens(key);
  return separated.some(token => SENSITIVE_PARAMETER_TOKENS.has(token)) ||
    SENSITIVE_PARAMETER_TOKENS.has(collapsed);
}

function inspectParameterValue(value, path, depth) {
  if (depth > MAX_DEPTH) {
    throw new OrderCommandProtocolError('params_too_deep', `${path} 嵌套层级超过限制`);
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new OrderCommandProtocolError('invalid_params', `${path} 包含非有限数字`);
    }
    return;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_RESULT_STRING) {
      throw new OrderCommandProtocolError('params_too_large', `${path} 字符串过长`);
    }
    if (SENSITIVE_TEXT.test(value)) {
      throw new OrderCommandProtocolError('sensitive_params', `${path} 疑似包含凭据`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) {
      throw new OrderCommandProtocolError('params_too_large', `${path} 数组项过多`);
    }
    value.forEach((item, index) => inspectParameterValue(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isPlainObject(value)) {
    throw new OrderCommandProtocolError('invalid_params', `${path} 仅允许 JSON 数据`);
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    if (hasForbiddenParameterKey(key)) {
      throw new OrderCommandProtocolError('dangerous_params', `${path}.${key} 属于禁止的执行入口字段`);
    }
    if (hasSensitiveParameterKey(key)) {
      throw new OrderCommandProtocolError('sensitive_params', `${path}.${key} 不允许携带凭据`);
    }
    inspectParameterValue(nestedValue, `${path}.${key}`, depth + 1);
  }
}

function validateTaskEnvelope(task, options = {}) {
  if (!isPlainObject(task)) {
    throw new OrderCommandProtocolError('invalid_task', '任务必须为普通 JSON 对象');
  }
  assertAllowedKeys(task, TASK_KEYS, '任务');

  if (task.protocol_version !== PROTOCOL_VERSION) {
    throw new OrderCommandProtocolError('unsupported_protocol', `仅支持协议版本 ${PROTOCOL_VERSION}`);
  }

  const definition = COMMAND_DEFINITIONS[task.command];
  if (!definition) {
    throw new OrderCommandProtocolError('command_not_allowed', '命令不在本机白名单中');
  }

  assertSafeId(task.task_id, 'task_id');
  assertSafeId(task.trace_id, 'trace_id');
  assertSafeId(task.order_id, 'order_id');
  assertSafeId(task.idempotency_key, 'idempotency_key');

  const nowMs = options.nowMs === undefined ? Date.now() : options.nowMs;
  const createdAtMs = parseTimestamp(task.created_at, 'created_at');
  const expiresAtMs = parseTimestamp(task.expires_at, 'expires_at');
  if (createdAtMs > nowMs + 2 * 60 * 1000) {
    throw new OrderCommandProtocolError('created_in_future', '任务创建时间超出允许时钟偏差');
  }
  if (expiresAtMs <= nowMs) {
    throw new OrderCommandProtocolError('task_expired', '任务已经过期');
  }
  if (expiresAtMs <= createdAtMs || expiresAtMs - createdAtMs > definition.maxTtlMs) {
    throw new OrderCommandProtocolError('invalid_ttl', '任务有效期超过该命令允许范围');
  }

  if (!isPlainObject(task.requested_by)) {
    throw new OrderCommandProtocolError('invalid_actor', 'requested_by 必须为对象');
  }
  assertAllowedKeys(task.requested_by, ACTOR_KEYS, 'requested_by');
  assertSafeId(task.requested_by.actor_id, 'requested_by.actor_id');
  if (!['user', 'system'].includes(task.requested_by.actor_type)) {
    throw new OrderCommandProtocolError('invalid_actor', 'requested_by.actor_type 无效');
  }
  if (task.requested_by.display_name !== undefined &&
      (typeof task.requested_by.display_name !== 'string' || task.requested_by.display_name.length > 80)) {
    throw new OrderCommandProtocolError('invalid_actor', 'requested_by.display_name 无效');
  }

  if (!isPlainObject(task.target)) {
    throw new OrderCommandProtocolError('machine_code_target_required', 'target 必须只包含本机 machine_code');
  }
  assertAllowedKeys(task.target, TARGET_KEYS, 'target');
  if (!MACHINE_CODE_PATTERN.test(task.target.machine_code || '')) {
    throw new OrderCommandProtocolError('invalid_machine_code', 'target.machine_code 格式无效');
  }
  if (options.expectedMachineCode && task.target.machine_code !== options.expectedMachineCode) {
    throw new OrderCommandProtocolError('machine_code_mismatch', '任务未定向到本机机器码');
  }

  if (definition.requiresConfirmation) {
    if (!isPlainObject(task.confirmation)) {
      throw new OrderCommandProtocolError('confirmation_required', '写命令缺少用户确认凭据');
    }
    assertAllowedKeys(task.confirmation, CONFIRMATION_KEYS, 'confirmation');
    if (task.confirmation.confirmed !== true || task.confirmation.action !== task.command) {
      throw new OrderCommandProtocolError('confirmation_required', '用户确认与当前命令不匹配');
    }
    assertSafeId(task.confirmation.actor_id, 'confirmation.actor_id');
    const confirmedAtMs = parseTimestamp(task.confirmation.confirmed_at, 'confirmation.confirmed_at');
    if (confirmedAtMs < createdAtMs - 2 * 60 * 1000 || confirmedAtMs > nowMs + 2 * 60 * 1000) {
      throw new OrderCommandProtocolError('invalid_confirmation', '用户确认时间无效');
    }
  } else if (task.confirmation !== undefined) {
    throw new OrderCommandProtocolError('unexpected_confirmation', '只读命令不接受 confirmation 字段');
  }

  const params = task.params === undefined ? {} : task.params;
  if (!isPlainObject(params)) {
    throw new OrderCommandProtocolError('invalid_params', 'params 必须为对象');
  }
  let serializedParams;
  try {
    serializedParams = JSON.stringify(params);
  } catch {
    throw new OrderCommandProtocolError('invalid_params', 'params 必须可序列化为 JSON');
  }
  if (Buffer.byteLength(serializedParams, 'utf8') > MAX_PARAMS_BYTES) {
    throw new OrderCommandProtocolError('params_too_large', 'params 超过 16KB 限制');
  }
  inspectParameterValue(params, 'params', 0);
  if (typeof params.order_no === 'string' && task.order_id !== params.order_no) {
    throw new OrderCommandProtocolError(
      'order_id_mismatch',
      '订单任务的 order_id 必须与 params.order_no 完全一致'
    );
  }

  return { definition, createdAtMs, expiresAtMs, params };
}

function sanitizeResult(value, options = {}, depth = 0, seen = new WeakSet()) {
  if (depth > MAX_DEPTH) return '[TRUNCATED]';
  if (value === undefined || value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (SENSITIVE_TEXT.test(value)) return '[REDACTED]';
    const maxLength = options.maxStringLength || MAX_RESULT_STRING;
    return value.length > maxLength ? `${value.slice(0, maxLength)}...[TRUNCATED]` : value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[BUFFER ${value.length} bytes]`;
  if (typeof value !== 'object') return '[UNSUPPORTED]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map(item => sanitizeResult(item, options, depth + 1, seen));
  }

  const output = Object.create(null);
  for (const [key, nestedValue] of Object.entries(value)) {
    if (hasForbiddenParameterKey(key) || hasSensitiveParameterKey(key)) {
      output[key] = '[REDACTED]';
      continue;
    }
    output[key] = sanitizeResult(nestedValue, options, depth + 1, seen);
  }
  return output;
}

function getCommandDefinition(command) {
  return COMMAND_DEFINITIONS[command] || null;
}

module.exports = {
  PROTOCOL_VERSION,
  COMMAND_DEFINITIONS,
  WORKFLOW_STATES,
  OrderCommandProtocolError,
  getCommandDefinition,
  isPlainObject,
  sanitizeResult,
  validateTaskEnvelope
};
