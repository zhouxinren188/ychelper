// ========== 全局状态 ==========
let tasks = [];
let taskIdCounter = 0;
let isExecuting = false;
let shopOptions = []; // 店铺选项数据
const BATCH_SIZE = 500; // 每个任务最大SKU数

// ========== DOM 引用 ==========
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const departmentNameEl = $('#departmentName');
const modeSelect = $('#modeSelect');
const skuInput = $('#skuInput');
const shopSelect = $('#shopSelect');           // hidden input
const shopSearchInput = $('#shopSearchInput');
const shopDropdown = $('#shopDropdown');
const warehouseSelect = $('#warehouseSelect');
const purchaseQty = $('#purchaseQty');
const taskTableBody = $('#taskTableBody');
const logBox = $('#logBox');

// ========== 初始化 ==========
(async () => {
  await loadUserData();
  await loadModes();
  initNavigation();
  initEventListeners();
})();

// ========== 加载用户数据 ==========
async function loadUserData() {
  const data = await window.electronAPI.getUserData();
  if (!data) return;

  // 事业部名称
  departmentNameEl.textContent = `事业部：${data.departmentName || ''}`;

  // 店铺列表（可搜索下拉）
  shopOptions = [];
  if (data.shops) {
    shopOptions = data.shops.map(shop => ({
      value: shop.shopId,
      spShopNo: shop.spShopNo || '',
      label: `${shop.shopName}（${shop.spShopNo || shop.shopId}）`
    }));
  }
  shopSelect.value = '';
  shopSearchInput.value = '';
  renderShopDropdown('');

  // 仓库列表
  warehouseSelect.innerHTML = '<option value="">请选择仓库</option>';
  if (data.warehouses) {
    data.warehouses.forEach(wh => {
      const opt = document.createElement('option');
      opt.value = wh.warehouseId;
      opt.textContent = `${wh.warehouseName}（${wh.warehouseId}）`;
      warehouseSelect.appendChild(opt);
    });
  }
}

// ========== 导航切换 ==========
function initNavigation() {
  $$('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      $$('.nav-item').forEach(n => n.classList.remove('active'));
      item.classList.add('active');

      const page = item.dataset.page;
      $$('.page').forEach(p => p.classList.remove('active'));
      $(`#page-${page}`).classList.add('active');
    });
  });
}

// ========== 事件绑定 ==========
function initEventListeners() {
  // 导入SKU文本
  $('#importSkuBtn').addEventListener('click', async () => {
    const content = await window.electronAPI.openFileDialog();
    if (content) {
      // 按行读取，去除空行
      const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const currentVal = skuInput.value.trim();
      if (currentVal) {
        skuInput.value = currentVal + '，' + lines.join('，');
      } else {
        skuInput.value = lines.join('，');
      }
      addLog('info', `已导入 ${lines.length} 个SKU`);
    }
  });

  // 添加任务
  $('#addTaskBtn').addEventListener('click', addTask);

  // 执行任务
  $('#execTaskBtn').addEventListener('click', executeTasks);

  // 打开输出目录
  $('#openDirBtn').addEventListener('click', () => {
    window.electronAPI.openOutputDir();
  });

  // 模式管理
  $('#modeManageBtn').addEventListener('click', openModeModal);
  $('#modeModalClose').addEventListener('click', closeModeModal);

  // 保存模式
  $('#modeSaveBtn').addEventListener('click', openSaveModal);
  $('#saveModalClose').addEventListener('click', closeSaveModal);
  $('#confirmSaveMode').addEventListener('click', confirmSaveMode);

  // 模式选择变更
  modeSelect.addEventListener('change', applyMode);

  // 弹窗遮罩点击关闭
  $('#modeModal').addEventListener('click', (e) => {
    if (e.target === $('#modeModal')) closeModeModal();
  });
  $('#saveModal').addEventListener('click', (e) => {
    if (e.target === $('#saveModal')) closeSaveModal();
  });
}

// ========== 添加任务 ==========
function addTask() {
  const skuText = skuInput.value.trim();
  if (!skuText) {
    alert('请输入商品SKU');
    skuInput.focus();
    return;
  }

  const shopId = shopSelect.value;
  const shopOpt = shopOptions.find(o => o.value === shopId);
  const shopName = shopOpt ? shopOpt.label : '';
  const spShopNo = shopOpt ? shopOpt.spShopNo : '';
  if (!shopId) {
    alert('请选择店铺');
    return;
  }

  const warehouseId = warehouseSelect.value;
  if (!warehouseId) {
    alert('请选择仓库');
    return;
  }

  // 解析 SKU（支持中英文逗号）
  const skus = skuText.split(/[,，]/).map(s => s.trim()).filter(Boolean);

  // 获取配置信息
  const config = getCurrentConfig();

  // 判断是否仅勾选了京配打标/取消京配打标步骤
  const onlyJdSteps = (config.jdLabel || config.cancelJdLabel) &&
    !config.importShopProduct && !config.enableShopProduct && !config.enableMasterData &&
    !config.disableMasterData && !config.inventoryRatio && !config.enablePurchase &&
    !config.disableShopProduct && !config.logistics;
  const batchSize = onlyJdSteps ? 5000 : BATCH_SIZE;

  // 获取当前选择的模式名称
  const modeName = modeSelect.value || '自定义';

  // 按 batchSize 拆分为多个任务，每个任务独立执行所有步骤
  const taskBatches = [];
  for (let i = 0; i < skus.length; i += batchSize) {
    taskBatches.push(skus.slice(i, i + batchSize));
  }

  for (const batchSkus of taskBatches) {
    taskIdCounter++;
    tasks.push({
      id: taskIdCounter,
      skus: batchSkus,
      shopId,
      spShopNo,
      shopName,
      warehouseId,
      config,
      modeName,
      status: 'pending'
    });
  }

  renderTaskTable();
  if (taskBatches.length > 1) {
    addLog('info', `已添加 ${taskBatches.length} 个任务（共${skus.length}个SKU，每任务最多${batchSize}个）`);
  } else {
    addLog('info', `已添加 1 个任务（${skus.length} 个SKU）`);
  }

  // 清空SKU输入
  skuInput.value = '';
}

// ========== 获取当前配置 ==========
function getCurrentConfig() {
  return {
    importShopProduct: $('#cfgImportShopProduct').checked,
    enableShopProduct: $('#cfgEnableShopProduct').checked,
    enableMasterData: $('#cfgEnableMasterData').checked,
    disableMasterData: $('#cfgDisableMasterData').checked,
    inventoryRatio: $('#cfgInventoryRatio').checked,
    inventoryRatioValue: $('#cfgInventoryRatioValue').value,
    jdLabel: $('#cfgJdLabel').checked,
    enablePurchase: $('#cfgEnablePurchase').checked,
    disableShopProduct: $('#cfgDisableShopProduct').checked,
    logistics: $('#cfgLogistics').checked,
    cancelJdLabel: $('#cfgCancelJdLabel').checked,
    logLength: $('#logLength').value,
    logWidth: $('#logWidth').value,
    logHeight: $('#logHeight').value,
    stepDelay: parseFloat($('#stepDelay').value) || 1,
    purchaseQty: parseInt(purchaseQty.value) || 0,
    autoAccept: $('#autoAccept').checked
  };
}

