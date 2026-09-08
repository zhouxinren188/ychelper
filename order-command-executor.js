'use strict';

const crypto = require('crypto');
const {
  PROTOCOL_VERSION,
  COMMAND_DEFINITIONS,
  OrderCommandProtocolError,
  getCommandDefinition,
  isPlainObject,
  sanitizeResult,
  validateTaskEnvelope
} = require('./order-command-protocol');

const STATE_VERSION = 2;
const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RECEIPTS = 500;
const DEFAULT_MAX_AUDIT_EVENTS = 1000;

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

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function makeTaskFingerprint(task) {
  return sha256(stableStringify({
    protocol_version: task.protocol_version,
    task_id: task.task_id,
    trace_id: task.trace_id,
    command: task.command,
    order_id: task.order_id,
    idempotency_key: task.idempotency_key,
    created_at: task.created_at,
    expires_at: task.expires_at,
    requested_by: task.requested_by,
    target: task.target,
    confirmation: task.confirmation || null,
    params: task.params || {}
  }));
}

function makeReceiptId(machineCode, idempotencyKey) {
  if (!idempotencyKey) return '';
  return `receipt-${sha256(`${machineCode}:${idempotencyKey}`).slice(0, 24)}`;
}

function defaultState() {
  return {
    version: STATE_VERSION,
    receipts: {},
    receipt_order: [],
    locks: {},
    audit: []
  };
}

function normalizeAdapterValidation(result) {
  if (result === true || result === undefined) return { valid: true };
  if (result === false) return { valid: false, message: '命令参数未通过适配器校验' };
  if (result && typeof result === 'object') {
    return {
      valid: result.valid === true,
      message: String(result.message || '命令参数未通过适配器校验')
    };
  }
  return { valid: false, message: '适配器参数校验返回值无效' };
}

class OrderCommandExecutor {
  constructor(options = {}) {
    if (typeof options.loadState !== 'function' || typeof options.saveState !== 'function') {
      throw new Error('OrderCommandExecutor 需要 loadState/saveState 持久化适配器');
    }
    if (!options.machineCode) {
      throw new Error('OrderCommandExecutor 需要 machineCode');
    }

    this.machineCode = String(options.machineCode);
    this.loadState = options.loadState;
    this.saveState = options.saveState;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.logger = options.logger || console;
    this.maxReceipts = options.maxReceipts || DEFAULT_MAX_RECEIPTS;
    this.maxAuditEvents = options.maxAuditEvents || DEFAULT_MAX_AUDIT_EVENTS;
    this.lockTtlMs = options.lockTtlMs || DEFAULT_LOCK_TTL_MS;
    this.adapters = new Map();
    this.activeLocks = new Set();
    this.state = this._loadAndRecoverState();
  }

  _loadAndRecoverState() {
    let loaded;
    try {
      loaded = this.loadState();
    } catch (error) {
      throw new Error(`读取订单执行状态失败: ${error.message}`);
    }
    if (loaded === null || loaded === undefined) return defaultState();
    const state = loaded && typeof loaded === 'object' ? cloneJson(loaded) : null;
    if (!state || state.version !== STATE_VERSION || !isPlainObject(state.receipts) ||
        !isPlainObject(state.locks) || !Array.isArray(state.audit)) {
      throw new Error('订单执行状态损坏，为避免写操作重复执行，执行端已安全停用');
    }
    if (!Array.isArray(state.receipt_order)) state.receipt_order = Object.keys(state.receipts);

    const nowMs = this.now();
    let changed = false;
    for (const [orderId, lock] of Object.entries(state.locks)) {
      if (!lock || Date.parse(lock.expires_at) <= nowMs) {
        delete state.locks[orderId];
        changed = true;
      }
    }
    for (const [key, receipt] of Object.entries(state.receipts)) {
      if (!receipt || receipt.status !== 'executing') continue;
      const definition = getCommandDefinition(receipt.command);
      if (definition && definition.mode === 'write') {
        receipt.status = 'review_required';
        receipt.response = this._buildResponse(receipt.task || {
          task_id: receipt.task_id,
          trace_id: receipt.trace_id,
          command: receipt.command,
          order_id: receipt.order_id,
          idempotency_key: key
        }, 'review_required', {
          reason: 'interrupted_execution',
          message: '上次写操作在结果确认前中断，禁止自动重试，请人工复核',
          received: true,
          executed: true,
          businessConfirmed: false
        });
        receipt.completed_at = new Date(nowMs).toISOString();
      } else {
        delete state.receipts[key];
        state.receipt_order = state.receipt_order.filter(item => item !== key);
      }
      changed = true;
    }
    if (changed) this._saveState(state);
    return state;
  }

