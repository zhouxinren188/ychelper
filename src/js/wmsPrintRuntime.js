'use strict';

(function initWmsPrintRuntime(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WmsPrintRuntime = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createWmsPrintRuntime() {
  const ORDER_NO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
  const WAREHOUSE_NO_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
  const ORDER_PAGE_COMPONENT = 'jwms-webview-orderProcessList';
  const FOOTER_COMPONENT = 'jwms-webview-footerBtns';

  function normalizeOrderNo(value) {
    const orderNo = String(value || '').trim();
    return ORDER_NO_PATTERN.test(orderNo) ? orderNo : '';
  }

  function componentName(component) {
    return String(component && component.$options && component.$options.name || '');
  }

  function normalizeWarehouseNo(value) {
    const warehouseNo = String(value || '').trim();
    return WAREHOUSE_NO_PATTERN.test(warehouseNo) ? warehouseNo : '';
  }

  function findPrintComponents(doc) {
    const pending = [];
    const visited = new Set();
    const elements = Array.from(doc.querySelectorAll('*')).slice(0, 5000);
    for (const element of elements) {
      if (element && element.__vue__) pending.push(element.__vue__);
    }

    let orderPage = null;
    let footer = null;
    while (pending.length > 0) {
      const component = pending.shift();
      if (!component || visited.has(component)) continue;
      visited.add(component);
      const name = componentName(component);
      if (name === ORDER_PAGE_COMPONENT) orderPage = component;
      if (name === FOOTER_COMPONENT) footer = component;
      const children = Array.isArray(component.$children) ? component.$children : [];
      pending.push(...children);
    }
    return { orderPage, footer };
  }

  function failure(code, message) {
    return { success: false, code, message };
  }

  function safeErrorMessage(error, fallback) {
    const message = String(error && (error.resultMessage || error.message) || '').trim();
    return message || fallback;
  }

  async function executePrintInPage(payloadJson) {
    const normalizeOrderNo = (value) => {
      const orderNo = String(value || '').trim();
      return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(orderNo) ? orderNo : '';
    };
    const normalizeWarehouseNo = (value) => {
      const warehouseNo = String(value || '').trim();
      return /^[A-Za-z0-9._-]{1,128}$/.test(warehouseNo) ? warehouseNo : '';
    };
    const failure = (code, message) => ({ success: false, code, message });
    const safeErrorMessage = (error, fallback) => {
      const message = String(error && (error.resultMessage || error.message) || '').trim();
      return message || fallback;
    };
    const findPrintComponents = (doc) => {
      const pending = [];
      const visited = new Set();
      const elements = Array.from(doc.querySelectorAll('*')).slice(0, 5000);
      for (const element of elements) {
        if (element && element.__vue__) pending.push(element.__vue__);
      }
      let orderPage = null;
      let footer = null;
      while (pending.length > 0) {
        const component = pending.shift();
        if (!component || visited.has(component)) continue;
        visited.add(component);
        const name = String(component.$options && component.$options.name || '');
        if (name === 'jwms-webview-orderProcessList') orderPage = component;
        if (name === 'jwms-webview-footerBtns') footer = component;
        const children = Array.isArray(component.$children) ? component.$children : [];
        pending.push(...children);
      }
      return { orderPage, footer };
    };

    let payload;
    try {
      payload = JSON.parse(payloadJson);
    } catch (_) {
      return failure('invalid_payload', '打印参数格式无效');
    }

    const expectedOrderNo = normalizeOrderNo(payload && payload.orderNo);
    const expectedWarehouseNo = normalizeWarehouseNo(payload && payload.warehouseNo);
    const printMode = String(payload && payload.printMode || 'print');
    const runtimeWaitMs = Number.isFinite(Number(payload && payload.runtimeWaitMs))
      ? Math.max(0, Math.min(15000, Number(payload.runtimeWaitMs)))
      : 15000;
    const order = payload && payload.order;
    if (
      !expectedOrderNo
      || !expectedWarehouseNo
      || !['print', 'reprint'].includes(printMode)
      || !order
      || typeof order !== 'object'
      || Array.isArray(order)
    ) {
      return failure('invalid_payload', '打印参数格式无效');
    }
    if (String(order.merchantOrderNo || '').trim() !== expectedOrderNo) {
      return failure('order_mismatch', 'WMS 返回订单与请求订单不一致');
    }
    if (!String(order.shipmentOrderNo || '').trim()) {
      return failure('order_incomplete', 'WMS 订单缺少生产单号');
    }
    const currentStatus = Number(order.currentStatus);
    if (!Number.isFinite(currentStatus) || currentStatus < 10 || currentStatus > 70) {
      return failure('order_not_printable', '订单当前状态不允许打印包裹签');
    }

    let components = findPrintComponents(document);
    const runtimeDeadline = Date.now() + runtimeWaitMs;
    while (
      (!components.orderPage || !components.footer)
      && Date.now() < runtimeDeadline
    ) {
      await new Promise(resolve => setTimeout(resolve, 250));
      components = findPrintComponents(document);
    }
    if (!components.orderPage || !components.footer) {
      return failure('print_runtime_unavailable', 'WMS 打印页面尚未准备完成');
    }
    if (
      (printMode === 'print' && typeof components.footer.printInfo !== 'function')
      || (printMode === 'reprint' && typeof components.footer.doPrint !== 'function')
    ) {
      return failure('print_runtime_changed', 'WMS 官方打印方法不可用');
    }
    const storeWarehouseNo = components.orderPage.$store
      && components.orderPage.$store.state
      && components.orderPage.$store.state.user
      && components.orderPage.$store.state.user.warehouseNo;
    let pageWarehouseNo = normalizeWarehouseNo(storeWarehouseNo);
    if (!pageWarehouseNo) {
      try {
        let storedMark = localStorage.getItem('mark');
        if (storedMark && storedMark.startsWith('"')) storedMark = JSON.parse(storedMark);
        pageWarehouseNo = normalizeWarehouseNo(storedMark);
      } catch (_) {}
    }
    if (!pageWarehouseNo) {
      return failure('warehouse_context_unavailable', '无法确认当前 WMS 页面仓库');
    }
    if (pageWarehouseNo !== expectedWarehouseNo) {
      return failure('warehouse_context_mismatch', '当前 WMS 页面仓库与订单查询仓库不一致');
    }
    const queueRef = components.orderPage.printRef || components.footer.printRef;
    if (!queueRef || typeof queueRef.queuePrint !== 'function') {
      return failure('print_runtime_changed', 'WMS 官方打印队列不可用');
    }

    let queuePromise = null;
    let queueInvocationCount = 0;
    const printRef = Object.create(queueRef);
    printRef.queuePrint = function queuePrint(params) {
      queueInvocationCount += 1;
      if (queueInvocationCount > 1) {
        const repeated = Promise.reject(new Error('WMS 官方打印组件重复发起任务'));
        if (!queuePromise) queuePromise = repeated;
        return repeated;
      }
      queuePromise = Promise.resolve(queueRef.queuePrint(params));
      return queuePromise;
    };

    try {
      if (printMode === 'reprint') {
        await components.footer.doPrint({
          selectionList: [order],
          printRef,
          showErrPrintData: true,
          printState: 'rePrint'
        });
      } else {
        await components.footer.printInfo([order], printRef, true);
      }
    } catch (error) {
      return failure('print_launch_failed', safeErrorMessage(error, 'WMS 打印任务启动失败'));
    }
    if (!queuePromise) {
      return failure('official_print_rejected', 'WMS 未启动打印，请查看页面上的校验提示');
    }

    let outcome;
    try {
      outcome = await queuePromise;
    } catch (error) {
      return failure('print_failed', safeErrorMessage(error, '打印机执行失败'));
    }
    const errors = Array.isArray(outcome && outcome.error) ? outcome.error : [];
    const successes = Array.isArray(outcome && outcome.success) ? outcome.success : [];
    if (errors.length > 0) {
      return failure('print_failed', safeErrorMessage(errors[0], '打印机执行失败'));
    }
    if (successes.length === 0) {
      return failure('print_result_unknown', 'WMS 未返回明确的打印成功结果');
    }
    return {
      success: true,
      code: printMode === 'reprint' ? 'reprinted' : 'printed',
      message: printMode === 'reprint' ? '订单已成功补打' : '订单已成功打印',
      printedCount: successes.length
    };
  }

  function buildPrintExecutionScript(orderNo, order, warehouseNo, printMode = 'print') {
    const normalized = normalizeOrderNo(orderNo);
    if (!normalized) throw new Error('订单号格式无效');
    const normalizedWarehouseNo = normalizeWarehouseNo(warehouseNo);
    if (!normalizedWarehouseNo) throw new Error('WMS 仓库编号格式无效');
    if (!order || typeof order !== 'object' || Array.isArray(order)) {
      throw new Error('WMS 订单数据格式无效');
    }
    if (!['print', 'reprint'].includes(printMode)) {
      throw new Error('WMS 打印模式无效');
    }
    const payloadJson = JSON.stringify({
      orderNo: normalized,
      warehouseNo: normalizedWarehouseNo,
      printMode,
      order
    });
    return '(' + executePrintInPage.toString() + ')(' + JSON.stringify(payloadJson) + ')';
  }

  return {
    buildPrintExecutionScript,
    executePrintInPage,
    findPrintComponents,
    normalizeOrderNo,
    normalizeWarehouseNo
  };
}));
