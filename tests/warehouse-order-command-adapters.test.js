'use strict';

const assert = require('assert');
const {
  WAREHOUSE_ORDER_OUTBOUND_COMMAND,
  WAREHOUSE_ORDER_PRINT_COMMAND,
  WAREHOUSE_ORDER_REPRINT_COMMAND,
  createWarehouseOrderActionAdapters,
  registerWarehouseOrderActionAdapters
} = require('../warehouse-order-command-adapters');

const params = { order_no: 'TEST-ORDER-001', order_year: 2026 };
const calls = [];
const services = {
  async preflightWarehouseOrderAction(input) {
    calls.push({ type: 'preflight', ...input });
    return { ok: true, observed_status: 'ready' };
  },
  async printWarehouseOrder(input) {
    calls.push({ type: 'print', ...input });
    return {
      code: input.printMode === 'reprint' ? 'reprinted' : 'printed',
      printedCount: 1
    };
  },
  async outboundWarehouseOrder(input) {
    calls.push({ type: 'outbound', ...input });
    return { success: true, code: 'warehouse_outbound_completed', outboundCount: 1 };
  }
};

(async () => {
  const adapters = createWarehouseOrderActionAdapters(services);
  assert.deepStrictEqual(Object.keys(adapters), [
    WAREHOUSE_ORDER_PRINT_COMMAND,
    WAREHOUSE_ORDER_REPRINT_COMMAND,
    WAREHOUSE_ORDER_OUTBOUND_COMMAND
  ]);
  assert.strictEqual(adapters[WAREHOUSE_ORDER_REPRINT_COMMAND].validateParams(params).valid, true);
  assert.strictEqual(
    adapters[WAREHOUSE_ORDER_REPRINT_COMMAND].validateParams({ ...params, extra: true }).valid,
    false
  );

  const printPreflight = await adapters[WAREHOUSE_ORDER_PRINT_COMMAND].preflight(params);
  assert.strictEqual(printPreflight.ok, true);
  const printResult = await adapters[WAREHOUSE_ORDER_PRINT_COMMAND].execute(params);
  assert.deepStrictEqual(
    adapters[WAREHOUSE_ORDER_PRINT_COMMAND].verify(params, printResult),
    { confirmed: true, observed_status: 'printed_unshipped' }
  );

  const reprintPreflight = await adapters[WAREHOUSE_ORDER_REPRINT_COMMAND].preflight(params);
  assert.strictEqual(reprintPreflight.ok, true);
  const reprintResult = await adapters[WAREHOUSE_ORDER_REPRINT_COMMAND].execute(params);
  assert.deepStrictEqual(
    adapters[WAREHOUSE_ORDER_REPRINT_COMMAND].verify(params, reprintResult),
    { confirmed: true, observed_status: 'reprinted' }
  );
  assert.strictEqual(
    adapters[WAREHOUSE_ORDER_REPRINT_COMMAND].verify(params, { code: 'reprinted', printedCount: 0 }).confirmed,
    false
  );

  const outboundPreflight = await adapters[WAREHOUSE_ORDER_OUTBOUND_COMMAND].preflight(params);
  assert.strictEqual(outboundPreflight.ok, true);
  const outboundResult = await adapters[WAREHOUSE_ORDER_OUTBOUND_COMMAND].execute(params);
  assert.deepStrictEqual(
    adapters[WAREHOUSE_ORDER_OUTBOUND_COMMAND].verify(params, outboundResult),
    { confirmed: true, observed_status: 'shipped' }
  );

  assert.deepStrictEqual(
    calls.filter(call => call.type === 'preflight').map(call => call.action),
    ['print', 'reprint', 'outbound']
  );
  assert.strictEqual(
    calls.some(call => call.type === 'print' && call.printMode === 'reprint'),
    true
  );

  const registered = [];
  registerWarehouseOrderActionAdapters({
    registerAdapter(command, adapter) {
      registered.push({ command, adapter });
    }
  }, services);
  assert.deepStrictEqual(registered.map(item => item.command), [
    WAREHOUSE_ORDER_PRINT_COMMAND,
    WAREHOUSE_ORDER_REPRINT_COMMAND,
    WAREHOUSE_ORDER_OUTBOUND_COMMAND
  ]);

  console.log('Warehouse order command adapter tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
