'use strict';

const {
  OUTBOUND_ORDER_LOP_DN,
  queryWarehouseOrderRecord
} = require('../../warehouse-order-adapter');

const WMS_SUCCESS_CODE = 100000;
const QUICK_DELIVERY_CHECK_API = '/jwms/outbound/order/quickBatchDeliveryCheck';
const QUICK_DELIVERY_API = '/jwms/outbound/order/quickBatchDelivery';
const SHIPMENT_ORDER_NO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function createOutboundError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause && cause.wmsFailureType) error.wmsFailureType = cause.wmsFailureType;
  if (cause && cause.httpStatus) error.httpStatus = cause.httpStatus;
  return error;
}

function assertSuccessfulResult(data, code, message) {
  if (
    !isPlainObject(data)
    || data.success !== true
    || Number(data.resultCode) !== WMS_SUCCESS_CODE
    || !isPlainObject(data.resultValue)
  ) {
    throw createOutboundError(code, message);
  }
  return data.resultValue;
}

function buildCheckedDeliveryPayload(resultValue, expectedShipmentOrderNo) {
  const batchNoList = Array.isArray(resultValue.batchNoList)
    ? resultValue.batchNoList
    : [];
  const shipmentOrderList = Array.isArray(resultValue.shipmentOrderList)
    ? resultValue.shipmentOrderList.map(value => String(value || '').trim()).filter(Boolean)
    : [];

  if (batchNoList.length > 0) {
    throw createOutboundError(
      'warehouse_outbound_batch_confirmation_required',
      '该订单关联集合单，WMS 可能连带发货其他订单，已停止自动发货，请在 WMS 页面人工确认'
    );
  }
  if (
    shipmentOrderList.length !== 1
    || shipmentOrderList[0] !== expectedShipmentOrderNo
  ) {
    throw createOutboundError(
      'warehouse_outbound_scope_changed',
      'WMS 发货校验返回的订单范围与目标订单不一致，已停止发货'
    );
  }

  return {
    batchNoList: [],
    shipmentOrderList: [expectedShipmentOrderNo]
  };
}

async function executeWarehouseOutbound(options = {}) {
  if (typeof options.fetchPage !== 'function' || typeof options.request !== 'function') {
    throw new Error('WMS 发货服务未配置');
  }

  const order = await queryWarehouseOrderRecord({
    orderNo: options.orderNo,
    orderYear: options.orderYear,
    warehouseNo: options.warehouseNo,
    fetchPage: options.fetchPage,
    maxPages: options.maxPages
  });
  const shipmentOrderNo = String(order && order.shipmentOrderNo || '').trim();
  if (!SHIPMENT_ORDER_NO_PATTERN.test(shipmentOrderNo)) {
    throw createOutboundError(
      'warehouse_outbound_order_incomplete',
      'WMS 订单缺少有效生产单号，无法发货'
    );
  }

  const requestMetadata = {
    lopDn: OUTBOUND_ORDER_LOP_DN,
    bpLopDn: OUTBOUND_ORDER_LOP_DN
  };
  const checkData = await options.request(
    QUICK_DELIVERY_CHECK_API,
    { shipmentOrderList: [shipmentOrderNo] },
    requestMetadata
  );
  const checkResult = assertSuccessfulResult(
    checkData,
    'warehouse_outbound_check_failed',
    'WMS 快速发货校验未通过'
  );
  const deliveryPayload = buildCheckedDeliveryPayload(checkResult, shipmentOrderNo);

  if (typeof options.beforeCommit === 'function') {
    await options.beforeCommit();
  }

  let deliveryData;
  try {
    deliveryData = await options.request(
      QUICK_DELIVERY_API,
      deliveryPayload,
      requestMetadata
    );
  } catch (cause) {
    if (cause && cause.wmsFailureType === 'auth') throw cause;
    throw createOutboundError(
      'warehouse_outbound_result_unknown',
      '发货请求结果未确认，请先在 WMS 查询订单状态，确认前不要重复发货',
      cause
    );
  }

  const deliveryResult = assertSuccessfulResult(
    deliveryData,
    'warehouse_outbound_failed',
    'WMS 返回发货失败'
  );
  const succeeded = Number(deliveryResult.success);
  const failed = Number(deliveryResult.failed);
  const failedList = Array.isArray(deliveryResult.failedList)
    ? deliveryResult.failedList
    : [];
  if (failed > 0 || failedList.length > 0) {
    throw createOutboundError(
      'warehouse_outbound_failed',
      'WMS 返回发货失败，请在 WMS 页面查看失败原因'
    );
  }
  if (succeeded !== 1 || failed !== 0) {
    throw createOutboundError(
      'warehouse_outbound_result_unknown',
      'WMS 未返回唯一订单发货成功结果，请先查询订单状态，确认前不要重复发货'
    );
  }

  return {
    success: true,
    code: 'warehouse_outbound_completed',
    outboundCount: 1
  };
}

module.exports = {
  QUICK_DELIVERY_API,
  QUICK_DELIVERY_CHECK_API,
  SHIPMENT_ORDER_NO_PATTERN,
  WMS_SUCCESS_CODE,
  buildCheckedDeliveryPayload,
  executeWarehouseOutbound
};