  _saveState(state = this.state) {
    this.saveState(cloneJson(state));
  }

  _nowIso() {
    return new Date(this.now()).toISOString();
  }

  _appendAudit(task, event, details = {}) {
    const entry = {
      at: this._nowIso(),
      event,
      task_id: task.task_id || '',
      trace_id: task.trace_id || '',
      command: task.command || '',
      order_id: task.order_id || '',
      receipt_id: makeReceiptId(this.machineCode, task.idempotency_key),
      idempotency_key_hash: task.idempotency_key ? sha256(task.idempotency_key).slice(0, 16) : '',
      status: details.status || '',
      reason: details.reason || ''
    };
    if (details.result !== undefined) {
      entry.result_hash = sha256(stableStringify(sanitizeResult(details.result)));
    }
    this.state.audit.push(entry);
    if (this.state.audit.length > this.maxAuditEvents) {
      this.state.audit.splice(0, this.state.audit.length - this.maxAuditEvents);
    }
  }

  _normalizeVerification(task, verification, observedAt) {
    const definition = getCommandDefinition(task.command);
    const expectedStatus = definition && definition.successStates && definition.successStates[0];
    if (!expectedStatus && verification === undefined) return null;

    const sanitized = verification === undefined ? null : sanitizeResult(verification);
    const normalized = isPlainObject(sanitized)
      ? { ...sanitized }
      : sanitized === null
      ? {}
      : { details: sanitized };
    if (expectedStatus) {
      normalized.expected_status = expectedStatus;
      if (!Object.prototype.hasOwnProperty.call(normalized, 'observed_status')) {
        normalized.observed_status = null;
      }
      normalized.observed_at = observedAt || null;
    }
    return normalized;
  }

  _buildResponse(task, status, details = {}) {
    const sanitizedMessage = sanitizeResult(String(details.message || ''));
    return {
      protocol_version: PROTOCOL_VERSION,
      task_id: task.task_id || '',
      trace_id: task.trace_id || '',
      command: task.command || '',
      order_id: task.order_id || '',
      idempotency_key: task.idempotency_key || '',
      status,
      reason: details.reason || '',
      message: typeof sanitizedMessage === 'string' ? sanitizedMessage : '',
      delivery: {
        received: details.received !== false,
        executed: details.executed === true,
        replayed: details.replayed === true,
        receipt_id: makeReceiptId(this.machineCode, task.idempotency_key),
        business_confirmed: details.businessConfirmed === true
      },
      result: details.result === undefined
        ? null
        : sanitizeResult(
            details.result,
            task.command === 'warehouse.order.check' ? { maxArrayItems: 3000 } : {}
          ),
      verification: this._normalizeVerification(task, details.verification, details.verificationObservedAt),
      executor: {
        machine_code: this.machineCode
      },
      completed_at: this._nowIso()
    };
  }

  _rememberReceipt(task, fingerprint, status, response) {
    const key = task.idempotency_key;
    if (!this.state.receipts[key]) this.state.receipt_order.push(key);
    this.state.receipts[key] = {
      status,
      fingerprint,
      receipt_id: response.delivery.receipt_id,
      task_id: task.task_id,
      trace_id: task.trace_id,
      command: task.command,
      order_id: task.order_id,
      task: {
        task_id: task.task_id,
        trace_id: task.trace_id,
        command: task.command,
        order_id: task.order_id,
        idempotency_key: task.idempotency_key
      },
      response: cloneJson(response),
      completed_at: status === 'executing' ? '' : this._nowIso()
    };
    while (this.state.receipt_order.length > this.maxReceipts) {
      const readReceiptIndex = this.state.receipt_order.findIndex(receiptKey => {
        const receipt = this.state.receipts[receiptKey];
        const definition = receipt && getCommandDefinition(receipt.command);
        return definition && definition.mode === 'read';
      });
      if (readReceiptIndex < 0) break;
      const [oldestReadReceipt] = this.state.receipt_order.splice(readReceiptIndex, 1);
      delete this.state.receipts[oldestReadReceipt];
    }
  }

