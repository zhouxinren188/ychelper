'use strict';

const https = require('https');
const {
  CONTROL_PLANE_PATHS,
  CONTROL_PLANE_PREFIX,
  ControlPlaneProtocolError,
  buildResultRequest,
  buildWaitRequest,
  normalizeControlPlaneBaseUrl,
  validateResultResponse,
  validateWaitResponse
} = require('./order-control-plane-protocol');

const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 35 * 1000;
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);
const DEFAULT_BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000, 15000]);

class ControlPlaneRequestError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ControlPlaneRequestError';
    this.code = code || 'command_service_request_failed';
    this.statusCode = options.statusCode || 0;
    this.retryable = options.retryable === true;
    this.reviewRequired = options.reviewRequired === true;
    this.retryAfterMs = options.retryAfterMs || 0;
  }
}

function parseRetryAfter(value, nowMs = Date.now()) {
  if (value === undefined || value === null || value === '') return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60 * 1000);
  const at = Date.parse(String(value));
  return Number.isFinite(at) ? Math.max(0, Math.min(at - nowMs, 60 * 1000)) : 0;
}

function parseResponseBody(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    throw new ControlPlaneRequestError('invalid_response', 'Command service returned invalid JSON');
  }
}

function createHttpsJsonTransport(options = {}) {
  const baseUrl = normalizeControlPlaneBaseUrl(options.baseUrl);
  if (!baseUrl) {
    throw new ControlPlaneProtocolError('central_service_not_configured', 'Command service URL is not configured');
  }
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes || MAX_RESPONSE_BYTES;
  const requestImpl = options.requestImpl || https.request;

  return ({ path, body, sessionToken = '', signal }) => new Promise((resolve, reject) => {
    const target = new URL(path, baseUrl);
    if (target.origin !== baseUrl || !target.pathname.startsWith(`${CONTROL_PLANE_PREFIX}/`)) {
      reject(new ControlPlaneRequestError('invalid_request_path', 'Command service path is outside the fixed allowlist'));
      return;
    }
    const serialized = JSON.stringify(body || {});
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Content-Length': Buffer.byteLength(serialized)
    };
    if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
    if (signal && signal.aborted) {
      reject(new ControlPlaneRequestError('request_aborted', 'Command service request was cancelled'));
      return;
    }
    let settled = false;
    let request = null;
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', abortRequest);
    };
    const resolveOnce = value => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const normalizeNetworkFailure = error => {
      const message = error && error.message;
      if (message === 'request_aborted') {
        return new ControlPlaneRequestError('request_aborted', 'Command service request was cancelled');
      }
      return new ControlPlaneRequestError(
        message === 'request_timeout' ? 'request_timeout' : 'network_error',
        'Command service network request failed',
        { retryable: true }
      );
    };
    const abortRequest = () => {
      if (request) request.destroy(new Error('request_aborted'));
      else rejectOnce(new ControlPlaneRequestError('request_aborted', 'Command service request was cancelled'));
    };
    if (signal) signal.addEventListener('abort', abortRequest, { once: true });

    request = requestImpl(target, {
      method: 'POST',
      headers,
      timeout: timeoutMs,
      rejectUnauthorized: true
    }, response => {
      const chunks = [];
      let received = 0;
      response.on('data', chunk => {
        received += chunk.length;
        if (received > maxResponseBytes) {
          response.destroy(new Error('response_too_large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          resolveOnce({
            statusCode: Number(response.statusCode || 0),
            headers: response.headers || {},
            body: parseResponseBody(Buffer.concat(chunks).toString('utf8'))
          });
        } catch (error) {
          rejectOnce(error);
        }
      });
      response.on('error', error => rejectOnce(normalizeNetworkFailure(error)));
    });
    request.on('timeout', () => request.destroy(new Error('request_timeout')));
    request.on('error', error => rejectOnce(normalizeNetworkFailure(error)));
    request.end(serialized);
  });
}

function normalizeHttpError(response, nowMs) {
  const bodyError = response && response.body && response.body.error;
  const code = bodyError && typeof bodyError.code === 'string' ? bodyError.code : `http_${response.statusCode}`;
  const message = bodyError && typeof bodyError.message === 'string'
    ? bodyError.message
    : 'Command service rejected the request';
  const retryAfterHeader = response.headers && (response.headers['retry-after'] || response.headers['Retry-After']);
  return new ControlPlaneRequestError(code, message, {
    statusCode: response.statusCode,
    retryable: RETRYABLE_STATUS_CODES.has(response.statusCode) || Boolean(bodyError && bodyError.retryable),
    reviewRequired: Boolean(bodyError && bodyError.review_required),
    retryAfterMs: parseRetryAfter(retryAfterHeader, nowMs)
  });
}

