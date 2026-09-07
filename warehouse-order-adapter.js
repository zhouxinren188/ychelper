'use strict';

const WAREHOUSE_ORDER_CHECK_COMMAND = 'warehouse.order.check';
const OUTBOUND_ORDER_LIST_API = '/jwms/outbound/orderCenter/list';
const OUTBOUND_ORDER_LOP_DN = 'ext.jwms.web';
const OUTBOUND_ORDER_STATUSES = Object.freeze(['10', '30']);
const OUTBOUND_ORDER_REPRINT_STATUSES = Object.freeze(['10', '20', '30', '40', '50', '60', '70']);
const OUTBOUND_ORDER_PAGE_SIZE = 100;
// Each WMS request has a 15 second ceiling. Keep the complete scan bounded well
// inside the command's 10 minute TTL; an incomplete scan must fail, never report
// that the order is absent.
const OUTBOUND_ORDER_MAX_PAGES = 30;
const ORDER_NO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateWarehouseOrderParams(params) {
  if (!isPlainObject(params)) {
    return { valid: false, message: '查询参数格式无效' };
  }
  const allowedKeys = new Set(['order_no', 'order_year']);
  if (Object.keys(params).some(key => !allowedKeys.has(key))) {
    return { valid: false, message: '查询参数包含未声明字段' };
  }
  const orderNo = String(params.order_no || '').trim();
  const orderYear = Number(params.order_year);
  if (!ORDER_NO_PATTERN.test(orderNo)) {
    return { valid: false, message: '订单号格式无效' };
  }
  if (!Number.isInteger(orderYear) || orderYear < 2000 || orderYear > 2100) {
    return { valid: false, message: '订单年份格式无效' };
  }
  return { valid: true, orderNo, orderYear };
}

function normalizeOutboundOrderStatuses(currentStatuses) {
  if (currentStatuses === undefined) return [...OUTBOUND_ORDER_STATUSES];
  if (!Array.isArray(currentStatuses)) {
    throw new Error('WMS 出库订单状态范围无效');
  }
  const normalized = [...new Set(
    currentStatuses.map(value => String(value || '').trim()).filter(value => /^\d{1,3}$/.test(value))
  )];
  if (normalized.length === 0 || normalized.length !== currentStatuses.length) {
    throw new Error('WMS 出库订单状态范围无效');
  }
  return normalized;
}

function buildOutboundOrderListPayload({ orderYear, warehouseNo, pageNum, currentStatuses }) {
  return {
    skuRelation: 'include',
    zoneQueryType: 'include',
    aisleQueryType: 'include',
    brandNameQueryType: 'include',
    currentStatus: normalizeOutboundOrderStatuses(currentStatuses),
    createTime: [
      `${orderYear}-01-01 00:00:00`,
      `${orderYear}-12-31 23:59:59`
    ],
    querySkuShortName: true,
    pageNum,
    pageSize: OUTBOUND_ORDER_PAGE_SIZE,
    extendFields: { holdFlag: false },
    probe_anchor_warehouseNo: String(warehouseNo || '').trim()
  };
}

function assertOutboundOrderPage(data) {
  if (!isPlainObject(data) || data.success !== true || !isPlainObject(data.resultValue)) {
    const error = new Error('WMS 出库订单查询返回失败');
    error.code = 'warehouse_query_failed';
    throw error;
  }
  if (!Array.isArray(data.resultValue.list)) {
    const error = new Error('WMS 出库订单查询结果结构不完整');
    error.code = 'warehouse_query_incomplete';
    throw error;
  }
  return data.resultValue;
}

function getMerchantOrderNo(record) {
  return String(record && record.merchantOrderNo || '').trim();
}

function getWaybillNo(record) {
  return String(
    record && record.extendFields && record.extendFields.thirdPartyFirstWayBillNo ||
    record && record.waybillNo ||
    ''
  ).trim();
}

function hasNextOutboundPage(resultValue, currentPage) {
  if (resultValue.hasNextPage === true) return true;
  const pages = Number(resultValue.pages);
  if (Number.isInteger(pages) && pages >= 0) return pages > currentPage;
  if (resultValue.hasNextPage === false) return false;
  const error = new Error('WMS 出库订单分页信息不完整');
  error.code = 'warehouse_query_incomplete';
  throw error;
}

