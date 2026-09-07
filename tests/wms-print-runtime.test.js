'use strict';

const assert = require('assert');
const {
  buildPrintExecutionScript,
  executePrintInPage,
  normalizeOrderNo
} = require('../src/js/wmsPrintRuntime');

const ORDER_NO = 'TEST-ORDER-PRINT-001';
const WAREHOUSE_NO = 'WAREHOUSE-TEST-001';

function createRuntime(options = {}) {
  const queueRef = {
    queuePrint: async () => options.outcome || { success: [{}], error: [] }
  };
  const footer = {
    $options: { name: 'jwms-webview-footerBtns' },
    $children: [],
    printInfo: options.printInfo || (async (orders, printRef) => {
      assert.strictEqual(orders.length, 1);
      await printRef.queuePrint({ params: orders });
    }),
    doPrint: options.doPrint || (async ({ selectionList, printRef, printState }) => {
      assert.strictEqual(selectionList.length, 1);
      assert.strictEqual(printState, 'rePrint');
      await printRef.queuePrint({ params: selectionList });
    })
  };
  const orderPage = {
    $options: { name: 'jwms-webview-orderProcessList' },
    $children: [footer],
    $store: { state: { user: { warehouseNo: options.warehouseNo || WAREHOUSE_NO } } },
    printRef: queueRef
  };
  const root = {
    $options: { name: 'root' },
    $children: [orderPage]
  };
  return {
    document: {
      querySelectorAll: () => [{ __vue__: root }]
    }
  };
}

async function withDocument(document, callback) {
  const previous = global.document;
  global.document = document;
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete global.document;
    else global.document = previous;
  }
}

(async () => {
  assert.strictEqual(normalizeOrderNo(ORDER_NO), ORDER_NO);
  assert.strictEqual(normalizeOrderNo(''), '');
  assert.strictEqual(normalizeOrderNo('bad order'), '');

  const order = {
    merchantOrderNo: ORDER_NO,
    shipmentOrderNo: 'SO-PRINT-1',
    currentStatus: 30
  };
  const script = buildPrintExecutionScript(ORDER_NO, order, WAREHOUSE_NO);
  assert.doesNotThrow(() => new Function('return ' + script));
  assert.strictEqual(script.includes(ORDER_NO), true);

  const runtime = createRuntime();
  const printed = await withDocument(runtime.document, () => {
    return executePrintInPage(JSON.stringify({ orderNo: ORDER_NO, warehouseNo: WAREHOUSE_NO, order }));
  });
  assert.deepStrictEqual(printed, {
    success: true,
    code: 'printed',
    message: '订单已成功打印',
    printedCount: 1
  });
  const printedThroughScript = await new Function('document', 'return ' + script)(runtime.document);
  assert.strictEqual(printedThroughScript.success, true);
  assert.strictEqual(printedThroughScript.code, 'printed');

  const reprintScript = buildPrintExecutionScript(ORDER_NO, order, WAREHOUSE_NO, 'reprint');
  assert.doesNotThrow(() => new Function('return ' + reprintScript));
  const reprinted = await withDocument(runtime.document, () => {
    return executePrintInPage(JSON.stringify({
      orderNo: ORDER_NO,
      warehouseNo: WAREHOUSE_NO,
      printMode: 'reprint',
      order
    }));
  });
  assert.deepStrictEqual(reprinted, {
    success: true,
    code: 'reprinted',
    message: '订单已成功补打',
    printedCount: 1
  });
  const reprintedThroughScript = await new Function('document', 'return ' + reprintScript)(runtime.document);
  assert.strictEqual(reprintedThroughScript.success, true);
  assert.strictEqual(reprintedThroughScript.code, 'reprinted');
  assert.throws(
    () => buildPrintExecutionScript(ORDER_NO, order, WAREHOUSE_NO, 'unsupported'),
    /打印模式无效/
  );

  const mismatch = await withDocument(runtime.document, () => {
    return executePrintInPage(JSON.stringify({
      orderNo: ORDER_NO,
      warehouseNo: WAREHOUSE_NO,
      order: { ...order, merchantOrderNo: 'different-order' }
    }));
  });
  assert.strictEqual(mismatch.success, false);
  assert.strictEqual(mismatch.code, 'order_mismatch');

  const mismatchedWarehouseRuntime = createRuntime({ warehouseNo: 'another-warehouse' });
  const mismatchedWarehouse = await withDocument(mismatchedWarehouseRuntime.document, () => {
    return executePrintInPage(JSON.stringify({
      orderNo: ORDER_NO,
      warehouseNo: WAREHOUSE_NO,
      order
    }));
  });
  assert.strictEqual(mismatchedWarehouse.success, false);
  assert.strictEqual(mismatchedWarehouse.code, 'warehouse_context_mismatch');

  const rejectedRuntime = createRuntime({
    printInfo: async () => {}
  });
  const rejected = await withDocument(rejectedRuntime.document, () => {
    return executePrintInPage(JSON.stringify({ orderNo: ORDER_NO, warehouseNo: WAREHOUSE_NO, order }));
  });
  assert.strictEqual(rejected.success, false);
  assert.strictEqual(rejected.code, 'official_print_rejected');

  const failedRuntime = createRuntime({
    outcome: { success: [], error: [{ resultMessage: '打印机离线' }] }
  });
  const failed = await withDocument(failedRuntime.document, () => {
    return executePrintInPage(JSON.stringify({ orderNo: ORDER_NO, warehouseNo: WAREHOUSE_NO, order }));
  });
  assert.strictEqual(failed.success, false);
  assert.strictEqual(failed.code, 'print_failed');
  assert.strictEqual(failed.message, '打印机离线');

  const missing = await withDocument({ querySelectorAll: () => [] }, () => {
    return executePrintInPage(JSON.stringify({
      orderNo: ORDER_NO,
      warehouseNo: WAREHOUSE_NO,
      runtimeWaitMs: 0,
      order
    }));
  });
  assert.strictEqual(missing.success, false);
  assert.strictEqual(missing.code, 'print_runtime_unavailable');

  console.log('WMS print runtime tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