// ========== 应用配置 ==========
function applyConfig(config) {
  if (!config) return;
  $('#cfgImportShopProduct').checked = !!config.importShopProduct;
  $('#cfgEnableShopProduct').checked = !!config.enableShopProduct;
  $('#cfgEnableMasterData').checked = !!config.enableMasterData;
  $('#cfgDisableMasterData').checked = !!config.disableMasterData;
  $('#cfgInventoryRatio').checked = !!config.inventoryRatio;
  $('#cfgInventoryRatioValue').value = config.inventoryRatioValue || $('#cfgInventoryRatioValue').value || '100';
  $('#cfgJdLabel').checked = !!config.jdLabel;
  $('#cfgEnablePurchase').checked = !!config.enablePurchase;
  $('#cfgDisableShopProduct').checked = !!config.disableShopProduct;
  $('#cfgLogistics').checked = !!config.logistics;
  $('#cfgCancelJdLabel').checked = !!config.cancelJdLabel;
  $('#logLength').value = config.logLength || $('#logLength').value || '210';
  $('#logWidth').value = config.logWidth || $('#logWidth').value || '150';
  $('#logHeight').value = config.logHeight || $('#logHeight').value || '100';
  $('#stepDelay').value = config.stepDelay || $('#stepDelay').value || 10;
}

// ========== 渲染任务列表 ==========
function renderTaskTable() {
  taskTableBody.innerHTML = '';
  tasks.forEach((task, idx) => {
    const tr = document.createElement('tr');

    const statusMap = {
      pending: { text: '等待中', cls: 'status-pending' },
      running: { text: '执行中', cls: 'status-running' },
      success: { text: '成功', cls: 'status-success' },
      error: { text: '失败', cls: 'status-error' }
    };
    const st = statusMap[task.status] || statusMap.pending;

    const skuDisplay = task.skus.length <= 2
      ? task.skus.map(escapeHtml).join(', ')
      : `${task.skus.slice(0, 2).map(escapeHtml).join(', ')} 等${task.skus.length}个`;

    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td title="${task.skus.map(escapeHtml).join(', ')}">${skuDisplay}</td>
      <td>${escapeHtml(task.shopName)}</td>
      <td>${escapeHtml(task.modeName || '自定义')}</td>
      <td><span class="${st.cls}">${st.text}</span></td>
    `;

    // 右键删除任务
    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (isExecuting) {
        alert('任务执行中，无法删除');
        return;
      }
      if (task.status === 'running') {
        alert('该任务正在执行，无法删除');
        return;
      }
      if (confirm(`确认删除任务 ${idx + 1}？`)) {
        tasks.splice(idx, 1);
        renderTaskTable();
        addLog('info', `已删除任务 ${idx + 1}`);
      }
    });
    tr.style.cursor = 'context-menu';

    taskTableBody.appendChild(tr);
  });
}

// ========== 执行任务 ==========
async function executeTasks() {
  const pendingTasks = tasks.filter(t => t.status === 'pending');
  if (pendingTasks.length === 0) {
    alert('没有待执行的任务');
    return;
  }
  if (isExecuting) {
    alert('任务正在执行中，请等待完成');
    return;
  }

  isExecuting = true;
  addLog('info', `开始执行 ${pendingTasks.length} 个任务...`);

  for (const task of pendingTasks) {
    task.status = 'running';
    renderTaskTable();
    const skuLabel = task.skus.length <= 3 ? task.skus.join(',') : `${task.skus.slice(0, 3).join(',')}等${task.skus.length}个`;
    addLog('info', `[${skuLabel}] 开始执行...`);

    try {
      // 按照配置顺序执行各步骤
      const steps = getTaskSteps(task);
      for (const step of steps) {
        addLog('info', `[${skuLabel}] ${step.name}...`);

        await executeStep(step, task);

        addLog('success', `[${skuLabel}] ${step.name} 完成`);

        // 步骤延时
        if (task.config.stepDelay > 0) {
          await sleep(task.config.stepDelay * 1000);
        }
      }

      task.status = 'success';
      addLog('success', `[${skuLabel}] 全部完成`);
    } catch (err) {
      task.status = 'error';
      addLog('error', `[${skuLabel}] 失败: ${err.message}`);
    }

    renderTaskTable();
  }

  isExecuting = false;
  addLog('info', '所有任务执行完毕');
}

// ========== 获取任务步骤 ==========
function getTaskSteps(task) {
  const steps = [];
  const cfg = task.config;

  if (cfg.importShopProduct) steps.push({ key: 'importShopProduct', name: '导入店铺商品' });
  if (cfg.enableShopProduct) steps.push({ key: 'enableShopProduct', name: '启用店铺商品' });
  if (cfg.enableMasterData) steps.push({ key: 'enableMasterData', name: '启用商品主数据' });
  if (cfg.logistics) steps.push({ key: 'logistics', name: '维护物流属性' });
  if (cfg.inventoryRatio) steps.push({ key: 'inventoryRatio', name: '维护库存比例' });
  if (cfg.enablePurchase) steps.push({ key: 'enablePurchase', name: '启用采购入库' });
  if (cfg.jdLabel) steps.push({ key: 'jdLabel', name: '京配打标生效' });
  if (cfg.cancelJdLabel) steps.push({ key: 'cancelJdLabel', name: '取消京配打标' });
  if (cfg.disableShopProduct) steps.push({ key: 'disableShopProduct', name: '停用店铺商品' });
  if (cfg.disableMasterData) steps.push({ key: 'disableMasterData', name: '停用商品主数据' });

  if (steps.length === 0) {
    steps.push({ key: 'default', name: '默认打标' });
  }

  return steps;
}

// ========== 步骤执行（生成Excel + 预留API上传） ==========
// ========== 带限频重试的上传函数 ==========
async function uploadWithRetry(uploadParams, label, sku, maxRetries = 5) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const uploadRes = await window.electronAPI.uploadExcel(uploadParams);
    const d = uploadRes.data;

    // 构建友好的结果消息
    let resMsg;
    if (d?.msg) {
      resMsg = d.msg;
    } else if (d?.data && typeof d.data === 'string') {
      resMsg = d.data;
    } else if (d?.resultMessage != null && d?.totalNum != null) {
      // 采购入库格式: {resultMessage, successNum, failNum, totalNum}
      resMsg = `${d.resultMessage} 总计${d.totalNum}条，成功${d.successNum || 0}条，失败${d.failNum || 0}条`;
    } else if (d?.resultMessage) {
      resMsg = d.resultMessage;
    } else {
      resMsg = uploadRes.error || JSON.stringify(d);
    }

    // 先检测限频提示（即使 success=true 也可能是限频）
    const isRateLimit = typeof resMsg === 'string' && (resMsg.includes('只能导入一次') || resMsg.includes('后重试'));
    if (isRateLimit) {
      // 动态解析错误消息中的等待时间
      const minMatch = resMsg.match(/(\d+)\s*分钟/);
      const waitMinutes = minMatch ? parseInt(minMatch[1]) : 1;
      if (attempt < maxRetries) {
        addLog('warn', `[${sku}] ${label}: ${resMsg}，${waitMinutes}分钟后重试 (${attempt + 1}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, waitMinutes * 60000));
        continue;
      }
      addLog('error', `[${sku}] ${label}失败: ${resMsg}（重试次数已耗尽）`);
      return uploadRes;
    }

    // 判断是否成功
    const isOk = uploadRes.success && (d?.result || d?.success || (d?.resultCode === 1 && (d?.failNum == null || d?.failNum === 0)));
    if (isOk) {
      addLog('success', `[${sku}] ${label}: ${resMsg}`);
      return uploadRes;
    }

    // 部分成功（有成功也有失败）
    if (uploadRes.success && d?.resultCode === 1 && d?.successNum > 0 && d?.failNum > 0) {
      addLog('warn', `[${sku}] ${label}: ${resMsg}`);
      return uploadRes;
    }

    // 其他错误，不重试
    addLog('error', `[${sku}] ${label}失败: ${resMsg}`);
    return uploadRes;
  }
}

