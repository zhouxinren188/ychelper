'use strict';

const { isPlainObject } = require('./order-command-protocol');
const { SNAPSHOT_REF_PATTERN } = require('./order-exception-snapshot-store');

const EXCEPTION_CHECK_COMMAND = 'exception.order.check';
const EXCEPTION_RESOLVE_COMMAND = 'exception.order.resolve';
const ORDER_NO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

function normalizeExternalLocator(params) {
  const orderNo = String(params && params.order_no || '').trim();
  const orderYear = Number(params && params.order_year);
  if (!ORDER_NO_PATTERN.test(orderNo)) throw new Error('order_no format is invalid');
  if (!Number.isInteger(orderYear) || orderYear < 2000 || orderYear > 2100) {
    throw new Error('order_year must be a four-digit year');
  }
  return { platform_order_no: orderNo, order_year: orderYear };
}

function validateCheckParams(params) {
  if (!isPlainObject(params) || Object.keys(params).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(params, 'order_no') ||
      !Object.prototype.hasOwnProperty.call(params, 'order_year')) {
    return {
      valid: false,
      message: '异常查询参数必须且只能包含订单号 order_no 和年份 order_year'
    };
  }
  try {
    normalizeExternalLocator(params);
  } catch (error) {
    return { valid: false, message: error.message };
  }
  return { valid: true };
}

function validateResolveParams(params) {
  if (!isPlainObject(params) || Object.keys(params).length !== 3 ||
      !Object.prototype.hasOwnProperty.call(params, 'order_no') ||
      !Object.prototype.hasOwnProperty.call(params, 'order_year') ||
      !SNAPSHOT_REF_PATTERN.test(String(params.exception_snapshot_ref || ''))) {
    return {
      valid: false,
      message: '异常处理参数必须且只能包含 order_no、order_year 和有效 exception_snapshot_ref'
    };
  }
  try {
    normalizeExternalLocator(params);
  } catch (error) {
    return { valid: false, message: error.message };
  }
  return { valid: true };
}

function assertService(services, name) {
  if (!services || typeof services[name] !== 'function') {
    throw new Error(`异常订单适配器缺少 ${name} 服务`);
  }
}

function normalizeSnapshot(snapshot) {
  if (!isPlainObject(snapshot) || !Array.isArray(snapshot.records)) {
    throw new Error('异常订单查询服务返回格式无效');
  }
  return {
    pending: snapshot.records.length > 0,
    records: snapshot.records,
    queried_at: typeof snapshot.queried_at === 'string'
      ? snapshot.queried_at
      : new Date().toISOString()
  };
}

function summarizeSnapshot(snapshot, exceptionSnapshotRef = '') {
  const normalized = normalizeSnapshot(snapshot);
  const sourceCounts = Object.create(null);
  for (const record of normalized.records) {
    const source = record && typeof record.source === 'string' && record.source
      ? record.source
      : 'unknown';
    sourceCounts[source] = (sourceCounts[source] || 0) + 1;
  }
  return {
    state: normalized.pending ? 'exception_found' : 'waiting_arrival',
    exception_count: normalized.records.length,
    source_counts: sourceCounts,
    exception_snapshot_ref: exceptionSnapshotRef,
    queried_at: normalized.queried_at
  };
}

function normalizePublicExceptionSource(source) {
  if (source === 'billexception' || source === 'bill_exception') return 'billexception';
  if (source === 'soExceptionCentre' || source === 'so_exception') return 'soExceptionCentre';
  throw new Error('异常订单查询返回了未声明的异常来源');
}

