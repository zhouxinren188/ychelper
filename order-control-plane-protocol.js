'use strict';

const {
  PROTOCOL_VERSION,
  COMMAND_DEFINITIONS,
  isPlainObject,
  sanitizeResult,
  validateTaskEnvelope
} = require('./order-command-protocol');

const MACHINE_CODE_PATTERN = /^YC-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const CONTROL_PLANE_PREFIX = '/api/cloud-warehouse/executor/v1';
const CONTROL_PLANE_PATHS = Object.freeze({
  wait: `${CONTROL_PLANE_PREFIX}/commands/wait`,
  commandResult: requestId => commandPath(requestId, 'result')
});

class ControlPlaneProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ControlPlaneProtocolError';
    this.code = code;
  }
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw new ControlPlaneProtocolError('invalid_response', `${label} must be an object`);
  }
}

function assertAllowedKeys(value, allowedKeys, label, requiredKeys = []) {
  assertPlainObject(value, label);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new ControlPlaneProtocolError('invalid_response', `${label} contains undeclared field ${key}`);
    }
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new ControlPlaneProtocolError('invalid_response', `${label} is missing field ${key}`);
    }
  }
}

function assertString(value, label, options = {}) {
  const minLength = options.minLength === undefined ? 1 : options.minLength;
  const maxLength = options.maxLength === undefined ? 512 : options.maxLength;
  if (typeof value !== 'string' || value.length < minLength || value.length > maxLength) {
    throw new ControlPlaneProtocolError('invalid_response', `${label} has an invalid format`);
  }
  if (options.pattern && !options.pattern.test(value)) {
    throw new ControlPlaneProtocolError('invalid_response', `${label} has an invalid format`);
  }
  return value;
}

function assertMachineCode(machineCode) {
  return assertString(machineCode, 'machine_code', { pattern: MACHINE_CODE_PATTERN, maxLength: 12 });
}

function assertSafeId(value, label) {
  return assertString(value, label, { pattern: SAFE_ID_PATTERN, maxLength: 128 });
}

function assertIsoTimestamp(value, label) {
  assertString(value, label, { maxLength: 64 });
  if (!Number.isFinite(Date.parse(value))) {
    throw new ControlPlaneProtocolError('invalid_response', `${label} must be an ISO timestamp`);
  }
  return value;
}

function assertInteger(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ControlPlaneProtocolError('invalid_response', `${label} is outside the allowed range`);
  }
  return value;
}

function commandPath(requestId, suffix) {
  assertSafeId(requestId, 'task_id');
  return `${CONTROL_PLANE_PREFIX}/commands/${encodeURIComponent(requestId)}/${suffix}`;
}

function normalizeControlPlaneBaseUrl(candidate) {
  const raw = String(candidate || '').trim();
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new ControlPlaneProtocolError('invalid_service_url', 'The command service URL is invalid');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.pathname && parsed.pathname !== '/')) {
    throw new ControlPlaneProtocolError(
      'invalid_service_url',
      'The command service must use a fixed HTTPS origin without a path, credentials, query or fragment'
    );
  }
  return parsed.origin;
}

function capabilityMap(capabilities) {
  const output = {};
  const source = Array.isArray(capabilities)
    ? Object.fromEntries(capabilities.map(item => [item.command, item.enabled === true]))
    : isPlainObject(capabilities) ? capabilities : {};
  for (const command of Object.keys(COMMAND_DEFINITIONS)) output[command] = source[command] === true;
  return output;
}

function buildWaitRequest({ machineCode, capabilities, waitSeconds = 25 }) {
  assertMachineCode(machineCode);
  return {
    protocol_version: PROTOCOL_VERSION,
    machine_code: machineCode,
    capabilities: capabilityMap(capabilities),
    wait_seconds: assertInteger(waitSeconds, 'wait_seconds', 1, 30)
  };
}

function validateWaitResponse(response, expectedMachineCode, nowMs = Date.now()) {
  assertAllowedKeys(
    response,
    new Set(['task', 'retry_after_seconds']),
    'wait response',
    ['task']
  );
  const retryAfterSeconds = response.retry_after_seconds === undefined
    ? 1
    : assertInteger(response.retry_after_seconds, 'retry_after_seconds', 0, 60);
  if (response.task === null) return { task: null, retry_after_seconds: retryAfterSeconds };
  validateTaskEnvelope(response.task, { nowMs, expectedMachineCode });
  return { task: JSON.parse(JSON.stringify(response.task)), retry_after_seconds: retryAfterSeconds };
}

function prepareExecutorResponse(response, machineCode) {
  assertPlainObject(response, 'executor response');
  const sanitized = sanitizeResult(response);
  sanitized.executor = { machine_code: assertMachineCode(machineCode) };
  delete sanitized.device_id;
  delete sanitized.executor_instance_id;
  return sanitized;
}

function buildResultRequest({ machineCode, response }) {
  assertMachineCode(machineCode);
  if (!response || !response.task_id) {
    throw new ControlPlaneProtocolError('invalid_result', 'Executor result is missing task_id');
  }
  return {
    protocol_version: PROTOCOL_VERSION,
    machine_code: machineCode,
    response: prepareExecutorResponse(response, machineCode)
  };
}

function validateResultResponse(response, expectedTaskId) {
  assertAllowedKeys(
    response,
    new Set(['accepted', 'task_id', 'recorded_at', 'replayed']),
    'result receipt',
    ['accepted', 'task_id', 'recorded_at', 'replayed']
  );
  if (response.accepted !== true || typeof response.replayed !== 'boolean') {
    throw new ControlPlaneProtocolError('result_not_accepted', 'The command result was not accepted');
  }
  assertSafeId(response.task_id, 'task_id');
  if (response.task_id !== expectedTaskId) {
    throw new ControlPlaneProtocolError('task_id_mismatch', 'Result receipt task_id does not match');
  }
  assertIsoTimestamp(response.recorded_at, 'recorded_at');
  return {
    accepted: true,
    task_id: response.task_id,
    recorded_at: response.recorded_at,
    replayed: response.replayed
  };
}

module.exports = {
  CONTROL_PLANE_PATHS,
  CONTROL_PLANE_PREFIX,
  ControlPlaneProtocolError,
  buildResultRequest,
  buildWaitRequest,
  capabilityMap,
  normalizeControlPlaneBaseUrl,
  prepareExecutorResponse,
  validateResultResponse,
  validateWaitResponse
};