async function executeStep(step, task) {
  const userData = await window.electronAPI.getUserData();
  const cfg = task.config;
  const skuLabel = task.skus.length <= 3 ? task.skus.join(',') : `${task.skus.slice(0, 3).join(',')}等${task.skus.length}个`;

  // 将数组按批次拆分（安全兜底，正常任务已在添加时拆分）
  function splitBatches(arr, size) {
    const batches = [];
    for (let i = 0; i < arr.length; i += size) {
      batches.push(arr.slice(i, i + size));
    }
    return batches;
  }

  switch (step.key) {
    case 'importShopProduct': {
      const spShopNo = task.spShopNo || '';
      if (!spShopNo) {
        addLog('warn', `[${skuLabel}] 缺少销售平台店铺编号，跳过上传`);
        break;
      }
      const batches = splitBatches(task.skus, BATCH_SIZE);
      if (batches.length > 1) addLog('info', `[${skuLabel}] 共${task.skus.length}个SKU，分${batches.length}批上传（每批最多${BATCH_SIZE}）`);
      for (let i = 0; i < batches.length; i++) {
        const batchLabel = batches.length > 1 ? `批次${i + 1}/${batches.length}` : '';
        const result = await window.electronAPI.generateExcel({
          type: 'popGoodsImport',
          data: { skus: batches[i] }
        });
        if (!result.success) throw new Error(result.error);
        addLog('info', `[${skuLabel}] ${batchLabel} 已生成: PopGoodsImportTemplate.xls (${batches[i].length}个SKU)`);
        addLog('info', `[${skuLabel}] ${batchLabel} 正在上传到店铺商品管理...`);
        await uploadWithRetry({
          type: 'popGoodsImport',
          filePath: result.filePath,
          params: { spShopNo }
        }, `店铺商品导入${batchLabel}`, skuLabel);
      }
      break;
    }

    case 'enableShopProduct':
    case 'disableShopProduct': {
      const action = step.key === 'enableShopProduct' ? 'on' : 'off';
      const actionLabel = step.key === 'enableShopProduct' ? '启用' : '停用';
      // 需要操作的状态：启用时找status!=1的，停用时找status==1的
      const needActionStatus = step.key === 'enableShopProduct' ? (s => s != 1) : (s => s == 1);

      // 先查询店铺商品数据获取 id 和 status
      addLog('info', `[${skuLabel}] 正在查询店铺商品状态...`);
      const csgRes = await window.electronAPI.queryShopGoods({ skus: task.skus });
      if (!csgRes.success) throw new Error(`商品查询失败: ${csgRes.error}`);

      if (csgRes.failed && csgRes.failed.length > 0) {
        addLog('warn', `[${skuLabel}] 以下SKU未查询到: ${csgRes.failed.join(', ')}`);
      }

      const csgMap = csgRes.results || {};
      const allIds = [];
      let skippedCount = 0;
      for (const sku of task.skus) {
        const item = csgMap[sku]?.raw;
        if (item && item.id) {
          if (needActionStatus(item.status)) {
            allIds.push(String(item.id));
          } else {
            skippedCount++;
          }
        }
      }

      if (skippedCount > 0) {
        addLog('info', `[${skuLabel}] ${skippedCount} 个商品已是${actionLabel === '启用' ? '启用' : '停用'}状态，跳过`);
      }
      if (allIds.length === 0) {
        addLog('success', `[${skuLabel}] 所有商品已是目标状态，无需${actionLabel}`);
        break;
      }

      addLog('info', `[${skuLabel}] ${allIds.length} 个商品需要${actionLabel}，开始处理`);

      // 分批处理，每批最多50个
      const TOGGLE_BATCH = 50;
      const toggleBatches = splitBatches(allIds, TOGGLE_BATCH);
      if (toggleBatches.length > 1) addLog('info', `[${skuLabel}] 分${toggleBatches.length}批${actionLabel}`);

      let toggleOk = 0, toggleFail = 0;
      for (let i = 0; i < toggleBatches.length; i++) {
        const batch = toggleBatches[i];
        const batchLabel = toggleBatches.length > 1 ? `批次${i + 1}/${toggleBatches.length}` : '';

        if (i > 0) await sleep(5000);

        let retries = 3;
        let done = false;
        while (retries > 0) {
          addLog('info', `[${skuLabel}] ${batchLabel} 正在${actionLabel}店铺商品（${batch.length}个）...`);
          const res = await window.electronAPI.batchToggleShopGoods({ ids: batch, action });

          const d = res.data;
          let resMsg;
          if (typeof d === 'string') {
            resMsg = d;
          } else if (d?.errorMsg) {
            resMsg = d.errorMsg;
          } else if (d?.msg) {
            resMsg = d.msg;
          } else if (d?.resultMessage) {
            resMsg = d.resultMessage;
          } else {
            resMsg = res.error || JSON.stringify(d);
          }

          // 检测限流
          const isRateLimit = typeof resMsg === 'string' && (resMsg.includes('频繁') || resMsg.includes('后重试'));
          if (isRateLimit) {
            retries--;
            if (retries > 0) {
              const waitMatch = resMsg.match(/(\d+)\s*秒/);
              const waitSec = waitMatch ? parseInt(waitMatch[1]) : 5;
              addLog('warn', `[${skuLabel}] ${batchLabel} 限流，${waitSec}秒后重试...`);
              await sleep(waitSec * 1000);
              continue;
            }
          }

          if (res.success && d?.success !== false && !d?.errorMsg) {
            toggleOk += batch.length;
            done = true;
            addLog('success', `[${skuLabel}] ${batchLabel} ${actionLabel}成功（${batch.length}个）`);
          } else {
            toggleFail += batch.length;
            addLog('warn', `[${skuLabel}] ${batchLabel} ${actionLabel}失败: ${resMsg}`);
          }
          break;
        }
        if (!done && retries <= 0) {
          toggleFail += batch.length;
          addLog('warn', `[${skuLabel}] ${batchLabel} ${actionLabel}失败: 重试次数已耗尽`);
        }
      }
      addLog(toggleFail === 0 ? 'success' : 'warn', `[${skuLabel}] ${actionLabel}店铺商品完成: 成功${toggleOk}个，失败${toggleFail}个`);
      break;
    }

    case 'enableMasterData':
    case 'disableMasterData': {
      const mdAction = step.key === 'enableMasterData' ? 'on' : 'off';
      const mdLabel = step.key === 'enableMasterData' ? '启用' : '停用';
      // 需要操作的状态：启用时找status!=1的，停用时找status==1的
      const mdNeedAction = step.key === 'enableMasterData' ? (s => s != 1) : (s => s == 1);

      // 先查询店铺商品数据获取 goodsId 和 status
      addLog('info', `[${skuLabel}] 正在查询商品主数据状态...`);
      const mdCsgRes = await window.electronAPI.queryShopGoods({ skus: task.skus });
      if (!mdCsgRes.success) throw new Error(`商品查询失败: ${mdCsgRes.error}`);

      if (mdCsgRes.failed && mdCsgRes.failed.length > 0) {
        addLog('warn', `[${skuLabel}] 以下SKU未查询到: ${mdCsgRes.failed.join(', ')}`);
      }

      const mdCsgMap = mdCsgRes.results || {};
      const goodsIds = [];
      let mdSkipped = 0;
      for (const sku of task.skus) {
        const item = mdCsgMap[sku]?.raw;
        if (item) {
          const gid = item.goodsId || item.id;
          if (gid) {
            if (mdNeedAction(item.status)) {
              goodsIds.push(String(gid));
            } else {
              mdSkipped++;
            }
          }
        }
      }

      if (mdSkipped > 0) {
        addLog('info', `[${skuLabel}] ${mdSkipped} 个商品已是${mdLabel === '启用' ? '启用' : '停用'}状态，跳过`);
      }
      if (goodsIds.length === 0) {
        addLog('success', `[${skuLabel}] 所有商品已是目标状态，无需${mdLabel}主数据`);
        break;
      }

      addLog('info', `[${skuLabel}] ${goodsIds.length} 个商品需要${mdLabel}主数据，开始处理`);

      // 分批处理，每批最多50个
      const MD_BATCH = 50;
      const mdBatches = splitBatches(goodsIds, MD_BATCH);
      if (mdBatches.length > 1) addLog('info', `[${skuLabel}] 分${mdBatches.length}批${mdLabel}`);

      let mdOk = 0, mdFail = 0;
      for (let i = 0; i < mdBatches.length; i++) {
        const batch = mdBatches[i];
        const batchLabel = mdBatches.length > 1 ? `批次${i + 1}/${mdBatches.length}` : '';

        if (i > 0) await sleep(5000);

        let retries = 3;
        let done = false;
        while (retries > 0) {
          addLog('info', `[${skuLabel}] ${batchLabel} 正在${mdLabel}商品主数据（${batch.length}个）...`);
          const res = await window.electronAPI.batchToggleMasterData({ ids: batch, action: mdAction });

          const d = res.data;
          let resMsg;
          if (typeof d === 'string') {
            resMsg = d;
          } else if (d?.errorMsg) {
            resMsg = d.errorMsg;
          } else if (d?.msg) {
            resMsg = d.msg;
          } else if (d?.resultMessage) {
            resMsg = d.resultMessage;
          } else {
            resMsg = res.error || JSON.stringify(d);
          }

          // 检测限流
          const isRateLimit = typeof resMsg === 'string' && (resMsg.includes('频繁') || resMsg.includes('后重试'));
          if (isRateLimit) {
            retries--;
            if (retries > 0) {
              const waitMatch = resMsg.match(/(\d+)\s*秒/);
              const waitSec = waitMatch ? parseInt(waitMatch[1]) : 5;
              addLog('warn', `[${skuLabel}] ${batchLabel} 限流，${waitSec}秒后重试...`);
              await sleep(waitSec * 1000);
              continue;
            }
          }

          if (res.success && d?.success !== false && !d?.errorMsg) {
            mdOk += batch.length;
            done = true;
            addLog('success', `[${skuLabel}] ${batchLabel} ${mdLabel}主数据成功（${batch.length}个）`);
          } else {
            mdFail += batch.length;
            addLog('warn', `[${skuLabel}] ${batchLabel} ${mdLabel}主数据失败: ${resMsg}`);
          }
          break;
        }
        if (!done && retries <= 0) {
          mdFail += batch.length;
          addLog('warn', `[${skuLabel}] ${batchLabel} ${mdLabel}主数据失败: 重试次数已耗尽`);
        }
      }
      addLog(mdFail === 0 ? 'success' : 'warn', `[${skuLabel}] ${mdLabel}商品主数据完成: 成功${mdOk}个，失败${mdFail}个`);
      break;
    }

    case 'inventoryRatio': {
      const ratioValue = cfg.inventoryRatioValue || '100';

      // 先查询店铺商品完整数据
      addLog('info', `[${skuLabel}] 正在查询店铺商品数据...`);
      const csgResult = await window.electronAPI.queryShopGoods({ skus: task.skus });
      if (!csgResult.success) throw new Error(`商品查询失败: ${csgResult.error}`);

      if (csgResult.failed && csgResult.failed.length > 0) {
        addLog('warn', `[${skuLabel}] 以下SKU未查询到: ${csgResult.failed.join(', ')}`);
      }

      const csgMap = csgResult.results || {};
      const validSkus = task.skus.filter(sku => csgMap[sku] && csgMap[sku].raw);
      if (validSkus.length === 0) throw new Error('所有SKU均未查询到商品数据，无法继续');

      addLog('info', `[${skuLabel}] 成功查询到 ${validSkus.length} 个商品，库存比例: ${ratioValue}%`);

      // 批量保存，每批最多50个
      const RATIO_BATCH = 50;
      const ratioBatches = splitBatches(validSkus, RATIO_BATCH);
      if (ratioBatches.length > 1) addLog('info', `[${skuLabel}] 分${ratioBatches.length}批保存库存比例`);

      let ratioOk = 0, ratioFail = 0;
      for (let i = 0; i < ratioBatches.length; i++) {
        const batch = ratioBatches[i];
        const batchLabel = ratioBatches.length > 1 ? `批次${i + 1}/${ratioBatches.length}` : '';

        // 批次间隔1.5秒，避免限流
        if (i > 0) await sleep(5000);

        const shopGoodsList = batch.map(sku => csgMap[sku].raw);

        let retries = 3;
        let saved = false;
        while (retries > 0) {
          addLog('info', `[${skuLabel}] ${batchLabel} 正在保存库存比例（${batch.length}个）...`);
          const saveRes = await window.electronAPI.saveStockConfig({
            shopGoodsList,
            percent: ratioValue,
            vmiPercent: ratioValue,
            stockWay: '1'
          });

          const d = saveRes.data;
          let resMsg;
          if (typeof d === 'string') {
            resMsg = d;
          } else if (d?.errorMsg) {
            resMsg = d.errorMsg;
          } else if (d?.msg) {
            resMsg = d.msg;
          } else if (d?.resultMessage) {
            resMsg = d.resultMessage;
          } else {
            resMsg = saveRes.error || JSON.stringify(d);
          }

          // 检测限流
          const isRateLimit = typeof resMsg === 'string' && (resMsg.includes('频繁') || resMsg.includes('后重试'));
          if (isRateLimit) {
            retries--;
            if (retries > 0) {
              const waitMatch = resMsg.match(/(\d+)\s*秒/);
              const waitSec = waitMatch ? parseInt(waitMatch[1]) : 2;
              addLog('warn', `[${skuLabel}] ${batchLabel} 限流，${waitSec}秒后重试...`);
              await sleep(waitSec * 1000);
              continue;
            }
          }

          if (saveRes.success && d?.success !== false && !d?.errorMsg) {
            ratioOk += batch.length;
            saved = true;
            addLog('success', `[${skuLabel}] ${batchLabel} 库存比例保存成功（${batch.length}个）`);
          } else {
            ratioFail += batch.length;
            addLog('warn', `[${skuLabel}] ${batchLabel} 库存比例保存失败: ${resMsg}`);
          }
          break;
        }
        if (!saved && retries <= 0) {
          ratioFail += batch.length;
          addLog('warn', `[${skuLabel}] ${batchLabel} 库存比例保存失败: 重试次数已耗尽`);
        }
      }
      addLog(ratioFail === 0 ? 'success' : 'warn', `[${skuLabel}] 库存比例保存完成: 成功${ratioOk}个，失败${ratioFail}个`);
      break;
    }

    case 'logistics': {
      const batches = splitBatches(task.skus, BATCH_SIZE);
      if (batches.length > 1) addLog('info', `[${skuLabel}] 共${task.skus.length}个SKU，分${batches.length}批上传`);
      for (let i = 0; i < batches.length; i++) {
        const batchLabel = batches.length > 1 ? `批次${i + 1}/${batches.length}` : '';
        const result = await window.electronAPI.generateExcel({
          type: 'goodsLogistics',
          data: {
            skus: batches[i],
            departmentId: userData?.departmentId || '',
            length: cfg.logLength,
            width: cfg.logWidth,
            height: cfg.logHeight
          }
        });
        if (!result.success) throw new Error(result.error);
        addLog('info', `[${skuLabel}] ${batchLabel} 已生成: GoodsLogisticsTemplate.xls (${batches[i].length}个SKU)`);
        addLog('info', `[${skuLabel}] ${batchLabel} 正在上传到物流属性导入...`);
        await uploadWithRetry({
          type: 'goodsLogistics',
          filePath: result.filePath,
          params: {}
        }, `物流属性导入${batchLabel}`, skuLabel);
      }
      break;
    }

    case 'enablePurchase': {
      const suppliers = userData?.suppliers || [];
      const batches = splitBatches(task.skus, BATCH_SIZE);
      if (batches.length > 1) addLog('info', `[${skuLabel}] 共${task.skus.length}个SKU，分${batches.length}批上传（每批最多${BATCH_SIZE}）`);
      for (let i = 0; i < batches.length; i++) {
        const batchLabel = batches.length > 1 ? `批次${i + 1}/${batches.length}` : '';
        const result = await window.electronAPI.generateExcel({
          type: 'purchaseImport',
          data: {
            skus: batches[i],
            departmentId: userData?.departmentId || '',
            supplierId: suppliers[0]?.supplierId || '',
            warehouseId: task.warehouseId,
            purchaseQty: cfg.purchaseQty
          }
        });
        if (!result.success) throw new Error(result.error);
        addLog('info', `[${skuLabel}] ${batchLabel} 已生成: 采购入库单商品导入模板.xls (${batches[i].length}个SKU)`);
        addLog('info', `[${skuLabel}] ${batchLabel} 正在上传到采购入库管理...`);
        await uploadWithRetry({
          type: 'purchaseImport',
          filePath: result.filePath,
          params: {}
        }, `采购入库单导入${batchLabel}`, skuLabel);
      }
      break;
    }

    case 'jdLabel':
    case 'cancelJdLabel': {
      const enable = step.key === 'jdLabel';
      // 先查询所有SKU对应的CSG编码
      addLog('info', `[${skuLabel}] 正在查询店铺商品编号(CSG)...`);
      const csgResult = await window.electronAPI.queryShopGoods({ skus: task.skus });
      if (!csgResult.success) {
        throw new Error(`CSG查询失败: ${csgResult.error}`);
      }
      if (csgResult.failed && csgResult.failed.length > 0) {
        addLog('warn', `[${skuLabel}] 以下SKU未查询到CSG编码: ${csgResult.failed.join(', ')}`);
      }
      const csgMap = csgResult.results || {};
      // 过滤出有CSG编码的SKU
      const validSkus = task.skus.filter(sku => csgMap[sku] && csgMap[sku].shopGoodsNo);
      if (validSkus.length === 0) {
        throw new Error('所有SKU均未查询到CSG编码，无法继续');
      }
      addLog('info', `[${skuLabel}] 成功查询到 ${validSkus.length} 个CSG编码`);

      // 判断是否仅京配步骤单独运行，若是则不拆分
      const jdOnlySteps = !cfg.importShopProduct && !cfg.enableShopProduct && !cfg.enableMasterData &&
        !cfg.disableMasterData && !cfg.inventoryRatio && !cfg.enablePurchase &&
        !cfg.disableShopProduct && !cfg.logistics;
      const jdBatchSize = jdOnlySteps ? validSkus.length : BATCH_SIZE;

      const batches = splitBatches(validSkus, jdBatchSize);
      if (batches.length > 1) addLog('info', `[${skuLabel}] 共${validSkus.length}个SKU，分${batches.length}批上传`);
      for (let i = 0; i < batches.length; i++) {
        const batchLabel = batches.length > 1 ? `批次${i + 1}/${batches.length}` : '';
        const result = await window.electronAPI.generateExcel({
          type: 'updateShopGoods',
          data: {
            items: batches[i].map(sku => ({ shopProductId: csgMap[sku].shopGoodsNo, enable }))
          }
        });
        if (!result.success) throw new Error(result.error);
        addLog('info', `[${skuLabel}] ${batchLabel} 已生成: updateShopGoodsImportTemplate.xls (${enable ? '生效' : '取消'})`);
        addLog('info', `[${skuLabel}] ${batchLabel} 正在上传到店铺商品管理...`);
        await uploadWithRetry({
          type: 'updateShopGoods',
          filePath: result.filePath,
          params: {}
        }, `店铺商品更新${batchLabel}`, skuLabel);
      }
      break;
    }

    default: {
      addLog('warn', `[${skuLabel}] 未知步骤: ${step.key}`);
    }
  }
}