async function queryWarehouseOrder(options = {}) {
  const validation = validateWarehouseOrderParams({
    order_no: options.orderNo,
    order_year: options.orderYear
  });
  if (!validation.valid) {
    const error = new Error(validation.message);
    error.code = 'warehouse_query_params_invalid';
    throw error;
  }
  const warehouseNo = String(options.warehouseNo || '').trim();
  if (!warehouseNo) {
    const error = new Error('当前 WMS 仓库编号不可用，请重新进入仓库');
    error.code = 'warehouse_context_unavailable';
    throw error;
  }
  if (typeof options.fetchPage !== 'function') {
    throw new Error('WMS 出库订单查询服务未配置');
  }
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const maxPages = Number.isInteger(options.maxPages) && options.maxPages > 0
    ? options.maxPages
    : OUTBOUND_ORDER_MAX_PAGES;

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const payload = buildOutboundOrderListPayload({
      orderYear: validation.orderYear,
      warehouseNo,
      pageNum,
      currentStatuses: options.currentStatuses
    });
    const data = await options.fetchPage(payload, {
      apiPath: OUTBOUND_ORDER_LIST_API,
      lopDn: OUTBOUND_ORDER_LOP_DN,
      bpLopDn: OUTBOUND_ORDER_LOP_DN
    });
    const resultValue = assertOutboundOrderPage(data);
    const matched = resultValue.list.find(record => getMerchantOrderNo(record) === validation.orderNo);
    if (matched) {
      return {
        state: 'arrived',
        exists: true,
        waybill_no: getWaybillNo(matched),
        queried_at: now().toISOString()
      };
    }
    if (!hasNextOutboundPage(resultValue, pageNum)) {
      return {
        state: 'waiting_arrival',
        exists: false,
        waybill_no: '',
        queried_at: now().toISOString()
      };
    }
  }

  const error = new Error('WMS 出库订单结果页数超过安全上限，无法确认订单是否存在');
  error.code = 'warehouse_query_incomplete';
  throw error;
}

async function queryWarehouseOrderRecord(options = {}) {
  const validation = validateWarehouseOrderParams({
    order_no: options.orderNo,
    order_year: options.orderYear
  });
  if (!validation.valid) {
    const error = new Error(validation.message);
    error.code = 'warehouse_query_params_invalid';
    throw error;
  }
  const warehouseNo = String(options.warehouseNo || '').trim();
  if (!warehouseNo) {
    const error = new Error('当前 WMS 仓库编号不可用，请重新进入仓库');
    error.code = 'warehouse_context_unavailable';
    throw error;
  }
  if (typeof options.fetchPage !== 'function') {
    throw new Error('WMS 出库订单查询服务未配置');
  }
  const maxPages = Number.isInteger(options.maxPages) && options.maxPages > 0
    ? options.maxPages
    : OUTBOUND_ORDER_MAX_PAGES;
  const matches = [];

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const payload = buildOutboundOrderListPayload({
      orderYear: validation.orderYear,
      warehouseNo,
      pageNum,
      currentStatuses: options.currentStatuses
    });
    const data = await options.fetchPage(payload, {
      apiPath: OUTBOUND_ORDER_LIST_API,
      lopDn: OUTBOUND_ORDER_LOP_DN,
      bpLopDn: OUTBOUND_ORDER_LOP_DN
    });
    const resultValue = assertOutboundOrderPage(data);
    matches.push(...resultValue.list.filter(
      record => getMerchantOrderNo(record) === validation.orderNo
    ));

    if (!hasNextOutboundPage(resultValue, pageNum)) break;
    if (pageNum === maxPages) {
      const error = new Error('WMS 出库订单结果页数超过安全上限，无法确认订单是否唯一');
      error.code = 'warehouse_query_incomplete';
      throw error;
    }
  }

  if (matches.length === 0) {
    const error = new Error('当前仓库未查询到该订单');
    error.code = 'warehouse_order_not_found';
    throw error;
  }
  if (matches.length > 1) {
    const error = new Error('当前仓库查询到多个同号订单，已停止打印');
    error.code = 'warehouse_order_ambiguous';
    throw error;
  }
  return matches[0];
}

function createWarehouseOrderCheckAdapter(services = {}) {
  if (typeof services.queryWarehouseOrder !== 'function') {
    throw new Error('warehouse.order.check 适配器缺少查询服务');
  }
  return {
    validateParams: validateWarehouseOrderParams,
    execute: params => services.queryWarehouseOrder({
      orderNo: String(params.order_no || '').trim(),
      orderYear: Number(params.order_year)
    })
  };
}

function registerWarehouseOrderCheckAdapter(executor, services = {}) {
  if (!executor || typeof executor.registerAdapter !== 'function') {
    throw new Error('warehouse.order.check 适配器需要订单执行器');
  }
  executor.registerAdapter(
    WAREHOUSE_ORDER_CHECK_COMMAND,
    createWarehouseOrderCheckAdapter(services)
  );
}

module.exports = {
  OUTBOUND_ORDER_LIST_API,
  OUTBOUND_ORDER_LOP_DN,
  OUTBOUND_ORDER_MAX_PAGES,
  OUTBOUND_ORDER_PAGE_SIZE,
  OUTBOUND_ORDER_REPRINT_STATUSES,
  OUTBOUND_ORDER_STATUSES,
  WAREHOUSE_ORDER_CHECK_COMMAND,
  buildOutboundOrderListPayload,
  createWarehouseOrderCheckAdapter,
  getMerchantOrderNo,
  getWaybillNo,
  normalizeOutboundOrderStatuses,
  queryWarehouseOrder,
  queryWarehouseOrderRecord,
  registerWarehouseOrderCheckAdapter,
  validateWarehouseOrderParams
};