function maskPublicExceptionText(value) {
  let text = value === undefined || value === null ? '' : String(value).trim();
  if (!text) return '';
  text = text
    .replace(/https?:\/\/\S+/gi, '[链接已隐藏]')
    .replace(/([A-Z0-9._%+-])[A-Z0-9._%+-]*@([A-Z0-9.-]+\.[A-Z]{2,})/gi, '$1***@$2')
    .replace(/(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g, '$1****$2')
    .replace(/(?<!\d)(\d{2})\d{3,}(\d{2})(?!\d)/g, '$1***$2');
  return text.length > 256 ? `${text.slice(0, 256)}...[已截断]` : text;
}

function buildPublicExceptionRecords(records) {
  return records.map(record => ({
    source: normalizePublicExceptionSource(record && record.source),
    exception_type_masked: maskPublicExceptionText(record && record.exception_type),
    reason_masked: maskPublicExceptionText(record && record.exception_description),
    solution_masked: maskPublicExceptionText(record && record.handler_action)
  }));
}

function locatorsMatch(left, right) {
  return isPlainObject(left) && isPlainObject(right) &&
    String(left.platform_order_no || '') === String(right.platform_order_no || '') &&
    String(left.order_year || '') === String(right.order_year || '');
}

function createExceptionOrderAdapters(services = {}) {
  assertService(services, 'queryExceptionRecords');
  assertService(services, 'resolveExceptionRecords');
  assertService(services, 'createExceptionSnapshot');
  assertService(services, 'getExceptionSnapshot');
  assertService(services, 'assertExceptionSnapshotRecords');
  assertService(services, 'claimExceptionSnapshot');

  const writeLocators = new Map();

  const resolveLocator = params => normalizeExternalLocator(params);

  const loadSnapshot = async (locator, task, context) => {
    const snapshot = normalizeSnapshot(await services.queryExceptionRecords(locator, task, context));
    return { locator, snapshot };
  };

  return {
    [EXCEPTION_CHECK_COMMAND]: {
      validateParams: validateCheckParams,
      async execute(params, task, context) {
        const locator = resolveLocator(params);
        const { snapshot } = await loadSnapshot(locator, task, context);
        let exceptionSnapshotRef = '';
        if (snapshot.pending) {
          const persisted = await services.createExceptionSnapshot({
            orderId: task.order_id,
            locator,
            records: snapshot.records,
            task,
            context
          });
          exceptionSnapshotRef = persisted && persisted.snapshot_ref ? persisted.snapshot_ref : '';
          if (!SNAPSHOT_REF_PATTERN.test(exceptionSnapshotRef)) {
            throw new Error('异常快照持久化未返回有效 exception_snapshot_ref');
          }
        }
        const summary = summarizeSnapshot(snapshot, exceptionSnapshotRef);
        return {
          state: summary.exception_count > 0 ? 'exception_found' : 'no_exception',
          exception_snapshot_ref: summary.exception_snapshot_ref,
          exception_count: summary.exception_count,
          queried_at: summary.queried_at,
          exceptions: buildPublicExceptionRecords(snapshot.records)
        };
      }
    },
    [EXCEPTION_RESOLVE_COMMAND]: {
      validateParams: validateResolveParams,
      async preflight(params, task, context) {
        try {
          const persisted = await services.getExceptionSnapshot(params.exception_snapshot_ref, {
            orderId: task.order_id,
            task,
            context
          });
          const currentLocator = resolveLocator(params);
          if (!locatorsMatch(currentLocator, persisted.locator)) {
            return {
              ok: false,
              reason: 'order_locator_changed',
              message: '订单定位信息已变化，请重新查询并确认异常快照'
            };
          }
          const current = await loadSnapshot(currentLocator, task, context);
          await services.assertExceptionSnapshotRecords(
            params.exception_snapshot_ref,
            current.snapshot.records,
            { orderId: task.order_id, task, context }
          );
          if (!current.snapshot.pending) {
            return {
              ok: false,
              reason: 'exception_not_found',
              message: '执行前复验未发现快照中的待处理异常，禁止发起写操作',
              ...summarizeSnapshot(current.snapshot)
            };
          }
          writeLocators.set(task.task_id, {
            locator: currentLocator,
            snapshot_ref: params.exception_snapshot_ref
          });
          return {
            ok: true,
            ...summarizeSnapshot(current.snapshot, params.exception_snapshot_ref)
          };
        } catch (error) {
          return {
            ok: false,
            reason: error && error.code ? String(error.code) : 'snapshot_precondition_failed',
            message: error && error.message ? String(error.message) : '异常快照前置校验失败'
          };
        }
      },
      async execute(params, task, context) {
        // 写入前再次查询；内部异常标识只来自本机快照和实时查询，永不返回中央服务。
        const prepared = writeLocators.get(task.task_id);
        if (!prepared || prepared.snapshot_ref !== params.exception_snapshot_ref) {
          throw new Error('执行前异常快照状态丢失，禁止发起写操作');
        }
        try {
          const { snapshot } = await loadSnapshot(prepared.locator, task, context);
          await services.assertExceptionSnapshotRecords(
            prepared.snapshot_ref,
            snapshot.records,
            { orderId: task.order_id, task, context }
          );
          if (!snapshot.pending) {
            throw new Error('执行前最终复验未发现待处理异常，禁止发起写操作');
          }
          // 在首次业务写入前将快照持久标记为已使用，后续任何重试都会被拒绝。
          await services.claimExceptionSnapshot(prepared.snapshot_ref, {
            orderId: task.order_id,
            taskId: task.task_id,
            task,
            context
          });
          prepared.claimed = true;
          const result = await services.resolveExceptionRecords(prepared.locator, snapshot.records, task, context);
          if (!isPlainObject(result) || result.all_succeeded !== true) {
            throw new Error(result && result.message
              ? String(result.message)
              : '异常订单处理未全部成功，禁止自动重试，请人工复核');
          }
          return {
            attempted: true,
            processed_count: Number.isInteger(result.processed_count) ? result.processed_count : snapshot.records.length
          };
        } catch (error) {
          writeLocators.delete(task.task_id);
          throw error;
        }
      },
      async verify(params, executionResult, task, context) {
        const prepared = writeLocators.get(task.task_id);
        if (!prepared || prepared.snapshot_ref !== params.exception_snapshot_ref) {
          throw new Error('写后异常快照状态丢失，无法确认处理结果');
        }
        try {
          const { snapshot } = await loadSnapshot(prepared.locator, task, context);
          const summary = summarizeSnapshot(snapshot);
          return {
            confirmed: snapshot.pending === false,
            observed_status: snapshot.pending ? 'exception_found' : 'waiting_arrival',
            exception_count: summary.exception_count,
            source_counts: summary.source_counts,
            message: snapshot.pending ? '写后仍查询到待处理异常，需要人工复核' : '写后复验已无待处理异常'
          };
        } finally {
          writeLocators.delete(task.task_id);
        }
      }
    }
  };
}

function registerExceptionOrderAdapters(executor, services) {
  if (!executor || typeof executor.registerAdapter !== 'function') {
    throw new Error('异常订单适配器需要有效的命令执行器');
  }
  const adapters = createExceptionOrderAdapters(services);
  executor.registerAdapter(EXCEPTION_CHECK_COMMAND, adapters[EXCEPTION_CHECK_COMMAND]);
  executor.registerAdapter(EXCEPTION_RESOLVE_COMMAND, adapters[EXCEPTION_RESOLVE_COMMAND]);
  return adapters;
}

module.exports = {
  EXCEPTION_CHECK_COMMAND,
  EXCEPTION_RESOLVE_COMMAND,
  buildPublicExceptionRecords,
  createExceptionOrderAdapters,
  locatorsMatch,
  maskPublicExceptionText,
  normalizeExternalLocator,
  normalizeSnapshot,
  normalizePublicExceptionSource,
  registerExceptionOrderAdapters,
  summarizeSnapshot,
  validateCheckParams,
  validateResolveParams
};