// ========== 快捷模式 ==========
async function loadModes() {
  const modes = await window.electronAPI.getModes();
  modeSelect.innerHTML = '<option value="">入仓打标（下拉可选择）</option>';
  modes.forEach(mode => {
    const opt = document.createElement('option');
    opt.value = mode.name;
    opt.textContent = mode.name;
    modeSelect.appendChild(opt);
  });
}

function applyMode() {
  const modeName = modeSelect.value;
  if (!modeName) return;

  window.electronAPI.getModes().then(modes => {
    const mode = modes.find(m => m.name === modeName);
    if (mode && mode.config) {
      applyConfig(mode.config);
      addLog('info', `已应用模式：${modeName}`);
    }
  });
}

function openModeModal() {
  const modal = $('#modeModal');
  modal.style.display = 'flex';

  window.electronAPI.getModes().then(modes => {
    const list = $('#modeList');
    const empty = $('#modeEmpty');

    if (modes.length === 0) {
      list.style.display = 'none';
      empty.style.display = 'block';
    } else {
      list.style.display = 'flex';
      empty.style.display = 'none';
      list.innerHTML = '';

      modes.forEach(mode => {
        const item = document.createElement('div');
        item.className = 'mode-list-item';
        item.innerHTML = `
          <span>${escapeHtml(mode.name)}</span>
          <button class="btn btn-danger" data-name="${escapeHtml(mode.name)}">删除</button>
        `;
        item.querySelector('button').addEventListener('click', async () => {
          await window.electronAPI.deleteMode(mode.name);
          await loadModes();
          openModeModal(); // 刷新列表
          addLog('info', `已删除模式：${mode.name}`);
        });
        list.appendChild(item);
      });
    }
  });
}