class OrderControlPlaneClient {
  constructor(options = {}) {
    this.baseUrl = normalizeControlPlaneBaseUrl(options.baseUrl);
    this.machineCode = String(options.machineCode || '');
    this.executorVersion = String(options.executorVersion || '');
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.random = typeof options.random === 'function' ? options.random : Math.random;
    this.sleep = typeof options.sleep === 'function' ? options.sleep : ms => new Promise(resolve => setTimeout(resolve, ms));
    this.getSessionToken = typeof options.getSessionToken === 'function' ? options.getSessionToken : () => '';
    this.transport = options.transport || (this.baseUrl ? createHttpsJsonTransport({ baseUrl: this.baseUrl }) : null);
  }

  isConfigured() {
    return Boolean(this.baseUrl && this.transport);
  }

  getStatus() {
    return {
      configured: this.isConfigured(),
      authenticated: Boolean(String(this.getSessionToken() || '').trim())
    };
  }

  _assertConfigured() {
    if (!this.isConfigured()) {
      throw new ControlPlaneRequestError('central_service_not_configured', 'Command service URL is not configured');
    }
  }

  async _send(path, body, options = {}) {
    this._assertConfigured();
    const sessionToken = options.authenticated === true ? String(this.getSessionToken() || '').trim() : '';
    if (options.authenticated === true && !sessionToken) {
      throw new ControlPlaneRequestError('executor_not_authenticated', 'Cloud Warehouse Assistant login session is unavailable');
    }
    let attempt = 0;
    while (true) {
      let response;
      try {
        response = await this.transport({
          baseUrl: this.baseUrl,
          path,
          body,
          sessionToken,
          signal: options.signal
        });
      } catch (error) {
        const normalized = error instanceof ControlPlaneRequestError
          ? error
          : new ControlPlaneRequestError('network_error', 'Command service network request failed', { retryable: true });
        if (options.retry === true && normalized.retryable && attempt < DEFAULT_BACKOFF_MS.length) {
          await this._backoff(normalized.retryAfterMs, attempt++);
          continue;
        }
        throw normalized;
      }
      if (response.statusCode >= 200 && response.statusCode < 300) return response.body;
      const error = normalizeHttpError(response, this.now());
      if (options.retry === true && error.retryable && attempt < DEFAULT_BACKOFF_MS.length) {
        await this._backoff(error.retryAfterMs, attempt++);
        continue;
      }
      throw error;
    }
  }

  async _backoff(retryAfterMs, attempt) {
    const base = retryAfterMs || DEFAULT_BACKOFF_MS[Math.min(attempt, DEFAULT_BACKOFF_MS.length - 1)];
    const jitter = Math.floor(Math.max(0, Math.min(1, this.random())) * Math.min(500, Math.ceil(base / 4)));
    await this.sleep(base + jitter);
  }

  async waitForCommand(input = {}) {
    const body = buildWaitRequest({
      machineCode: this.machineCode,
      capabilities: input.capabilities,
      waitSeconds: input.waitSeconds === undefined ? 25 : input.waitSeconds
    });
    return validateWaitResponse(
      await this._send(CONTROL_PLANE_PATHS.wait, body, {
        authenticated: true,
        retry: false,
        signal: input.signal
      }),
      this.machineCode,
      this.now()
    );
  }

  async reportResult(task, response) {
    if (!task || task.task_id !== response.task_id) {
      throw new ControlPlaneProtocolError('task_id_mismatch', 'Result does not belong to the supplied task');
    }
    const body = buildResultRequest({ machineCode: this.machineCode, response });
    return validateResultResponse(
      await this._send(CONTROL_PLANE_PATHS.commandResult(task.task_id), body, {
        authenticated: true,
        retry: true
      }),
      task.task_id
    );
  }
}

module.exports = {
  DEFAULT_BACKOFF_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  ControlPlaneRequestError,
  OrderControlPlaneClient,
  createHttpsJsonTransport,
  normalizeHttpError,
  parseResponseBody,
  parseRetryAfter
};
