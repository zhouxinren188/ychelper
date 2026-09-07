'use strict';

const { validateWarehouseOrderParams } = require('./warehouse-order-adapter');

const WAREHOUSE_ORDER_PRINT_COMMAND = 'warehouse.order.print';
const WAREHOUSE_ORDER_REPRINT_COMMAND = 'warehouse.order.reprint';
const WAREHOUSE_ORDER_OUTBOUND_COMMAND = 'warehouse.order.outbound';

function normalizedOrderParams(params) {
  const validation = validateWarehouseOrderParams(params);
  if (!validation.valid) {
    const error = new Error(validation.message);
    error.code = 'warehouse_command_params_invalid';
    throw error;
  }
  return {
    orderNo: validation.orderNo,
    orderYear: validation.orderYear
  };
}

function verifyPrintResult(result, expectedCode, observedStatus, failureMessage) {
  const printedCount = Number(result && result.printedCount);
  const confirmed = Boolean(
    result
    && result.code === expectedCode
    && Number.isInteger(printedCount)
    && printedCount > 0
  );
  return {
    confirmed,
    observed_status: confirmed ? observedStatus : null,
    ...(!confirmed ? { message: failureMessage } : {})
  };
}

function verifyOutboundResult(result) {
  const confirmed = Boolean(
    result
    && result.success === true
    && result.code === 'warehouse_outbound_completed'
    && Number(result.outboundCount) === 1
  );
  return {
    confirmed,
    observed_status: confirmed ? 'shipped' : null,
    ...(!confirmed ? { message: 'WMS 未返回唯一订单快速发货成功结果' } : {})
  };
}

function createWarehouseOrderActionAdapters(services = {}) {
  if (typeof services.preflightWarehouseOrderAction !== 'function') {
    throw new Error('云仓写指令适配器缺少执行前复验服务');
  }
  if (typeof services.printWarehouseOrder !== 'function') {
    throw new Error('云仓写指令适配器缺少打印服务');
  }
  if (typeof services.outboundWarehouseOrder !== 'function') {
    throw new Error('云仓写指令适配器缺少快速发货服务');
  }

  const createPrintAdapter = ({ action, printMode, expectedCode, observedStatus, failureMessage }) => ({
    validateParams: validateWarehouseOrderParams,
    preflight: params => services.preflightWarehouseOrderAction({
      ...normalizedOrderParams(params),
      action
    }),
    execute: params => services.printWarehouseOrder({
      ...normalizedOrderParams(params),
      printMode
    }),
    verify: (params, result) => verifyPrintResult(
      result,
      expectedCode,
      observedStatus,
      failureMessage
    )
  });

  return {
    [WAREHOUSE_ORDER_PRINT_COMMAND]: createPrintAdapter({
      action: 'print',
      printMode: 'print',
      expectedCode: 'printed',
      observedStatus: 'printed_unshipped',
      failureMessage: 'WMS 未返回明确的首次打印成功结果'
    }),
    [WAREHOUSE_ORDER_REPRINT_COMMAND]: createPrintAdapter({
      action: 'reprint',
      printMode: 'reprint',
      expectedCode: 'reprinted',
      observedStatus: 'reprinted',
      failureMessage: 'WMS 未返回明确的通道补打成功结果'
    }),
    [WAREHOUSE_ORDER_OUTBOUND_COMMAND]: {
      validateParams: validateWarehouseOrderParams,
      preflight: params => services.preflightWarehouseOrderAction({
        ...normalizedOrderParams(params),
        action: 'outbound'
      }),
      execute: params => services.outboundWarehouseOrder(normalizedOrderParams(params)),
      verify: (params, result) => verifyOutboundResult(result)
    }
  };
}

function registerWarehouseOrderActionAdapters(executor, services = {}) {
  if (!executor || typeof executor.registerAdapter !== 'function') {
    throw new Error('云仓写指令适配器需要订单执行器');
  }
  const adapters = createWarehouseOrderActionAdapters(services);
  for (const [command, adapter] of Object.entries(adapters)) {
    executor.registerAdapter(command, adapter);
  }
  return adapters;
}

module.exports = {
  WAREHOUSE_ORDER_OUTBOUND_COMMAND,
  WAREHOUSE_ORDER_PRINT_COMMAND,
  WAREHOUSE_ORDER_REPRINT_COMMAND,
  createWarehouseOrderActionAdapters,
  normalizedOrderParams,
  registerWarehouseOrderActionAdapters,
  verifyOutboundResult,
  verifyPrintResult
};