function closeModeModal() {
  $('#modeModal').style.display = 'none';
}

function openSaveModal() {
  $('#saveModal').style.display = 'flex';
  $('#modeNameInput').value = '';
  $('#modeNameInput').focus();
}

function closeSaveModal() {
  $('#saveModal').style.display = 'none';
}

async function confirmSaveMode() {
  const name = $('#modeNameInput').value.trim();
  if (!name) {
    alert('请输入模式名称');
    return;
  }

  const config = getCurrentConfig();
  await window.electronAPI.saveMode({ name, config });
  await loadModes();
  closeSaveModal();
  addLog('success', `模式"${name}"已保存`);
}

// ========== 日志 ==========
function addLog(type, message) {
  const now = new Date();
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const div = document.createElement('div');
  div.className = `log-${type}`;
  div.textContent = `[${time}] ${message}`;
  logBox.appendChild(div);
  logBox.scrollTop = logBox.scrollHeight;
}

// ========== 工具函数 ==========
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ========== 可搜索店铺下拉框 ==========

function renderShopDropdown(keyword) {
  shopDropdown.innerHTML = '';
  const kw = keyword.toLowerCase();
  const filtered = kw
    ? shopOptions.filter(o => o.label.toLowerCase().includes(kw))
    : shopOptions;

  if (filtered.length === 0) {
    shopDropdown.innerHTML = '<div class="searchable-no-result">无匹配结果</div>';
    return;
  }

  filtered.forEach(opt => {
    const div = document.createElement('div');
    div.className = 'searchable-option';
    if (opt.value === shopSelect.value) {
      div.classList.add('selected');
    }
    div.textContent = opt.label;
    div.addEventListener('mousedown', (e) => {
      e.preventDefault(); // 防止 input 失焦
      selectShop(opt);
    });
    shopDropdown.appendChild(div);
  });
}

