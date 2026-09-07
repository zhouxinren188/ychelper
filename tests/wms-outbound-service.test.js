'use strict';

const assert = require('assert');
const {
  QUICK_DELIVERY_API,
  QUICK_DELIVERY_CHECK_API,
  buildCheckedDeliveryPayload,
  executeWarehouseOutbound
} = require('../src/js/wmsOutboundService');

const ORDER_NO = 'TEST-ORDER-2026-001';
const SHIPMENT_ORDER_NO = 'SO-TEST-2026-001';
const WAREHOUSE_NO = 'WAREHOUSE-TEST-001';

function page(list) {
  return {
    success: true,
    resultCode: 100000,
    resultValue: {
      list,
      pageNum: 1,
      pages: 1,
      hasNextPage: false
    }
  };
}

function successEnvelope(resultValue) {
  return {
    success: true,
    resultCode: 100000,
    resultValue
  };
}

function createScenario(overrides = {}) {
  const calls = [];
  const record = {
    merchantOrderNo: ORDER_NO,
    shipmentOrderNo: SHIPMENT_ORDER_NO,
    currentStatus: 30
  };
  const options = {
    orderNo: ORDER_NO,
    orderYear: 2026,
    warehouseNo: WAREHOUSE_NO,
    fetchPage: async (payload, metadata) => {
      calls.push({ type: 'query', payload, metadata });
      return page([record]);
    },
    request: async (apiPath, payload, metadata) => {
      calls.push({ type: 'request', apiPath, payload, metadata });
      if (apiPath === QUICK_DELIVERY_CHECK_API) {
        return successEnvelope({
          batchNoList: [],
          shipmentOrderList: [SHIPMENT_ORDER_NO]
        });
      }
      if (apiPath === QUICK_DELIVERY_API) {
        return successEnvelope({
          success: 1,
          failed: 0,
          failedList: []
        });
      }
      throw new Error('unexpected API');
    },
    beforeCommit: async () => {
      calls.push({ type: 'beforeCommit' });
    },
    ...overrides
  };
  return { calls, options, record };
}

(async () => {
  assert.deepStrictEqual(
    buildCheckedDeliveryPayload({
      batchNoList: [],
      shipmentOrderList: [SHIPMENT_ORDER_NO]
    }, SHIPMENT_ORDER_NO),
    {
      batchNoList: [],
      shipmentOrderList: [SHIPMENT_ORDER_NO]
    }
  );

  const successful = createScenario();
  const result = await executeWarehouseOutbound(successful.options);
  assert.deepStrictEqual(result, {
    success: true,
    code: 'warehouse_outbound_completed',
    outboundCount: 1
  });
  const requestCalls = successful.calls.filter(call => call.type === 'request');
  assert.strictEqual(requestCalls.length, 2);
  assert.strictEqual(requestCalls[0].apiPath, QUICK_DELIVERY_CHECK_API);
  assert.deepStrictEqual(requestCalls[0].payload, {
    shipmentOrderList: [SHIPMENT_ORDER_NO]
  });
  assert.strictEqual(requestCalls[1].apiPath, QUICK_DELIVERY_API);
  assert.deepStrictEqual(requestCalls[1].payload, {
    batchNoList: [],
    shipmentOrderList: [SHIPMENT_ORDER_NO]
  });
  assert.strictEqual(successful.calls.filter(call => call.type === 'beforeCommit').length, 1);

  const batchScenario = createScenario({
    request: async (apiPath) => {
      assert.strictEqual(apiPath, QUICK_DELIVERY_CHECK_API);
      return successEnvelope({
        batchNoList: ['BATCH-TEST-001'],
        shipmentOrderList: [SHIPMENT_ORDER_NO]
      });
    }
  });
  await assert.rejects(
    executeWarehouseOutbound(batchScenario.options),
    error => error && error.code === 'warehouse_outbound_batch_confirmation_required'
  );

  const changedScope = createScenario({
    request: async (apiPath) => {
      assert.strictEqual(apiPath, QUICK_DELIVERY_CHECK_API);
      return successEnvelope({
        batchNoList: [],
        shipmentOrderList: [SHIPMENT_ORDER_NO, 'SO-TEST-2026-002']
      });
    }
  });
  await assert.rejects(
    executeWarehouseOutbound(changedScope.options),
    error => error && error.code === 'warehouse_outbound_scope_changed'
  );

  const failedCheck = createScenario({
    request: async (apiPath) => {
      assert.strictEqual(apiPath, QUICK_DELIVERY_CHECK_API);
      return { success: false, resultCode: 200001, resultValue: null };
    }
  });
  await assert.rejects(
    executeWarehouseOutbound(failedCheck.options),
    error => error && error.code === 'warehouse_outbound_check_failed'
  );

  const contextChanged = createScenario({
    beforeCommit: async () => {
      const error = new Error('warehouse changed');
      error.code = 'warehouse_context_changed';
      throw error;
    }
  });
  await assert.rejects(
    executeWarehouseOutbound(contextChanged.options),
    error => error && error.code === 'warehouse_context_changed'
  );

  const knownFailure = createScenario({
    request: async (apiPath) => {
      if (apiPath === QUICK_DELIVERY_CHECK_API) {
        return successEnvelope({
          batchNoList: [],
          shipmentOrderList: [SHIPMENT_ORDER_NO]
        });
      }
      return successEnvelope({
        success: 0,
        failed: 1,
        failedList: [{ resultMsg: 'test failure' }]
      });
    }
  });
  await assert.rejects(
    executeWarehouseOutbound(knownFailure.options),
    error => error && error.code === 'warehouse_outbound_failed'
  );

  const uncertain = createScenario({
    request: async (apiPath) => {
      if (apiPath === QUICK_DELIVERY_CHECK_API) {
        return successEnvelope({
          batchNoList: [],
          shipmentOrderList: [SHIPMENT_ORDER_NO]
        });
      }
      const error = new Error('test network interruption');
      error.wmsFailureType = 'network';
      throw error;
    }
  });
  await assert.rejects(
    executeWarehouseOutbound(uncertain.options),
    error => error
      && error.code === 'warehouse_outbound_result_unknown'
      && error.wmsFailureType === 'network'
  );

  const missingShipment = createScenario({
    fetchPage: async () => page([{
      merchantOrderNo: ORDER_NO,
      currentStatus: 30
    }])
  });
  await assert.rejects(
    executeWarehouseOutbound(missingShipment.options),
    error => error && error.code === 'warehouse_outbound_order_incomplete'
  );

  console.log('WMS outbound service tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