  _persistTerminal(task, fingerprint, response) {
    this._rememberReceipt(task, fingerprint, response.status, response);
    this._appendAudit(task, 'task_completed', {
      status: response.status,
      reason: response.reason,
      result: response.result
    });
    this._saveState();
    return response;
  }

  _acquireLock(task) {
    const nowMs = this.now();
    if (this.activeLocks.has(task.order_id)) return false;
    const existing = this.state.locks[task.order_id];
    if (existing && Date.parse(existing.expires_at) > nowMs) return false;
    this.state.locks[task.order_id] = {
      task_id: task.task_id,
      command: task.command,
      acquired_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + this.lockTtlMs).toISOString()
    };
    this.activeLocks.add(task.order_id);
    try {
      this._saveState();
    } catch (error) {
      this.activeLocks.delete(task.order_id);
      delete this.state.locks[task.order_id];
      throw error;
    }
    return true;
  }

  _releaseLock(task) {
    const existing = this.state.locks[task.order_id];
    if (existing && existing.task_id === task.task_id) {
      delete this.state.locks[task.order_id];
    }
    this.activeLocks.delete(task.order_id);
    this._saveState();
  }

  registerAdapter(command, adapter) {
    const definition = COMMAND_DEFINITIONS[command];
    if (!definition) throw new Error(`不能为非白名单命令注册适配器: ${command}`);
    if (!adapter || typeof adapter.validateParams !== 'function' || typeof adapter.execute !== 'function') {
      throw new Error(`${command} 适配器必须实现 validateParams 和 execute`);
    }
    if (definition.mode === 'write' &&
        (typeof adapter.preflight !== 'function' || typeof adapter.verify !== 'function')) {
      throw new Error(`${command} 写命令适配器必须实现 preflight 和 verify`);
    }
    this.adapters.set(command, Object.freeze({ ...adapter }));
  }

  unregisterAdapter(command) {
    this.adapters.delete(command);
  }

  getCapabilities() {
    return Object.keys(COMMAND_DEFINITIONS).map(command => {
      const definition = COMMAND_DEFINITIONS[command];
      return {
        command,
        enabled: this.adapters.has(command),
        mode: definition.mode,
        max_ttl_ms: definition.maxTtlMs,
        requires_confirmation: definition.requiresConfirmation,
        expected_status: definition.successStates ? definition.successStates[0] : null
      };
    });
  }

  getAuditSnapshot() {
    return cloneJson(this.state.audit);
  }

  async executeTask(task, context = {}) {
    let validated;
    try {
      validated = validateTaskEnvelope(task, {
        nowMs: this.now(),
        expectedMachineCode: this.machineCode
      });
    } catch (error) {
      const reason = error instanceof OrderCommandProtocolError ? error.code : 'invalid_task';
      return this._buildResponse(task && typeof task === 'object' ? task : {}, 'refused', {
        reason,
        message: error.message,
        received: false,
        executed: false,
        businessConfirmed: false
      });
    }

    const fingerprint = makeTaskFingerprint(task);
    const previous = this.state.receipts[task.idempotency_key];
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        const collision = this._buildResponse(task, 'review_required', {
          reason: 'idempotency_key_collision',
          message: '幂等键已被不同任务内容使用，禁止执行',
          executed: false,
          businessConfirmed: false
        });
        this._appendAudit(task, 'idempotency_collision', {
          status: collision.status,
          reason: collision.reason
        });
        this._saveState();
        return collision;
      }
      const duplicate = cloneJson(previous.response);
      duplicate.duplicate = true;
      duplicate.delivery.replayed = true;
      duplicate.original_completed_at = previous.completed_at || duplicate.completed_at;
      duplicate.replayed_at = this._nowIso();
      this._appendAudit(task, 'duplicate_replayed', {
        status: duplicate.status,
        reason: duplicate.reason
      });
      this._saveState();
      return duplicate;
    }

    const adapter = this.adapters.get(task.command);
    if (!adapter) {
      const unavailable = this._buildResponse(task, 'refused', {
        reason: 'capability_unavailable',
        message: '该命令尚未接入经过校验的本机业务适配器',
        executed: false,
        businessConfirmed: false
      });
      return this._persistTerminal(task, fingerprint, unavailable);
    }

    let parameterValidation;
    try {
      parameterValidation = normalizeAdapterValidation(adapter.validateParams(validated.params));
    } catch (error) {
      parameterValidation = { valid: false, message: error.message };
    }
    if (!parameterValidation.valid) {
      const invalidParams = this._buildResponse(task, 'refused', {
        reason: 'adapter_params_invalid',
        message: parameterValidation.message,
        executed: false,
        businessConfirmed: false
      });
      return this._persistTerminal(task, fingerprint, invalidParams);
    }

    let lockAcquired = false;
    if (validated.definition.mode === 'write') {
      try {
        lockAcquired = this._acquireLock(task);
      } catch (error) {
        return this._buildResponse(task, 'refused', {
          reason: 'persistence_unavailable',
          message: `无法持久化订单锁: ${error.message}`,
          executed: false,
          businessConfirmed: false
        });
      }
      if (!lockAcquired) {
        const locked = this._buildResponse(task, 'refused', {
          reason: 'order_locked',
          message: '同一订单已有写操作正在执行',
          executed: false,
          businessConfirmed: false
        });
        this._appendAudit(task, 'order_lock_refused', {
          status: locked.status,
          reason: locked.reason
        });
        this._saveState();
        return locked;
      }
    }

    this._appendAudit(task, 'task_received', { status: 'accepted' });
    try {
      if (validated.definition.mode === 'write') {
        let preflight;
        try {
          preflight = await adapter.preflight(cloneJson(validated.params), cloneJson(task), context);
        } catch (error) {
          const failed = this._buildResponse(task, 'refused', {
            reason: 'preflight_failed',
            message: error.message,
            executed: false,
            businessConfirmed: false
          });
          return this._persistTerminal(task, fingerprint, failed);
        }
        if (!preflight || preflight.ok !== true) {
          const blocked = this._buildResponse(task, 'refused', {
            reason: 'precondition_not_met',
            message: preflight && preflight.message ? String(preflight.message) : '执行前状态复验未通过',
            result: preflight || null,
            executed: false,
            businessConfirmed: false
          });
          return this._persistTerminal(task, fingerprint, blocked);
        }

        const executingResponse = this._buildResponse(task, 'executing', {
          reason: 'execution_started',
          message: '写操作已开始，正在等待业务状态复验',
          executed: false,
          businessConfirmed: false
        });
        this._rememberReceipt(task, fingerprint, 'executing', executingResponse);
        this._appendAudit(task, 'write_execution_started', { status: 'executing' });
        this._saveState();
      }

      try {
        if (context && typeof context.assertLeaseValid === 'function') {
          await context.assertLeaseValid('before_execute');
        }
      } catch (error) {
        const leaseBlocked = this._buildResponse(task, 'refused', {
          reason: error && error.code ? String(error.code) : 'lease_lost',
          message: error.message,
          executed: false,
          businessConfirmed: false
        });
        return this._persistTerminal(task, fingerprint, leaseBlocked);
      }

      let executionResult;
      try {
        executionResult = await adapter.execute(cloneJson(validated.params), cloneJson(task), context);
      } catch (error) {
        const uncertain = validated.definition.mode === 'write';
        const merchantSessionExpired = !uncertain &&
          error && error.code === 'merchant_session_expired';
        const exceptionQueryTimedOut = !uncertain &&
          error && error.code === 'exception_query_timeout';
        const warehouseSessionExpired = !uncertain &&
          error && error.code === 'warehouse_session_expired';
        const failed = this._buildResponse(task, uncertain ? 'review_required' : 'failed', {
          reason: uncertain
            ? 'execution_result_unknown'
            : merchantSessionExpired
            ? 'merchant_session_expired'
            : exceptionQueryTimedOut
            ? 'exception_query_timeout'
            : warehouseSessionExpired
            ? 'warehouse_session_expired'
            : 'execution_failed',
          message: merchantSessionExpired
            ? '云仓助手商家登录已失效，请在绑定机器码的云仓助手重新登录后再试'
            : exceptionQueryTimedOut
            ? '云仓异常订单查询超时，请稍后重试'
            : warehouseSessionExpired
            ? '云仓助手 WMS 登录已失效，请在绑定机器码的云仓助手重新登录并进入仓库后再试'
            : uncertain
            ? `写操作调用异常，实际结果未知，禁止自动重试: ${error.message}`
            : error.message,
          executed: uncertain,
          businessConfirmed: false
        });
        return this._persistTerminal(task, fingerprint, failed);
      }

      if (validated.definition.mode === 'read') {
        try {
          if (context && typeof context.assertLeaseValid === 'function') {
            await context.assertLeaseValid('after_execute');
          }
        } catch (error) {
          const leaseLost = this._buildResponse(task, 'failed', {
            reason: 'lease_lost',
            message: error.message,
            result: executionResult,
            executed: true,
            businessConfirmed: false
          });
          return this._persistTerminal(task, fingerprint, leaseLost);
        }
        const successMessage = task.command === 'exception.order.check' && executionResult
          ? executionResult.state === 'exception_found'
            ? '查询到异常订单'
            : executionResult.state === 'no_exception'
            ? '暂无异常订单'
            : ''
          : task.command === 'warehouse.order.check' && executionResult
          ? Array.isArray(executionResult.orders)
            ? `查询到 ${executionResult.orders.length} 条待打印订单`
            : executionResult.exists === true
            ? '订单存在'
            : executionResult.exists === false
            ? '无此订单'
            : ''
          : '';
        const success = this._buildResponse(task, 'succeeded', {
          reason: 'query_completed',
          message: '只读查询已完成',
          ...(successMessage ? { message: successMessage } : {}),
          result: executionResult,
          executed: true,
          businessConfirmed: true
        });
        return this._persistTerminal(task, fingerprint, success);
      }

      let verification;
      const verificationObservedAt = this._nowIso();
      try {
        if (context && typeof context.assertLeaseValid === 'function') {
          await context.assertLeaseValid('before_verify');
        }
        verification = await adapter.verify(
          cloneJson(validated.params),
          cloneJson(executionResult),
          cloneJson(task),
          context
        );
      } catch (error) {
        verification = { confirmed: false, message: error.message, verification_error: true };
      }

      try {
        if (context && typeof context.assertLeaseValid === 'function') {
          await context.assertLeaseValid('after_verify');
        }
      } catch (error) {
        const leaseLost = this._buildResponse(task, 'review_required', {
          reason: error && error.code ? String(error.code) : 'lease_lost',
          message: `写操作已调用，但租约在结果确认前失效，禁止自动重试: ${error.message}`,
          result: executionResult,
          verification,
          verificationObservedAt,
          executed: true,
          businessConfirmed: false
        });
        return this._persistTerminal(task, fingerprint, leaseLost);
      }

      const observedStatus = verification && verification.observed_status;
      const successStates = validated.definition.successStates || [];
      if (!verification || verification.confirmed !== true || !successStates.includes(observedStatus)) {
        const unexpectedState = verification && verification.confirmed === true && !successStates.includes(observedStatus);
        const review = this._buildResponse(task, 'review_required', {
          reason: unexpectedState ? 'unexpected_business_state' : 'business_state_unconfirmed',
          message: unexpectedState
            ? `写后状态 ${String(observedStatus || '(空)')} 不符合命令成功条件`
            : verification && verification.message
            ? String(verification.message)
            : '写操作已调用，但业务状态尚未确认，禁止自动重试',
          result: executionResult,
          verification,
          verificationObservedAt,
          executed: true,
          businessConfirmed: false
        });
        return this._persistTerminal(task, fingerprint, review);
      }

      const success = this._buildResponse(task, 'succeeded', {
        reason: 'business_state_confirmed',
        message: '写操作及业务状态复验均已完成',
        result: executionResult,
        verification,
        verificationObservedAt,
        executed: true,
        businessConfirmed: true
      });
      return this._persistTerminal(task, fingerprint, success);
    } finally {
      if (lockAcquired) {
        try {
          this._releaseLock(task);
        } catch (error) {
          this.logger.error('[OrderExecutor] 释放订单锁失败:', error.message);
        }
      }
    }
  }
}

module.exports = {
  OrderCommandExecutor,
  makeReceiptId,
  makeTaskFingerprint
};