function selectShop(opt) {
  shopSelect.value = opt.value;
  shopSearchInput.value = opt.label;
  closeShopDropdown();
}

function openShopDropdown() {
  renderShopDropdown(shopSearchInput.value.trim() === getShopLabelByValue(shopSelect.value) ? '' : shopSearchInput.value.trim());
  shopDropdown.classList.add('open');
}

function closeShopDropdown() {
  shopDropdown.classList.remove('open');
}

function getShopLabelByValue(val) {
  const opt = shopOptions.find(o => o.value === val);
  return opt ? opt.label : '';
}

// 店铺搜索事件绑定
shopSearchInput.addEventListener('focus', () => {
  shopSearchInput.select();
  openShopDropdown();
});

shopSearchInput.addEventListener('input', () => {
  renderShopDropdown(shopSearchInput.value.trim());
  shopDropdown.classList.add('open');
  // 输入时清除已选值（除非精确匹配）
  const match = shopOptions.find(o => o.label === shopSearchInput.value.trim());
  shopSelect.value = match ? match.value : '';
});

shopSearchInput.addEventListener('blur', () => {
  // 延迟关闭，允许 mousedown 事件先触发
  setTimeout(() => {
    closeShopDropdown();
    // 如果没有选中有效值，恢复显示
    if (shopSelect.value) {
      shopSearchInput.value = getShopLabelByValue(shopSelect.value);
    } else {
      shopSearchInput.value = '';
    }
  }, 150);
});

shopSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeShopDropdown();
    shopSearchInput.blur();
  }
  if (e.key === 'Enter') {
    // 选中第一个匹配项
    const first = shopDropdown.querySelector('.searchable-option');
    if (first) {
      const kw = shopSearchInput.value.trim().toLowerCase();
      const match = shopOptions.find(o => o.label.toLowerCase().includes(kw));
      if (match) selectShop(match);
    }
    e.preventDefault();
  }
});

// 点击箭头也展开
$('#shopSelectWrapper').addEventListener('click', (e) => {
  if (e.target === shopSearchInput) return;
  shopSearchInput.focus();
});

// ========== WMS 验收上架 ==========
let wmsLoggedIn = false;
let wmsOrders = [];
let wmsIsProcessing = false;
let wmsAutoMode = false;      // 自动验收是否开启
let wmsAutoTimer = null;      // 自动验收定时器
let wmsTotalAcceptedOrders = 0;  // 已验收单据数（运行期间累计）
let wmsTotalAcceptedSkus = 0;    // 已验收SKU数（运行期间累计）
const WMS_AUTO_INTERVAL = 5 * 60 * 1000; // 5分钟

// WMS DOM 引用
const wmsLoginBtn = $('#wmsLoginBtn');
const wmsQueryBtn = $('#wmsQueryBtn');
const wmsReceiveBtn = $('#wmsReceiveBtn');
const wmsAutoBtn = $('#wmsAutoBtn');
const wmsOrderTableBody = $('#wmsOrderTableBody');
const wmsLogBox = $('#wmsLogBox');
const wmsStatusDot = $('#wmsStatusDot');
const wmsStatusText = $('#wmsStatusText');
const wmsOrderCount = $('#wmsOrderCount');
const wmsUsernameInput = $('#wmsUsername');
const wmsPasswordInput = $('#wmsPassword');
const wmsWarehouseNameEl = $('#wmsWarehouseName');
const wmsLocationInput = $('#wmsLocationInput');

