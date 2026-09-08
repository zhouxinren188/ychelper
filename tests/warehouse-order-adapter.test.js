'use strict';

const assert = require('assert');
const {
  OUTBOUND_ORDER_LIST_API,
  OUTBOUND_ORDER_LOP_DN,
  OUTBOUND_ORDER_PAGE_SIZE,
  buildOutboundOrderListPayload,
  createWarehouseOrderCheckAdapter,
  getLogisticsCompany,
  getWaybillNo,
  queryWarehouseOrder,
  queryWarehouseOrders,
  queryWarehouseOrderRecord,
  validateWarehouseOrderCheckParams,
  validateWarehouseOrderParams
} = require('../warehouse-order-adapter');

const ORDER_NO = '3589409013687094';
const WAREHOUSE_NO = '800015947';
const NOW = new Date('2026-08-22T14:30:00.000Z');

function page(list, options = {}) {
  return {
    success: true,
    resultCode: 100000,
    resultValue: {
      list,
      pageNum: options.pageNum || 1,
      pageSize: options.pageSize || OUTBOUND_ORDER_PAGE_SIZE,
      pages: options.pages || 1,
      hasNextPage: options.hasNextPage === true
    }
  };
}

(async () => {
  assert.deepStrictEqual(
    validateWarehouseOrderParams({ order_no: ORDER_NO, order_year: 2026 }),
    { valid: true, orderNo: ORDER_NO, orderYear: 2026 }
  );
  assert.strictEqual(validateWarehouseOrderParams({ order_no: '', order_year: 2026 }).valid, false);
  assert.strictEqual(validateWarehouseOrderParams({ order_no: ORDER_NO, order_year: 1999 }).valid, false);
  assert.strictEqual(
    validateWarehouseOrderParams({ order_no: ORDER_NO, order_year: 2026, request_url: 'unsafe' }).valid,
    false
  );
  assert.deepStrictEqual(validateWarehouseOrderCheckParams({}), { valid: true, mode: 'all' });

  const payload = buildOutboundOrderListPayload({
    orderYear: 2026,
    warehouseNo: WAREHOUSE_NO,
    pageNum: 2
  });
  assert.deepStrictEqual(payload.currentStatus, ['10', '30']);
  assert.deepStrictEqual(buildOutboundOrderListPayload({
    orderYear: 2026,
    warehouseNo: WAREHOUSE_NO,
    pageNum: 1,
    currentStatuses: ['10', '30', '70']
  }).currentStatus, ['10', '30', '70']);
  assert.deepStrictEqual(payload.createTime, [
    '2026-01-01 00:00:00',
    '2026-12-31 23:59:59'
  ]);
  assert.strictEqual(payload.pageNum, 2);
  assert.strictEqual(payload.pageSize, 100);
  assert.strictEqual(payload.probe_anchor_warehouseNo, WAREHOUSE_NO);

  assert.strictEqual(getWaybillNo({
    extendFields: { thirdPartyFirstWayBillNo: 'JDV029243091652' },
    waybillNo: 'fallback'
  }), 'JDV029243091652');
  assert.strictEqual(getWaybillNo({ waybillNo: 'JDV029243091653' }), 'JDV029243091653');
  assert.strictEqual(getLogisticsCompany({ logisticsCompanyName: '京东物流' }), '京东物流');

  const calls = [];
  const found = await queryWarehouseOrder({
    orderNo: ORDER_NO,
    orderYear: 2026,
    warehouseNo: WAREHOUSE_NO,
    now: () => NOW,
    fetchPage: async (requestPayload, metadata) => {
      calls.push({ requestPayload, metadata });
      if (requestPayload.pageNum === 1) {
        return page([{ merchantOrderNo: 'unrelated-1' }], { pageNum: 1, pages: 2, hasNextPage: true });
      }
      return page([{
        merchantOrderNo: ORDER_NO,
        orderNo: 'internal-wms-order',
        extendFields: { thirdPartyFirstWayBillNo: 'JDV029243091652' },
        waybillNo: 'JDV029243091652'
      }], { pageNum: 2, pages: 2 });
    }
  });
  assert.deepStrictEqual(found, {
    state: 'arrived',
    exists: true,
    waybill_no: 'JDV029243091652',
    queried_at: NOW.toISOString()
  });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].metadata.apiPath, OUTBOUND_ORDER_LIST_API);
  assert.strictEqual(calls[0].metadata.lopDn, OUTBOUND_ORDER_LOP_DN);
  assert.strictEqual(calls[0].metadata.bpLopDn, OUTBOUND_ORDER_LOP_DN);

  const printableRecord = {
    merchantOrderNo: ORDER_NO,
    orderNo: 'internal-wms-order',
    shipmentOrderNo: 'shipment-order',
    currentStatus: 30
  };
  const printQueryCalls = [];
  const preparedForPrint = await queryWarehouseOrderRecord({
    orderNo: ORDER_NO,
    orderYear: 2026,
    warehouseNo: WAREHOUSE_NO,
    fetchPage: async (requestPayload, metadata) => {
      printQueryCalls.push({ requestPayload, metadata });
      if (requestPayload.pageNum === 1) {
        return page([{ merchantOrderNo: 'unrelated-1' }], { pageNum: 1, pages: 2, hasNextPage: true });
      }
      return page([printableRecord], { pageNum: 2, pages: 2 });
    }
  });
  assert.strictEqual(preparedForPrint, printableRecord);
  assert.strictEqual(printQueryCalls.length, 2);
  assert.strictEqual(printQueryCalls[0].metadata.apiPath, OUTBOUND_ORDER_LIST_API);

  await assert.rejects(
    queryWarehouseOrderRecord({
      orderNo: ORDER_NO,
      orderYear: 2026,
      warehouseNo: WAREHOUSE_NO,
      fetchPage: async () => page([])
    }),
    error => error && error.code === 'warehouse_order_not_found'
  );

  await assert.rejects(
    queryWarehouseOrderRecord({
      orderNo: ORDER_NO,
      orderYear: 2026,
      warehouseNo: WAREHOUSE_NO,
      fetchPage: async () => page([
        { merchantOrderNo: ORDER_NO, shipmentOrderNo: 'shipment-order-1' },
        { merchantOrderNo: ORDER_NO, shipmentOrderNo: 'shipment-order-2' }
      ])
    }),
    error => error && error.code === 'warehouse_order_ambiguous'
  );

  const internalNumberMustNotMatch = await queryWarehouseOrder({
    orderNo: ORDER_NO,
    orderYear: 2026,
    warehouseNo: WAREHOUSE_NO,
    now: () => NOW,
    fetchPage: async () => page([{
      merchantOrderNo: 'another-order',
      orderNo: ORDER_NO,
      shipmentOrderNo: ORDER_NO,
      waybillNo: 'must-not-return'
    }])
  });
  assert.strictEqual(internalNumberMustNotMatch.exists, false);
  assert.strictEqual(internalNumberMustNotMatch.waybill_no, '');

  const missing = await queryWarehouseOrder({
    orderNo: ORDER_NO,
    orderYear: 2026,
    warehouseNo: WAREHOUSE_NO,
    now: () => NOW,
    fetchPage: async () => page([])
  });
  assert.deepStrictEqual(missing, {
    state: 'waiting_arrival',
    exists: false,
    waybill_no: '',
    queried_at: NOW.toISOString()
  });

  const allCalls = [];
  const allOrders = await queryWarehouseOrders({
    warehouseNo: WAREHOUSE_NO,
    now: () => NOW,
    fetchPage: async payload => {
      allCalls.push(payload);
      if (payload.pageNum === 1) {
        return page([
          { merchantOrderNo: ORDER_NO, currentStatus: 10 },
          { merchantOrderNo: '', currentStatus: 10 }
        ], { pages: 2, hasNextPage: true });
      }
      return page([
        {
          merchantOrderNo: ORDER_NO,
          currentStatus: 30,
          extendFields: { thirdPartyFirstWayBillNo: 'JDV029243091652' },
          logisticsCompanyName: '京东物流'
        },
        { merchantOrderNo: '3589409013687095', currentStatus: 30 }
      ], { pageNum: 2, pages: 2 });
    }
  });
  assert.deepStrictEqual(allOrders, {
    queried_at: NOW.toISOString(),
    orders: [
      {
        order_no: ORDER_NO,
        status: 'pending_print',
        logistics_no: 'JDV029243091652',
        logistics_company: '京东物流',
        printable: true
      },
      {
        order_no: '3589409013687095',
        status: 'pending_print',
        logistics_no: '',
        logistics_company: '',
        printable: true
      }
    ]
  });
  assert.strictEqual(allCalls.length, 2);
  assert.strictEqual(allCalls[0].createTime[0], '2026-01-01 00:00:00');

  await assert.rejects(
    queryWarehouseOrder({
      orderNo: ORDER_NO,
      orderYear: 2026,
      warehouseNo: WAREHOUSE_NO,
      fetchPage: async () => ({ success: true, resultValue: {} })
    }),
    error => error && error.code === 'warehouse_query_incomplete'
  );

  await assert.rejects(
    queryWarehouseOrder({
      orderNo: ORDER_NO,
      orderYear: 2026,
      warehouseNo: WAREHOUSE_NO,
      fetchPage: async () => ({ success: true, resultValue: { list: [] } })
    }),
    error => error && error.code === 'warehouse_query_incomplete'
  );

  await assert.rejects(
    queryWarehouseOrder({
      orderNo: ORDER_NO,
      orderYear: 2026,
      warehouseNo: WAREHOUSE_NO,
      maxPages: 1,
      fetchPage: async () => page([], { pages: 2, hasNextPage: true })
    }),
    error => error && error.code === 'warehouse_query_incomplete'
  );

  const adapter = createWarehouseOrderCheckAdapter({
    queryWarehouseOrders: async () => ({ queried_at: NOW.toISOString(), orders: [] }),
    queryWarehouseOrder: async input => ({ ...input, state: 'arrived', exists: true, waybill_no: 'JDV' })
  });
  assert.strictEqual(adapter.validateParams({}).valid, true);
  assert.deepStrictEqual(await adapter.execute({}), {
    queried_at: NOW.toISOString(),
    orders: []
  });
  assert.strictEqual(adapter.validateParams({ order_no: ORDER_NO, order_year: 2026 }).valid, true);
  assert.deepStrictEqual(await adapter.execute({ order_no: ORDER_NO, order_year: 2026 }), {
    orderNo: ORDER_NO,
    orderYear: 2026,
    state: 'arrived',
    exists: true,
    waybill_no: 'JDV'
  });

  console.log('Warehouse order check adapter tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