// WMS 初始化
function initWmsEventListeners() {
  if (!wmsLoginBtn) return;

  // 加载已保存的 WMS 凭据
  if (window.electronAPI.getWmsCredentials) {
    window.electronAPI.getWmsCredentials().then(cred => {
      if (cred && wmsUsernameInput && wmsPasswordInput) {
        wmsUsernameInput.value = cred.username || '';
        wmsPasswordInput.value = cred.password || '';
      }
    });
  }

  // 加载已保存的储位号
  if (window.electronAPI.getWmsLocation) {
    window.electronAPI.getWmsLocation().then(loc => {
      if (loc && wmsLocationInput) {
        wmsLocationInput.value = loc;
      }
    });
  }

  // 储位号输入变化时自动保存
  if (wmsLocationInput) {
    wmsLocationInput.addEventListener('change', () => {
      const loc = wmsLocationInput.value.trim();
      if (window.electronAPI.saveWmsLocation) {
        window.electronAPI.saveWmsLocation(loc);
      }
    });
  }

  // 全选/取消全选
  const wmsSelectAll = document.getElementById('wmsSelectAll');
  if (wmsSelectAll) {
    wmsSelectAll.addEventListener('change', () => {
      const checks = wmsOrderTableBody.querySelectorAll('.wms-order-check');
      checks.forEach(cb => { cb.checked = wmsSelectAll.checked; });
    });
    wmsOrderTableBody.addEventListener('change', (e) => {
      if (e.target.classList.contains('wms-order-check')) {
        const checks = wmsOrderTableBody.querySelectorAll('.wms-order-check');
        wmsSelectAll.checked = Array.from(checks).every(cb => cb.checked);
      }
    });
  }

  // 登录按钮
  wmsLoginBtn.addEventListener('click', () => {
    const username = wmsUsernameInput ? wmsUsernameInput.value.trim() : '';
    const password = wmsPasswordInput ? wmsPasswordInput.value : '';
    // 保存 WMS 凭据
    if (username && window.electronAPI.saveWmsCredentials) {
      window.electronAPI.saveWmsCredentials({ username, password });
    }
    addWmsLog('info', '正在打开 WMS 登录窗口...');
    window.electronAPI.openWmsLogin({ username, password });
  });

  // 查询按钮
  wmsQueryBtn.addEventListener('click', async () => {
    if (wmsIsProcessing) return;
    await handleWmsQuery();
  });

  // 一键验收
  wmsReceiveBtn.addEventListener('click', async () => {
    if (wmsIsProcessing) return;

    const locationNo = wmsLocationInput ? wmsLocationInput.value.trim() : '';
    if (!locationNo) {
      addWmsLog('warn', '请先填写上架储位号');
      return;
    }
    if (wmsOrders.length === 0) {
      addWmsLog('warn', '没有待验收的单据，请先查询');
      return;
    }

    // 获取勾选的单据
    const checkedIndexes = [];
    const checks = wmsOrderTableBody.querySelectorAll('.wms-order-check');
    checks.forEach(cb => {
      if (cb.checked) checkedIndexes.push(parseInt(cb.dataset.idx));
    });
    const selectedOrders = checkedIndexes.map(i => wmsOrders[i]).filter(Boolean);
    if (selectedOrders.length === 0) {
      addWmsLog('warn', '请至少勾选一个单据');
      return;
    }

    wmsIsProcessing = true;
    wmsReceiveBtn.disabled = true;
    wmsQueryBtn.disabled = true;
    wmsAutoBtn.disabled = true;

    let successCount = 0;
    let failCount = 0;
    addWmsLog('info', `开始一键验收，共 ${selectedOrders.length} 个单据...`);

    for (let i = 0; i < selectedOrders.length; i++) {
      const order = selectedOrders[i];
      addWmsLog('info', `[${i + 1}/${selectedOrders.length}] 正在验收: ${order.inboundNo}...`);
      try {
        const result = await window.electronAPI.wmsAcceptOrder({
          inboundNo: order.inboundNo,
          warehouseNo: order.warehouseNo,
          locationNo
        });
        if (result.success) {
          successCount++;
          wmsTotalAcceptedOrders++;
          wmsTotalAcceptedSkus += (result.count || 0);
          updateWmsStats();
          const warnMsg = result.warning ? ` (${result.failCount}个SKU失败)` : '';
          addWmsLog('success', `[${i + 1}/${selectedOrders.length}] ${order.inboundNo} 验收成功，${result.count} 个SKU${warnMsg}`);
        } else {
          failCount++;
          addWmsLog('error', `[${i + 1}/${selectedOrders.length}] ${order.inboundNo} 验收失败: ${result.error}`);
        }
      } catch (err) {
        failCount++;
        addWmsLog('error', `[${i + 1}/${selectedOrders.length}] ${order.inboundNo} 异常: ${err.message}`);
      }
    }

    addWmsLog('info', `验收完成！成功: ${successCount}, 失败: ${failCount}`);
    wmsIsProcessing = false;
    wmsReceiveBtn.disabled = false;
    wmsQueryBtn.disabled = false;
    wmsAutoBtn.disabled = false;
  });

  // 开启/关闭自动验收
  wmsAutoBtn.addEventListener('click', () => {
    if (!wmsLoggedIn) {
      addWmsLog('warn', '请先登录 WMS 系统');
      return;
    }
    const locationNo = wmsLocationInput ? wmsLocationInput.value.trim() : '';
    if (!locationNo && !wmsAutoMode) {
      addWmsLog('warn', '请先填写上架储位号');
      return;
    }

    if (wmsAutoMode) {
      // 关闭自动验收
      wmsAutoMode = false;
      if (wmsAutoTimer) {
        clearInterval(wmsAutoTimer);
        wmsAutoTimer = null;
      }
      wmsAutoBtn.textContent = '开启自动验收';
      wmsAutoBtn.classList.remove('wms-btn-auto-active');
      addWmsLog('info', '自动验收已关闭');
    } else {
      // 开启自动验收
      wmsAutoMode = true;
      wmsAutoBtn.textContent = '关闭自动验收';
      wmsAutoBtn.classList.add('wms-btn-auto-active');
      addWmsLog('success', '自动验收已开启，每 5 分钟扫描一次待验收单据');
      // 立即执行一次
      runAutoAcceptance();
      // 设置定时器
      wmsAutoTimer = setInterval(() => {
        runAutoAcceptance();
      }, WMS_AUTO_INTERVAL);
    }
  });

  // 监听 WMS 登录成功通知
  if (window.electronAPI.onWmsLoginSuccess) {
    window.electronAPI.onWmsLoginSuccess((data) => {
      const warehouseName = data?.warehouseName || '';
      updateWmsLoginStatus(true, warehouseName);
      const logMsg = warehouseName ? `WMS 系统登录成功，仓库: ${warehouseName}` : 'WMS 系统登录成功';
      addWmsLog('success', logMsg);
    });
  }
}

// 更新 WMS 登录状态
function updateWmsLoginStatus(loggedIn, warehouseName) {
  wmsLoggedIn = loggedIn;

  if (loggedIn) {
    wmsStatusDot.classList.add('online');
    wmsStatusText.textContent = 'WMS 已登录';
    wmsStatusText.classList.add('online');
    if (warehouseName && wmsWarehouseNameEl) {
      wmsWarehouseNameEl.textContent = warehouseName;
      wmsWarehouseNameEl.style.display = 'block';
    }
    wmsLoginBtn.textContent = '重新登录';
    wmsQueryBtn.disabled = false;
    wmsReceiveBtn.disabled = false;
    wmsAutoBtn.disabled = false;
  } else {
    wmsStatusDot.classList.remove('online');
    wmsStatusText.textContent = 'WMS 未登录';
    wmsStatusText.classList.remove('online');
    if (wmsWarehouseNameEl) {
      wmsWarehouseNameEl.style.display = 'none';
      wmsWarehouseNameEl.textContent = '';
    }
    wmsLoginBtn.textContent = '登录 WMS 系统';
    wmsQueryBtn.disabled = true;
    wmsReceiveBtn.disabled = true;
    wmsAutoBtn.disabled = true;
  }
}

// 渲染 WMS 入库单据表格
function renderWmsOrderTable() {
  if (wmsOrders.length === 0) {
    wmsOrderTableBody.innerHTML = `
      <tr class="wms-empty-row">
        <td colspan="8" class="wms-empty-state">暂无数据，请先查询</td>
      </tr>`;
    wmsOrderCount.classList.remove('visible');
    const selectAll = document.getElementById('wmsSelectAll');
    if (selectAll) selectAll.checked = false;
    return;
  }

  wmsOrderCount.textContent = `${wmsOrders.length} 条`;
  wmsOrderCount.classList.add('visible');

  wmsOrderTableBody.innerHTML = '';
  wmsOrders.forEach((order, idx) => {
    const statusBadge = getWmsStatusBadge(order.inboundStatusName || order.status);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" class="wms-order-check" data-idx="${idx}" checked /></td>
      <td>${idx + 1}</td>
      <td>${escapeHtml(order.inboundNo || '')}</td>
      <td>${escapeHtml(order.inboundTypeName || '')}</td>
      <td>${escapeHtml(order.supplierName || order.ownerName || '')}</td>
      <td>${order.expectedQty != null ? order.expectedQty : ''}</td>
      <td>${statusBadge}</td>
      <td>${escapeHtml(order.createTime || '')}</td>
    `;
    wmsOrderTableBody.appendChild(tr);
  });

  // 同步全选框状态
  const selectAll = document.getElementById('wmsSelectAll');
  if (selectAll) selectAll.checked = true;
}

// 获取状态标签 HTML
function getWmsStatusBadge(status) {
  const statusStr = String(status || '');
  if (statusStr.includes('待收货')) {
    return `<span class="wms-badge wms-badge-pending">待收货</span>`;
  } else if (statusStr.includes('已收货') || statusStr.includes('待验收')) {
    return `<span class="wms-badge wms-badge-received">已收货</span>`;
  } else if (statusStr.includes('已完验') || statusStr.includes('已上架')) {
    return `<span class="wms-badge wms-badge-done">已完验</span>`;
  }
  return `<span class="wms-badge">${escapeHtml(statusStr)}</span>`;
}

// WMS 专用日志
function addWmsLog(type, message) {
  const now = new Date();
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const div = document.createElement('div');
  div.className = `log-${type}`;
  div.textContent = `[${time}] ${message}`;
  wmsLogBox.appendChild(div);
  wmsLogBox.scrollTop = wmsLogBox.scrollHeight;
}

function updateWmsStats() {
  const ordersEl = document.getElementById('wmsStatOrders');
  const skusEl = document.getElementById('wmsStatSkus');
  if (ordersEl) ordersEl.textContent = wmsTotalAcceptedOrders;
  if (skusEl) skusEl.textContent = wmsTotalAcceptedSkus;
}

// WMS 查询入库单据
async function handleWmsQuery() {
  wmsIsProcessing = true;
  wmsQueryBtn.disabled = true;
  wmsQueryBtn.textContent = '查询中...';
  addWmsLog('info', '正在查询待验收单据...');

  try {
    // 从商家端获取仓库编号（userData 中已有）
    const userData = await window.electronAPI.getUserData();
    const warehouses = userData?.warehouses || [];
    const warehouseNo = warehouses.length > 0 ? warehouses[0].warehouseId : '';

    const result = await window.electronAPI.wmsQueryOrders({ warehouseNo });

    if (result.success) {
      wmsOrders = result.orders;
      renderWmsOrderTable();
      addWmsLog('success', `查询完成，共 ${result.orders.length} 条单据`);
    } else {
      wmsOrders = [];
      renderWmsOrderTable();
      addWmsLog('error', `查询失败: ${result.error}`);
    }
  } catch (err) {
    addWmsLog('error', `查询异常: ${err.message}`);
  } finally {
    wmsIsProcessing = false;
    wmsQueryBtn.disabled = false;
    wmsQueryBtn.textContent = '查询待验收单据';
  }
}

// 自动验收：查询 + 验收全部单据
async function runAutoAcceptance() {
  if (wmsIsProcessing) {
    addWmsLog('warn', '[自动验收] 当前有任务进行中，跳过本次扫描');
    return;
  }
  if (!wmsAutoMode) return;

  const locationNo = wmsLocationInput ? wmsLocationInput.value.trim() : '';
  if (!locationNo) {
    addWmsLog('warn', '[自动验收] 上架储位号为空，已自动停止');
    wmsAutoMode = false;
    if (wmsAutoTimer) { clearInterval(wmsAutoTimer); wmsAutoTimer = null; }
    wmsAutoBtn.textContent = '开启自动验收';
    wmsAutoBtn.classList.remove('wms-btn-auto-active');
    return;
  }

  wmsIsProcessing = true;
  addWmsLog('info', '[自动验收] 正在扫描待验收单据...');

  try {
    const userData = await window.electronAPI.getUserData();
    const warehouses = userData?.warehouses || [];
    const warehouseNo = warehouses.length > 0 ? warehouses[0].warehouseId : '';

    const queryResult = await window.electronAPI.wmsQueryOrders({ warehouseNo });

    if (!queryResult.success) {
      addWmsLog('error', `[自动验收] 查询失败: ${queryResult.error}`);
      wmsIsProcessing = false;
      return;
    }

    wmsOrders = queryResult.orders;
    renderWmsOrderTable();

    if (wmsOrders.length === 0) {
      addWmsLog('info', '[自动验收] 暂无待验收单据，等待下次扫描');
      wmsIsProcessing = false;
      return;
    }

    addWmsLog('success', `[自动验收] 扫描到 ${wmsOrders.length} 条待验收单据，开始自动验收...`);

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < wmsOrders.length; i++) {
      if (!wmsAutoMode) {
        addWmsLog('warn', '[自动验收] 已手动关闭，中止验收');
        break;
      }
      const order = wmsOrders[i];
      addWmsLog('info', `[自动验收] [${i + 1}/${wmsOrders.length}] 正在验收: ${order.inboundNo}...`);
      try {
        const result = await window.electronAPI.wmsAcceptOrder({
          inboundNo: order.inboundNo,
          warehouseNo: order.warehouseNo,
          locationNo
        });
        if (result.success) {
          successCount++;
          wmsTotalAcceptedOrders++;
          wmsTotalAcceptedSkus += (result.count || 0);
          updateWmsStats();
          const warnMsg = result.warning ? ` (${result.failCount}个SKU失败)` : '';
          addWmsLog('success', `[自动验收] [${i + 1}/${wmsOrders.length}] ${order.inboundNo} 验收成功，${result.count} 个SKU${warnMsg}`);
        } else {
          failCount++;
          addWmsLog('error', `[自动验收] [${i + 1}/${wmsOrders.length}] ${order.inboundNo} 验收失败: ${result.error}`);
        }
      } catch (err) {
        failCount++;
        addWmsLog('error', `[自动验收] [${i + 1}/${wmsOrders.length}] ${order.inboundNo} 异常: ${err.message}`);
      }
    }

    addWmsLog('info', `[自动验收] 本轮完成！成功: ${successCount}, 失败: ${failCount}`);

    // 验收完毕后重新查询刷新列表
    const refreshResult = await window.electronAPI.wmsQueryOrders({ warehouseNo });
    if (refreshResult.success) {
      wmsOrders = refreshResult.orders;
      renderWmsOrderTable();
    }
  } catch (err) {
    addWmsLog('error', `[自动验收] 异常: ${err.message}`);
  } finally {
    wmsIsProcessing = false;
  }
}

// 检查 WMS 初始登录状态
async function checkWmsInitialStatus() {
  if (window.electronAPI.getWmsLoginStatus) {
    const status = await window.electronAPI.getWmsLoginStatus();
    if (status) {
      updateWmsLoginStatus(true);
    }
  }
}

// 初始化 WMS 模块
initWmsEventListeners();
checkWmsInitialStatus();
