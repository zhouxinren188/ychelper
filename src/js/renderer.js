// ========== 全局状态 ==========
let tasks = [];
let taskIdCounter = 0;
let isExecuting = false;
let stopRequested = false;
let shopOptions = []; // 店铺选项数据（当前事业部过滤后）
let allShopOptions = []; // 全量店铺选项（不受事业部筛选影响）
let importedFileName = ''; // 当前导入的文本文件名（无扩展名）
let currentTier = 'basic'; // 当前订阅版本：basic, standard, premium
let previousDeptValue = ''; // 事业部切换前的值，用于回退

// ========== Toast 提示（替代 alert，非阻塞） ==========
function showToast(msg, duration = 3000, type = '') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const item = document.createElement('div');
  item.className = 'toast-item' + (type ? ' ' + type : '');
  item.textContent = msg;
  container.appendChild(item);
  setTimeout(() => {
    item.classList.add('out');
    item.addEventListener('animationend', () => item.remove());
  }, duration);
}
const BATCH_SIZE = 500; // 每个任务最大SKU数

// 显示版本号
window.electronAPI.getAppVersion().then(v => {
  const el = document.getElementById('appVersion');
  if (el) el.textContent = 'v' + v;
});

// ========== DOM 引用 ==========
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const departmentNameEl = $('#departmentName');
const modeSelect = $('#modeSelect');
const skuInput = $('#skuInput');
const shopSelect = $('#shopSelect');           // hidden input
const shopSearchInput = $('#shopSearchInput');
const shopDropdown = $('#shopDropdown');
const deptSelect = $('#deptSelect');
const warehouseSelect = $('#warehouseSelect');
const purchaseQty = $('#purchaseQty');
const taskTableBody = $('#taskTableBody');
const logBox = $('#logBox');

// ========== 初始化 ==========
(async () => {
  await loadUserData();
  await loadModes();
  await loadSubscriptionInfo();
  initNavigation();
  initEventListeners();
  initSubscriptionListeners();
  initSmModule();
  initAoModule();
  initWmsPrintOutbound();
  initContactModal();
  loadLogisticsPrefs();
})();

// ========== 加载用户数据 ==========
async function loadUserData() {
  const data = await window.electronAPI.getUserData();
  if (!data) return;

  // 商家名称
  departmentNameEl.textContent = `商家名称：${data.merchantName || data.departmentName || ''}`;

  // 全量店铺列表
  allShopOptions = [];
  if (data.shops) {
    allShopOptions = data.shops.map(shop => ({
      value: shop.shopId,
      spShopNo: shop.spShopNo || '',
      deptId: shop.deptId || '',
      deptNo: shop.deptNo || '',
      deptName: shop.deptName || '',
      sellerId: shop.sellerId || '',
      label: `${shop.shopName}（${shop.spShopNo || shop.shopId}）`
    }));
    console.log(`[店铺数据] 共 ${allShopOptions.length} 个店铺`);
    console.log(`[店铺数据] sellerId→店铺数:`, Object.fromEntries([...new Set(allShopOptions.map(s => s.sellerId || '(空)'))].map(id => [id, allShopOptions.filter(s => s.sellerId === id || (!id && !s.sellerId)).length])));
    console.log(`[店铺数据] deptName→店铺数:`, Object.fromEntries([...new Set(allShopOptions.map(s => s.deptName || '(空)'))].map(n => [n, allShopOptions.filter(s => s.deptName === n || (!n && !s.deptName)).length])));
  }

  // 事业部下拉框（始终显示）
  deptSelect.innerHTML = '<option value="" disabled selected hidden>请选择事业部</option>';
  if (data.deptPairs && data.deptPairs.length > 0) {
    data.deptPairs.forEach(dp => {
      const opt = document.createElement('option');
      opt.value = dp.deptNo;
      opt.textContent = dp.deptName;
      opt.dataset.deptName = dp.deptName;
      opt.dataset.id = dp.id || '';
      deptSelect.appendChild(opt);
    });
    console.log('[事业部数据] deptPairs:', data.deptPairs.map(p => ({ id: p.id, deptNo: p.deptNo, deptName: p.deptName, sellerId: p.sellerId })));
    // 自动选中：优先使用当前订阅的事业部，否则选第一个
    const selectedDeptId = data.selectedDeptId || data.departmentId || '';
    if (selectedDeptId && data.deptPairs.find(p => p.deptNo === selectedDeptId)) {
      deptSelect.value = selectedDeptId;
    } else if (data.deptPairs.length === 1) {
      deptSelect.value = data.deptPairs[0].deptNo;
    }
  }
  deptSelect.closest('.form-row').style.display = '';

  // 根据当前事业部筛选店铺
  filterShopsByDept();

  // 记录初始选中值，用于切换回退
  previousDeptValue = deptSelect.value;

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
    const result = await window.electronAPI.openFileDialog();
    if (result) {
      const content = typeof result === 'string' ? result : result.content;
      importedFileName = (result && result.fileName) ? result.fileName : '';
      // 按行读取，去除空行
      const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const currentVal = skuInput.value.trim();
      if (currentVal) {
        skuInput.value = currentVal + '，' + lines.join('，');
      } else {
        skuInput.value = lines.join('，');
      }
      addLog('info', `已导入 ${lines.length} 个SKU${importedFileName ? '（' + importedFileName + '）' : ''}`);
    }
  });

  // 添加任务
  $('#addTaskBtn').addEventListener('click', addTask);

  // 执行任务 / 停止任务
  $('#execTaskBtn').addEventListener('click', () => {
    if (isExecuting) {
      $('#stopTaskModal').style.display = 'flex';
    } else {
      executeTasks();
    }
  });

  // 停止任务确认弹窗
  $('#stopTaskYes').addEventListener('click', () => {
    stopRequested = true;
    $('#stopTaskModal').style.display = 'none';
    addLog('warn', '正在停止任务，等待当前步骤完成...');
  });
  $('#stopTaskNo').addEventListener('click', () => {
    $('#stopTaskModal').style.display = 'none';
  });
  $('#stopTaskCancelBtn').addEventListener('click', () => {
    $('#stopTaskModal').style.display = 'none';
  });

  // 打开输出目录
  $('#openDirBtn').addEventListener('click', () => {
    window.electronAPI.openOutputDir();
  });

  // 物流属性 & 步骤延时 - 自动记住
  LOGI_KEYS.forEach(k => {
    const el = $('#' + k);
    if (el) el.addEventListener('change', saveLogisticsPrefs);
  });

  // 模式管理
  $('#modeManageBtn').addEventListener('click', openModeModal);
  $('#modeModalClose').addEventListener('click', closeModeModal);

  // 保存模式
  $('#modeSaveBtn').addEventListener('click', openSaveModal);
  $('#saveModalClose').addEventListener('click', closeSaveModal);
  $('#confirmSaveMode').addEventListener('click', confirmSaveMode);

  // 模式选择变更
  modeSelect.classList.add('placeholder');
  modeSelect.addEventListener('change', () => {
    modeSelect.classList.toggle('placeholder', !modeSelect.value);
    applyMode();
  });

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
    showToast('请输入商品SKU');
    skuInput.focus();
    return;
  }

  const shopId = shopSelect.value;
  const shopOpt = shopOptions.find(o => o.value === shopId);
  const shopName = shopOpt ? shopOpt.label : '';
  const spShopNo = shopOpt ? shopOpt.spShopNo : '';
  const shopDeptId = shopOpt ? shopOpt.deptId : '';
  const shopDeptName = shopOpt ? shopOpt.deptName : '';

  const warehouseId = warehouseSelect.value;

  // 先获取配置，根据勾选项决定验证规则
  const config = getCurrentConfig();

  // 其他步骤（非京配/非采购）是否有勾选
  const hasOtherSteps = config.importShopProduct || config.enableShopProduct ||
    config.enableMasterData || config.disableMasterData || config.inventoryRatio ||
    config.disableShopProduct || config.logistics;

  // 仅勾选了"打标生效"和/或"取消京配"（无其他步骤，无采购入库）
  const onlyJdSteps = (config.jdLabel || config.cancelJdLabel) &&
    !config.enablePurchase && !hasOtherSteps;

  // 仅勾选了"采购入库"（无其他步骤，无京配相关）
  const onlyPurchase = config.enablePurchase &&
    !config.jdLabel && !config.cancelJdLabel && !hasOtherSteps;

  // 店铺验证：仅京配步骤或仅采购入库时可不选店铺
  if (!shopId && !onlyJdSteps && !onlyPurchase) {
    showToast('请选择店铺');
    return;
  }

  // 仓库验证：仅京配步骤时可不选仓库
  if (!warehouseId && !onlyJdSteps) {
    showToast('请选择仓库');
    return;
  }

  // 解析 SKU（支持中英文逗号）
  const skus = skuText.split(/[,，]/).map(s => s.trim()).filter(Boolean);

  // 判断是否仅勾选了京配打标/取消京配打标步骤（用于批大小）
  const batchSize = onlyJdSteps ? 5000 : BATCH_SIZE;

  // 获取当前选择的模式名称
  const modeName = modeSelect.value || '自定义';

  // 按 batchSize 拆分为多个任务，每个任务独立执行所有步骤
  const taskBatches = [];
  for (let i = 0; i < skus.length; i += batchSize) {
    taskBatches.push(skus.slice(i, i + batchSize));
  }

  // 记录本次SKU来源文件名（如有）
  const sourceFileName = importedFileName || '';

  for (const batchSkus of taskBatches) {
    taskIdCounter++;
    tasks.push({
      id: taskIdCounter,
      skus: batchSkus,
      shopId,
      spShopNo,
      shopName,
      shopDeptId,
      shopDeptName,
      warehouseId,
      config,
      modeName,
      sourceFileName,
      status: 'pending'
    });
  }

  renderTaskTable();
  if (taskBatches.length > 1) {
    addLog('info', `已添加 ${taskBatches.length} 个任务（共${skus.length}个SKU，每任务最多${batchSize}个）`);
  } else {
    addLog('info', `已添加 1 个任务（${skus.length} 个SKU）`);
  }

  // 清空SKU输入和文件名
  skuInput.value = '';
  importedFileName = '';
}

// ========== 物流属性持久化 ==========
const LOGI_KEYS = ['logLength', 'logWidth', 'logHeight', 'logWeight', 'stepDelay'];

function loadLogisticsPrefs() {
  const saved = localStorage.getItem('logisticsPrefs');
  if (!saved) return;
  try {
    const prefs = JSON.parse(saved);
    LOGI_KEYS.forEach(k => {
      const el = $('#' + k);
      if (el && prefs[k] != null) el.value = prefs[k];
    });
  } catch (e) { /* ignore */ }
}

function saveLogisticsPrefs() {
  const prefs = {};
  LOGI_KEYS.forEach(k => {
    const el = $('#' + k);
    if (el) prefs[k] = el.value;
  });
  localStorage.setItem('logisticsPrefs', JSON.stringify(prefs));
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
    logWeight: $('#logWeight').value,
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
  $('#logWeight').value = config.logWeight || $('#logWeight').value || '0.5';
  $('#stepDelay').value = config.stepDelay || $('#stepDelay').value || 10;
  saveLogisticsPrefs();
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
      error: { text: '失败', cls: 'status-error' },
      partial: { text: '部分失败', cls: 'status-partial' },
      stopped: { text: '已停止', cls: 'status-error' }
    };
    const st = statusMap[task.status] || statusMap.pending;

    let skuDisplay;
    if (task.sourceFileName) {
      skuDisplay = `${escapeHtml(task.sourceFileName)} 共${task.skus.length}个SKU`;
    } else if (task.skus.length <= 1) {
      skuDisplay = task.skus.map(escapeHtml).join(', ');
    } else {
      skuDisplay = `${escapeHtml(task.skus[0])} 等${task.skus.length}个`;
    }

    // 部分失败时显示失败SKU数量
    let statusHtml = `<span class="${st.cls}">${st.text}</span>`;
    if (task.status === 'partial' && task.failedLabelSkus && task.failedLabelSkus.length > 0) {
      statusHtml += ` <span class="fail-count" title="${task.failedLabelSkus.map(escapeHtml).join(', ')}">(${task.failedLabelSkus.length}个失败)</span>`;
    }

    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td title="${task.skus.map(escapeHtml).join(', ')}">${skuDisplay}</td>
      <td>${escapeHtml(task.shopName)}</td>
      <td>${escapeHtml(task.modeName || '自定义')}</td>
      <td>${statusHtml}</td>
    `;

    // 右键删除任务
    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (isExecuting) {
        showToast('任务执行中，无法删除');
        return;
      }
      if (task.status === 'running') {
        showToast('该任务正在执行，无法删除');
        return;
      }
      showTaskCtxMenu(e.clientX, e.clientY, idx);
    });
    tr.style.cursor = 'context-menu';

    taskTableBody.appendChild(tr);
  });
}

// ========== 右键菜单 & 删除确认 ==========
let ctxTargetIdx = -1;
let deleteAction = null; // 'row' | 'all'

function showTaskCtxMenu(x, y, idx) {
  ctxTargetIdx = idx;
  const menu = $('#taskCtxMenu');
  menu.style.display = 'block';
  // 防止菜单超出窗口边界
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 4;
  const maxY = window.innerHeight - rect.height - 4;
  menu.style.left = Math.min(x, maxX) + 'px';
  menu.style.top = Math.min(y, maxY) + 'px';
}

function hideTaskCtxMenu() {
  $('#taskCtxMenu').style.display = 'none';
}

// 点击页面其他位置关闭右键菜单
document.addEventListener('click', () => hideTaskCtxMenu());
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('#taskTableBody')) {
    hideTaskCtxMenu();
  }
});

// 右键菜单 - 删除选中行
$('#ctxDeleteRow').addEventListener('click', () => {
  hideTaskCtxMenu();
  const idx = ctxTargetIdx;
  if (idx < 0 || idx >= tasks.length) return;
  deleteAction = 'row';
  $('#deleteTaskTitle').textContent = '删除任务';
  $('#deleteTaskMsg').textContent = `确认删除任务 ${idx + 1}？`;
  $('#deleteTaskModal').style.display = 'flex';
});

// 右键菜单 - 清空全部
$('#ctxClearAll').addEventListener('click', () => {
  hideTaskCtxMenu();
  if (tasks.length === 0) {
    showToast('没有任务可清空');
    return;
  }
  deleteAction = 'all';
  $('#deleteTaskTitle').textContent = '清空全部任务';
  $('#deleteTaskMsg').textContent = `确认清空全部 ${tasks.length} 个任务？`;
  $('#deleteTaskModal').style.display = 'flex';
});

// 删除确认弹窗 - 确认
$('#deleteTaskYes').addEventListener('click', () => {
  if (deleteAction === 'row') {
    const idx = ctxTargetIdx;
    tasks.splice(idx, 1);
    renderTaskTable();
    addLog('info', `已删除任务 ${idx + 1}`);
  } else if (deleteAction === 'all') {
    const count = tasks.length;
    tasks.length = 0;
    renderTaskTable();
    addLog('info', `已清空全部 ${count} 个任务`);
  }
  deleteAction = null;
  $('#deleteTaskModal').style.display = 'none';
});

// 删除确认弹窗 - 取消
$('#deleteTaskNo').addEventListener('click', () => {
  deleteAction = null;
  $('#deleteTaskModal').style.display = 'none';
});
$('#deleteTaskCancelBtn').addEventListener('click', () => {
  deleteAction = null;
  $('#deleteTaskModal').style.display = 'none';
});


// ========== 执行任务 ==========
async function executeTasks() {
  const pendingTasks = tasks.filter(t => t.status === 'pending' || t.status === 'stopped');
  if (pendingTasks.length === 0) {
    showToast('没有待执行的任务');
    return;
  }
  // 将 stopped 状态的任务重置为 pending
  pendingTasks.forEach(t => { if (t.status === 'stopped') t.status = 'pending'; });
  if (isExecuting) {
    showToast('任务正在执行中，请等待完成');
    return;
  }

  isExecuting = true;
  stopRequested = false;
  const execBtn = $('#execTaskBtn');
  execBtn.textContent = '停止任务';
  execBtn.classList.add('btn-stop');
  addLog('info', `开始执行 ${pendingTasks.length} 个任务...`);

  for (const task of pendingTasks) {
    if (stopRequested) break;

    task.status = 'running';
    renderTaskTable();
    const skuLabel = task.skus.length <= 3 ? task.skus.join(',') : `${task.skus.slice(0, 3).join(',')}等${task.skus.length}个`;
    addLog('info', `[${skuLabel}] 开始执行...`);

    try {
      // 按照配置顺序执行各步骤
      const steps = getTaskSteps(task);
      let stopped = false;
      for (const step of steps) {
        if (stopRequested) { stopped = true; break; }
        addLog('info', `[${skuLabel}] ${step.name}...`);

        await executeStep(step, task);

        addLog('success', `[${skuLabel}] ${step.name} 完成`);

        // 步骤延时（可被停止中断）
        if (task.config.stepDelay > 0 && !stopRequested) {
          const delayMs = task.config.stepDelay * 1000;
          let elapsed = 0;
          while (elapsed < delayMs && !stopRequested) {
            await sleep(Math.min(200, delayMs - elapsed));
            elapsed += 200;
          }
        }
      }

      if (stopped) {
        task.status = 'stopped';
        addLog('warn', `[${skuLabel}] 已停止`);
      } else if (task.hasLabelFailure) {
        task.status = 'partial';
        addLog('warn', `[${skuLabel}] 完成（部分SKU打标失败）`);
      } else {
        task.status = 'success';
        addLog('success', `[${skuLabel}] 全部完成`);
      }
    } catch (err) {
      task.status = 'error';
      addLog('error', `[${skuLabel}] 失败: ${err.message}`);
    }

    renderTaskTable();
  }

  isExecuting = false;
  stopRequested = false;
  execBtn.textContent = '执行任务';
  execBtn.classList.remove('btn-stop');

  if (tasks.some(t => t.status === 'stopped')) {
    addLog('warn', '任务已停止，未完成的任务可再次执行');
  } else {
    addLog('info', '所有任务执行完毕');
  }
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
  for (let attempt = 0; attempt < maxRetries; attempt++) {
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
      if (attempt < maxRetries) {
        addLog('warn', `[${sku}] ${label}: ${resMsg}，1分钟后重试 (${attempt + 1}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, 60000));
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
          } else if (!isRateLimit) {
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

      // 先查询店铺商品数据获取 goodsId
      addLog('info', `[${skuLabel}] 正在查询商品主数据...`);
      const mdCsgRes = await window.electronAPI.queryShopGoods({ skus: task.skus });
      if (!mdCsgRes.success) throw new Error(`商品查询失败: ${mdCsgRes.error}`);

      if (mdCsgRes.failed && mdCsgRes.failed.length > 0) {
        addLog('warn', `[${skuLabel}] 以下SKU未查询到: ${mdCsgRes.failed.join(', ')}`);
      }

      const mdCsgMap = mdCsgRes.results || {};
      const goodsIds = [];
      for (const sku of task.skus) {
        const item = mdCsgMap[sku]?.raw;
        if (item) {
          const gid = item.goodsId || item.id;
          if (gid) {
            // 不根据 item.status 预判（那是店铺商品状态，非主数据状态）
            // 直接提交，由服务端判断是否需要操作
            goodsIds.push(String(gid));
          }
        }
      }

      if (goodsIds.length === 0) {
        addLog('warn', `[${skuLabel}] 未找到可操作的商品主数据`);
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
          } else if (!isRateLimit) {
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
          } else if (!isRateLimit) {
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
            height: cfg.logHeight,
            weight: cfg.logWeight
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
      // 按事业部匹配供应商和事业部编号
      const matchedSupplier = task.shopDeptName
        ? suppliers.find(s => s.deptName === task.shopDeptName)
        : suppliers[0];
      const supplierId = matchedSupplier?.supplierId || suppliers[0]?.supplierId || '';
      const departmentId = task.shopDeptId ? ('CBU' + task.shopDeptId) : (userData?.departmentId || '');
      const batches = splitBatches(task.skus, BATCH_SIZE);
      if (batches.length > 1) addLog('info', `[${skuLabel}] 共${task.skus.length}个SKU，分${batches.length}批上传（每批最多${BATCH_SIZE}）`);
      for (let i = 0; i < batches.length; i++) {
        const batchLabel = batches.length > 1 ? `批次${i + 1}/${batches.length}` : '';
        const result = await window.electronAPI.generateExcel({
          type: 'purchaseImport',
          data: {
            skus: batches[i],
            departmentId,
            supplierId,
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
      const label = enable ? '生效' : '取消';

      // 查询所有SKU对应的店铺商品信息
      addLog('info', `[${skuLabel}] 正在查询店铺商品信息...`);
      const csgResult = await window.electronAPI.queryShopGoods({ skus: task.skus });
      if (!csgResult.success) {
        throw new Error(`店铺商品查询失败: ${csgResult.error}`);
      }
      if (csgResult.failed && csgResult.failed.length > 0) {
        addLog('warn', `[${skuLabel}] 以下SKU未查询到: ${csgResult.failed.join(', ')}`);
      }
      const csgMap = csgResult.results || {};

      // 过滤出有完整信息的SKU（需要 id、shopId、deptId），同时保留SKU编号用于失败追踪
      const goodArray = [];
      const missingFields = [];
      for (const sku of task.skus) {
        const info = csgMap[sku];
        if (!info || !info.raw) continue;
        const raw = info.raw;
        if (raw.id && raw.shopId && raw.deptId) {
          goodArray.push({ sku, id: raw.id, shopId: raw.shopId, deptId: raw.deptId });
        } else if (raw.id && raw.shopId) {
          // deptId 缺失时尝试用 deptNo 等替代字段
          goodArray.push({ sku, id: raw.id, shopId: raw.shopId, deptId: raw.deptId || raw.deptNo || '' });
        } else {
          missingFields.push(sku);
        }
      }

      if (goodArray.length === 0) {
        throw new Error('所有SKU均未查询到有效信息，无法继续');
      }
      if (missingFields.length > 0) {
        addLog('warn', `[${skuLabel}] ${missingFields.length}个SKU缺少必要字段，已跳过`);
      }
      addLog('info', `[${skuLabel}] 共 ${goodArray.length} 个商品准备京配${label}`);

      // 分批调用接口（每批最多50个，避免京东服务端线程池耗尽）
      const JD_BATCH = 50;
      const batches = splitBatches(goodArray, JD_BATCH);
      if (batches.length > 1) {
        addLog('info', `[${skuLabel}] 分${batches.length}批处理`);
      }

      const JD_MAX_RETRIES = 3;
      const JD_BATCH_DELAY = 5000; // 批次间隔5秒
      let jdSuccessCount = 0;
      let jdFailCount = 0;
      const failedSkus = []; // 追踪具体失败的SKU

      for (let i = 0; i < batches.length; i++) {
        const batchLabel = batches.length > 1 ? `批次${i + 1}/${batches.length} ` : '';
        let retryOk = false;

        for (let attempt = 0; attempt <= JD_MAX_RETRIES; attempt++) {
          if (attempt > 0) {
            const waitSec = attempt * 15; // 15s, 30s, 45s 递增退避
            addLog('warn', `[${skuLabel}] ${batchLabel}重试第${attempt}次，等待${waitSec}秒...`);
            await sleep(waitSec * 1000);
          }

          addLog('info', `[${skuLabel}] ${batchLabel}正在调用京配${label}接口 (${batches[i].length}个)...`);
          const result = await window.electronAPI.jdLabelGoods({
            goodArray: batches[i],
            enable
          });

          if (result.success && result.data && result.data.resultCode === 1) {
            addLog('success', `[${skuLabel}] ${batchLabel}京配${label}成功`);
            jdSuccessCount += batches[i].length;
            retryOk = true;
            break;
          }

          const errMsg = result.error || (result.data && result.data.resultMessage) || '未知错误';
          const isRateLimit = errMsg.includes('频繁') || errMsg.includes('重试');
          const isPermissionErr = errMsg.includes('无权限') || errMsg.includes('无权');
          // 频控错误或权限错误均重试（权限错误可能因csrfToken未初始化导致）
          const shouldRetry = (isRateLimit || isPermissionErr) && attempt < JD_MAX_RETRIES;
          if (shouldRetry) {
            continue; // 进入下次重试
          }

          // 非可重试错误或重试耗尽，记录失败但不终止
          addLog('error', `[${skuLabel}] ${batchLabel}京配${label}失败: ${errMsg}`);
          jdFailCount += batches[i].length;
          // 记录本批次失败的SKU
          for (const item of batches[i]) {
            failedSkus.push(item.sku);
          }
          retryOk = true; // 标记已处理，不再重试
          break;
        }

        if (!retryOk) {
          addLog('error', `[${skuLabel}] ${batchLabel}重试${JD_MAX_RETRIES}次仍失败，跳过`);
          jdFailCount += batches[i].length;
          for (const item of batches[i]) {
            failedSkus.push(item.sku);
          }
        }

        // 批次间等待
        if (i < batches.length - 1) {
          await sleep(JD_BATCH_DELAY);
        }
      }

      addLog(jdFailCount === 0 ? 'success' : 'warn',
        `[${skuLabel}] 京配${label}完成: 成功${jdSuccessCount}个，失败${jdFailCount}个`);

      // 将失败SKU保存到任务对象上，供UI展示；同时保存到输出目录文件供用户重新操作
      if (failedSkus.length > 0) {
        task.failedLabelSkus = failedSkus;
        task.hasLabelFailure = true;
        addLog('warn', `[${skuLabel}] 失败的SKU: ${failedSkus.join(', ')}`);
        // 保存到输出目录（兼容旧版本主进程：如果API不存在则跳过文件保存）
        if (window.electronAPI.saveFailedLabelSkus) {
          const saveResult = await window.electronAPI.saveFailedLabelSkus({
            skus: failedSkus,
            label,
            shopName: task.shopName || ''
          });
          if (saveResult.success) {
            addLog('warn', `[${skuLabel}] 失败SKU已保存到输出目录: ${saveResult.fileName}，可重新导入操作`);
          }
        } else {
          addLog('warn', `[${skuLabel}] 请手动复制失败SKU，点击"打开输出目录"保存后重新导入`);
        }
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
  modeSelect.innerHTML = '<option value="">请选择（可下拉选择）</option>';
  modeSelect.classList.toggle('placeholder', !modeSelect.value);
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
    showToast('请输入模式名称');
    return;
  }

  const config = getCurrentConfig();
  await window.electronAPI.saveMode({ name, config });
  await loadModes();
  closeSaveModal();
  addLog('success', `模式"${name}"已保存`);
}

// ========== 日志 ==========
const LOG_MAX_LINES = 50000;

function addLog(type, message) {
  const now = new Date();
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const div = document.createElement('div');
  div.className = `log-${type}`;
  div.textContent = `[${time}] ${message}`;
  logBox.appendChild(div);
  // 超过上限时移除旧日志
  while (logBox.childNodes.length > LOG_MAX_LINES) {
    logBox.removeChild(logBox.firstChild);
  }
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
  return div.innerHTML.replace(/"/g, '&quot;');
}

// ========== 可搜索店铺下拉框 ==========

function filterShopsByDept() {
  const selectedOpt = deptSelect.options[deptSelect.selectedIndex];
  const selectedDeptNo = selectedOpt ? selectedOpt.value : '';  // deptNo，如 "CBU13214139560198"
  // 直接用 shop.deptNo 匹配（已在 main.js 中通过 deptId→dept.id 关联补全）
  if (selectedDeptNo) {
    shopOptions = allShopOptions.filter(o => o.deptNo && o.deptNo === selectedDeptNo);
  } else {
    shopOptions = [...allShopOptions];
  }
  console.log(`[店铺筛选] deptNo="${selectedDeptNo}" 匹配 ${shopOptions.length}/${allShopOptions.length} 个店铺`);
  if (shopOptions.length === 0 && allShopOptions.length > 0) {
    console.warn(`[店铺筛选] 未匹配! 店铺deptNo列表:`, [...new Set(allShopOptions.map(s => s.deptNo || '(空)'))]);
  }
  shopSelect.value = '';
  shopSearchInput.value = '';
  renderShopDropdown('');
}

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

// 事业部切换事件绑定（检查订阅状态，未订阅则阻止切换）
deptSelect.addEventListener('change', async () => {
  const newDeptNo = deptSelect.value;
  if (!newDeptNo) {
    previousDeptValue = '';
    filterShopsByDept();
    return;
  }
  try {
    const result = await window.electronAPI.checkDepartmentSubscription(newDeptNo);
    if (result && result.valid) {
      previousDeptValue = newDeptNo;
      filterShopsByDept();
    } else {
      const statusText = result && result.status === 'expired' ? '已过期' : '未订阅';
      showToast(`该事业部${statusText}，无法切换，请先订阅`, 4000, 'warn');
      // 回退到之前的值；如无前值则选回第一个选项
      if (previousDeptValue) {
        deptSelect.value = previousDeptValue;
      } else {
        deptSelect.selectedIndex = 0;
      }
    }
  } catch (err) {
    console.error('检查事业部订阅状态失败:', err);
    // 网络异常时允许切换，避免阻塞用户
    previousDeptValue = newDeptNo;
    filterShopsByDept();
  }
});

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
const WMS_AUTO_INTERVAL = 1 * 60 * 1000; // 1分钟

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
const wmsAccountArrow = $('#wmsAccountArrow');
const wmsAccountDropdown = $('#wmsAccountDropdown');
let wmsAccountsList = [];

// WMS 账号下拉相关函数
function renderWmsAccountDropdown() {
  if (!wmsAccountDropdown) return;
  wmsAccountDropdown.innerHTML = '';
  wmsAccountsList.forEach(item => {
    const opt = document.createElement('div');
    opt.className = 'wms-account-option';
    const masked = item.password ? '****' : '';
    opt.innerHTML = '<span class="wms-acct-name">' + escapeHtml(item.username) + '</span><span class="wms-acct-mask">' + masked + '</span>';
    opt.addEventListener('click', () => {
      if (wmsUsernameInput) wmsUsernameInput.value = item.username;
      if (wmsPasswordInput) wmsPasswordInput.value = item.password || '';
      closeWmsAccountDropdown();
    });
    wmsAccountDropdown.appendChild(opt);
  });
}

function toggleWmsAccountDropdown() {
  if (!wmsAccountDropdown) return;
  if (wmsAccountDropdown.classList.contains('open')) {
    closeWmsAccountDropdown();
  } else {
    renderWmsAccountDropdown();
    wmsAccountDropdown.classList.add('open');
  }
}

function closeWmsAccountDropdown() {
  if (wmsAccountDropdown) wmsAccountDropdown.classList.remove('open');
}

// WMS 初始化
function initWmsEventListeners() {
  if (!wmsLoginBtn) return;

  // 加载已保存的 WMS 凭据
  if (window.electronAPI.getWmsCredentials) {
    window.electronAPI.getWmsCredentials().then(cred => {
      if (cred) {
        if (wmsUsernameInput) wmsUsernameInput.value = cred.username || '';
        if (wmsPasswordInput) wmsPasswordInput.value = cred.password || '';
      }
    });
  }

  // 加载 WMS 历史账号列表，多于1个时显示下拉箭头
  if (window.electronAPI.getWmsAccounts) {
    window.electronAPI.getWmsAccounts().then(list => {
      wmsAccountsList = list || [];
      if (wmsAccountsList.length > 1 && wmsAccountArrow) {
        wmsAccountArrow.classList.add('visible');
      }
    });
  }

  // 箭头点击事件
  if (wmsAccountArrow) {
    wmsAccountArrow.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWmsAccountDropdown();
    });
  }

  // 点击外部关闭下拉框
  document.addEventListener('click', (e) => {
    if (wmsAccountDropdown && !wmsAccountDropdown.contains(e.target) &&
        e.target !== wmsAccountArrow && !(wmsAccountArrow && wmsAccountArrow.contains(e.target))) {
      closeWmsAccountDropdown();
    }
  });

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
  wmsLoginBtn.addEventListener('click', async () => {
    const username = wmsUsernameInput ? wmsUsernameInput.value.trim() : '';
    const password = wmsPasswordInput ? wmsPasswordInput.value : '';
    if (!username || !password) {
      addWmsLog('warn', '请输入 WMS 账号和密码');
      return;
    }
    // 保存凭据
    if (window.electronAPI.saveWmsCredentials) {
      await window.electronAPI.saveWmsCredentials({ username, password });
      // 刷新下拉账号列表
      if (window.electronAPI.getWmsAccounts) {
        wmsAccountsList = await window.electronAPI.getWmsAccounts() || [];
        if (wmsAccountsList.length > 1 && wmsAccountArrow) {
          wmsAccountArrow.classList.add('visible');
        }
      }
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
    const ORDER_CONCURRENCY = 5; // 最多同时验收5个不同订单
    addWmsLog('info', `开始一键验收，共 ${selectedOrders.length} 个单据...`);

    for (let g = 0; g < selectedOrders.length; g += ORDER_CONCURRENCY) {
      const group = selectedOrders.slice(g, g + ORDER_CONCURRENCY);
      const results = await Promise.allSettled(group.map(async (order, idx) => {
        const orderIdx = g + idx + 1;
        addWmsLog('info', `[${orderIdx}/${selectedOrders.length}] 正在验收: ${order.inboundNo}...`);
        try {
          const result = await window.electronAPI.wmsAcceptOrder({
            inboundNo: order.inboundNo,
            warehouseNo: order.warehouseNo,
            locationNo
          });
          return { orderIdx, inboundNo: order.inboundNo, result };
        } catch (err) {
          return { orderIdx, inboundNo: order.inboundNo, result: { success: false, error: err.message } };
        }
      }));

      for (const r of results) {
        if (r.status === 'fulfilled') {
          const { orderIdx, inboundNo, result } = r.value;
          if (result.success) {
            if (result.skipped) {
              addWmsLog('info', `[${orderIdx}/${selectedOrders.length}] ${inboundNo} 当前无可验收明细，跳过`);
            } else {
              successCount++;
              wmsTotalAcceptedOrders++;
              wmsTotalAcceptedSkus += (result.count || 0);
              updateWmsStats();
              const warnMsg = result.warning ? ` (${result.failCount}个SKU失败: ${result.warning})` : '';
              addWmsLog('success', `[${orderIdx}/${selectedOrders.length}] ${inboundNo} 验收成功，${result.count} 个SKU${warnMsg}`);
            }
          } else {
            failCount++;
            addWmsLog('error', `[${orderIdx}/${selectedOrders.length}] ${inboundNo} 验收失败: ${result.error}`);
          }
        } else {
          failCount++;
          addWmsLog('error', `订单验收异常: ${r.reason?.message || '未知'}`);
        }
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
      $('#autoAccept').checked = false;
      addWmsLog('info', '自动验收已关闭');
    } else {
      // 开启自动验收
      wmsAutoMode = true;
      wmsAutoBtn.textContent = '关闭自动验收';
      wmsAutoBtn.classList.add('wms-btn-auto-active');
      $('#autoAccept').checked = true;
      addWmsLog('success', '自动验收已开启，每 1 分钟扫描一次待验收单据');
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
      // 登录成功后自动查询一次入库单
      setTimeout(() => handleWmsQuery(), 1000);
    });
  }

  // ===== 商家端"开启自动验收"复选框 与 仓库端自动验收按钮 联动 =====
  const autoAcceptCheckbox = $('#autoAccept');

  autoAcceptCheckbox.addEventListener('change', () => {
    if (autoAcceptCheckbox.checked) {
      if (!wmsLoggedIn) {
        autoAcceptCheckbox.checked = false;
        $('#wmsConfirmModal').style.display = 'flex';
        return;
      }
      if (!wmsAutoMode) {
        wmsAutoBtn.click();
        // 如果验证失败（如储位号未填），wmsAutoMode不会变，恢复checkbox
        if (!wmsAutoMode) {
          autoAcceptCheckbox.checked = false;
        }
      }
    } else {
      if (wmsAutoMode) {
        wmsAutoBtn.click();
      }
    }
  });

  $('#wmsConfirmModalClose').addEventListener('click', () => {
    $('#wmsConfirmModal').style.display = 'none';
  });
  $('#wmsConfirmNo').addEventListener('click', () => {
    $('#wmsConfirmModal').style.display = 'none';
  });
  $('#wmsConfirmYes').addEventListener('click', () => {
    $('#wmsConfirmModal').style.display = 'none';
    document.querySelector('[data-page="acceptance"]').click();
    setTimeout(() => wmsLoginBtn.click(), 300);
  });
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
  } else if (statusStr.includes('收货中')) {
    return `<span class="wms-badge wms-badge-receiving">收货中</span>`;
  } else if (statusStr.includes('部分完成') || statusStr.includes('部分收货')) {
    return `<span class="wms-badge wms-badge-partial">部分完成</span>`;
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
  while (wmsLogBox.childNodes.length > LOG_MAX_LINES) {
    wmsLogBox.removeChild(wmsLogBox.firstChild);
  }
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
    const ORDER_CONCURRENCY = 5; // 最多同时验收5个不同订单

    // 将订单按并发数分组，每组最多 ORDER_CONCURRENCY 个订单同时验收
    for (let g = 0; g < wmsOrders.length; g += ORDER_CONCURRENCY) {
      if (!wmsAutoMode) {
        addWmsLog('warn', '[自动验收] 已手动关闭，中止验收');
        break;
      }
      const group = wmsOrders.slice(g, g + ORDER_CONCURRENCY);
      const results = await Promise.allSettled(group.map(async (order, idx) => {
        const orderIdx = g + idx + 1;
        addWmsLog('info', `[自动验收] [${orderIdx}/${wmsOrders.length}] 正在验收: ${order.inboundNo}...`);
        try {
          const result = await window.electronAPI.wmsAcceptOrder({
            inboundNo: order.inboundNo,
            warehouseNo: order.warehouseNo,
            locationNo
          });
          return { orderIdx, inboundNo: order.inboundNo, result };
        } catch (err) {
          return { orderIdx, inboundNo: order.inboundNo, result: { success: false, error: err.message } };
        }
      }));

      // 处理本轮并发结果
      for (const r of results) {
        if (r.status === 'fulfilled') {
          const { orderIdx, inboundNo, result } = r.value;
          if (result.success) {
            successCount++;
            wmsTotalAcceptedOrders++;
            wmsTotalAcceptedSkus += (result.count || 0);
            updateWmsStats();
            const warnMsg = result.warning ? ` (${result.failCount}个SKU失败: ${result.warning})` : '';
            addWmsLog('success', `[自动验收] [${orderIdx}/${wmsOrders.length}] ${inboundNo} 验收成功，${result.count} 个SKU${warnMsg}`);
          } else {
            failCount++;
            addWmsLog('error', `[自动验收] [${orderIdx}/${wmsOrders.length}] ${inboundNo} 验收失败: ${result.error}`);
          }
        } else {
          failCount++;
          addWmsLog('error', `[自动验收] 订单验收异常: ${r.reason?.message || '未知'}`);
        }
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

// ========== 订阅状态显示 ==========

async function loadSubscriptionInfo() {
  try {
    const info = await window.electronAPI.getSubscriptionInfo();
    if (!info) return;
    currentTier = info.tier || 'basic';
    updateSubscriptionBadge(info);

    // 剩余不足7天时友情提醒
    if (info.days_remaining != null && info.days_remaining < 7 && (info.status === 'active' || info.status === 'trial')) {
      setTimeout(() => {
        showToast(`温馨提示：您的使用时长剩余 ${info.days_remaining} 天，请及时续费以免影响正常使用。`, 5000, 'warn');
      }, 1500);
    }
  } catch (e) {
    console.log('获取订阅信息失败:', e.message);
  }
}

function updateSubscriptionBadge(info) {
  const badge = document.getElementById('subBadge');
  const days = document.getElementById('subDays');
  const invite = document.getElementById('subInvite');
  if (!badge) return;

  const tierLabel = getTierLabel(info.tier);

  if (info.status === 'trial') {
    badge.textContent = '试用中';
    badge.className = 'sub-info-badge trial';
    if (info.days_remaining != null) {
      days.textContent = `剩余 ${info.days_remaining} 天`;
      days.classList.toggle('warn', info.days_remaining < 7);
    }
  } else if (info.status === 'active') {
    badge.textContent = tierLabel ? `${tierLabel} 已订阅` : '已订阅';
    badge.className = 'sub-info-badge active';
    if (info.days_remaining != null) {
      days.textContent = `剩余 ${info.days_remaining} 天`;
      days.classList.toggle('warn', info.days_remaining < 7);
    }
  } else {
    badge.textContent = tierLabel ? `${tierLabel} 已到期` : '未订阅';
    badge.className = 'sub-info-badge expired';
    days.textContent = '';
  }

  if (info.invite_code) {
    invite.textContent = `邀请码: ${info.invite_code}`;
    invite.title = '分享此邀请码给好友，好友首次订阅可获得同等时长奖励';
  }
}

function getTierLabel(tier) {
  const labels = { basic: '基础版', standard: '标准版', premium: '高级版' };
  return labels[tier] || tier;
}

function canUseFeature(feature) {
  if (!currentTier || currentTier === 'standard' || currentTier === 'premium') return true;
  const allowedFeatures = ['shopLabel', 'acceptance', 'shopManage'];
  return allowedFeatures.includes(feature);
}

function requireTier(feature) {
  if (feature === 'shopManage' && !smFeatureEnabled) {
    showToast('该功能开发中，暂不可用', 3000, 'error');
    return false;
  }
  if (canUseFeature(feature)) return true;
  showToast('当前为基础版，该功能需升级至标准版或高级版后使用', 4000, 'error');
  return false;
}

// ========== 订阅事件监听 ==========

function initSubscriptionListeners() {
  // 被踢下线
  if (window.electronAPI.onSessionKicked) {
    window.electronAPI.onSessionKicked(() => {
      const modal = document.getElementById('kickedModal');
      if (modal) modal.style.display = 'flex';
    });
  }

  // 订阅过期
  if (window.electronAPI.onSubscriptionExpired) {
    window.electronAPI.onSubscriptionExpired(() => {
      const modal = document.getElementById('expiredModal');
      if (modal) modal.style.display = 'flex';
    });
  }

  // 被踢下线确认按钮 -> 退出应用
  const kickedBtn = document.getElementById('kickedOkBtn');
  if (kickedBtn) {
    kickedBtn.addEventListener('click', () => {
      window.electronAPI.close();
    });
  }

  // 订阅过期确认按钮 -> 退出应用
  const expiredBtn = document.getElementById('expiredOkBtn');
  if (expiredBtn) {
    expiredBtn.addEventListener('click', () => {
      window.electronAPI.close();
    });
  }

  // 订阅过期 -> 去续费按钮
  const expiredRenewBtn = document.getElementById('expiredRenewBtn');
  if (expiredRenewBtn) {
    expiredRenewBtn.addEventListener('click', () => {
      const modal = document.getElementById('expiredModal');
      if (modal) modal.style.display = 'none';
      window.electronAPI.openSubscription();
    });
  }

  // 侧边栏续费按钮
  const subRenewBtn = document.getElementById('subRenew');
  if (subRenewBtn) {
    subRenewBtn.addEventListener('click', () => {
      window.electronAPI.openSubscription();
    });
  }
}

  // ========== 退出确认弹窗 ==========
  if (window.electronAPI.onShowCloseConfirm) {
    window.electronAPI.onShowCloseConfirm(() => {
      const modal = document.getElementById('closeConfirmModal');
      if (modal) modal.style.display = 'flex';
    });
  }
  const closeConfirmYes = document.getElementById('closeConfirmYes');
  if (closeConfirmYes) {
    closeConfirmYes.addEventListener('click', () => {
      const modal = document.getElementById('closeConfirmModal');
      if (modal) modal.style.display = 'none';
      window.electronAPI.confirmClose();
    });
  }
  const closeConfirmNo = document.getElementById('closeConfirmNo');
  if (closeConfirmNo) {
    closeConfirmNo.addEventListener('click', () => {
      const modal = document.getElementById('closeConfirmModal');
      if (modal) modal.style.display = 'none';
    });
  }
  const closeConfirmCancelBtn = document.getElementById('closeConfirmCancelBtn');
  if (closeConfirmCancelBtn) {
    closeConfirmCancelBtn.addEventListener('click', () => {
      const modal = document.getElementById('closeConfirmModal');
      if (modal) modal.style.display = 'none';
    });
  }

  // ========== 更新下载进度弹窗 ==========
  if (window.electronAPI.onShowUpdateDownloading) {
    window.electronAPI.onShowUpdateDownloading((data) => {
      const text = document.getElementById('updateDownloadText');
      if (text) text.textContent = `正在下载 v${data.version}...`;
      const modal = document.getElementById('updateDownloadModal');
      if (modal) modal.style.display = 'flex';
    });
  }
  if (window.electronAPI.onUpdateDownloadProgress) {
    window.electronAPI.onUpdateDownloadProgress((data) => {
      const bar = document.getElementById('updateDownloadBar');
      const pct = document.getElementById('updateDownloadPct');
      if (bar) bar.style.width = data.percent + '%';
      if (pct) pct.textContent = data.percent + '%';
    });
  }

  // ========== 更新安装确认弹窗 ==========
  if (window.electronAPI.onShowUpdateInstall) {
    window.electronAPI.onShowUpdateInstall((data) => {
      // 隐藏下载进度弹窗
      const dlModal = document.getElementById('updateDownloadModal');
      if (dlModal) dlModal.style.display = 'none';
      // 显示安装确认弹窗
      const text = document.getElementById('updateInstallText');
      if (text && data.version) text.textContent = `新版本 v${data.version} 已下载完成`;
      const modal = document.getElementById('updateInstallModal');
      if (modal) modal.style.display = 'flex';
    });
  }
  const updateInstallYes = document.getElementById('updateInstallYes');
  if (updateInstallYes) {
    updateInstallYes.addEventListener('click', () => {
      const modal = document.getElementById('updateInstallModal');
      if (modal) modal.style.display = 'none';
      window.electronAPI.confirmUpdateInstallByPath();
    });
  }
  const updateInstallNo = document.getElementById('updateInstallNo');
  if (updateInstallNo) {
    updateInstallNo.addEventListener('click', () => {
      const modal = document.getElementById('updateInstallModal');
      if (modal) modal.style.display = 'none';
    });
  }

  // ========== 更新下载失败弹窗 ==========
  if (window.electronAPI.onShowUpdateDownloadFailed) {
    window.electronAPI.onShowUpdateDownloadFailed((data) => {
      const dlModal = document.getElementById('updateDownloadModal');
      if (dlModal) dlModal.style.display = 'none';
      const modal = document.getElementById('updateFailedModal');
      if (modal) modal.style.display = 'flex';
      // 存储下载URL供按钮使用
      window._updateFailedUrl = data.url;
    });
  }
  const updateFailedYes = document.getElementById('updateFailedYes');
  if (updateFailedYes) {
    updateFailedYes.addEventListener('click', () => {
      const modal = document.getElementById('updateFailedModal');
      if (modal) modal.style.display = 'none';
      if (window._updateFailedUrl) {
        window.electronAPI.openExternalDownload(window._updateFailedUrl);
      }
    });
  }
  const updateFailedNo = document.getElementById('updateFailedNo');
  if (updateFailedNo) {
    updateFailedNo.addEventListener('click', () => {
      const modal = document.getElementById('updateFailedModal');
      if (modal) modal.style.display = 'none';
    });
  }
  const updateFailedClose = document.getElementById('updateFailedClose');
  if (updateFailedClose) {
    updateFailedClose.addEventListener('click', () => {
      const modal = document.getElementById('updateFailedModal');
      if (modal) modal.style.display = 'none';
    });
  }

// ========== 店铺管理模块 ==========

let smGoods = [];          // 当前查询到的商品列表
let smFilteredGoods = [];  // 筛选后的商品列表
let smLoggedIn = false;    // 店铺登录状态

// DOM 引用
const smShopSelect = $('#smShopSelect');
const smLogBox = $('#smLogBox');
const smGoodsTableBody = $('#smGoodsTableBody');
const smGoodsCount = $('#smGoodsCount');
const smStatusDot = $('#smStatusTag');

// 检查店铺管理功能开关，未开启则禁用所有操作
let smFeatureEnabled = true;

async function checkSmFeatureFlag() {
  smFeatureEnabled = true; // 永久解锁店铺管理功能
}

// 初始化店铺管理模块
async function initSmModule() {
  // 检查功能开关
  await checkSmFeatureFlag();

  // 上架日期默认不限（留空）
  const dateFrom = $('#smDateFrom');
  const dateTo = $('#smDateTo');
  if (dateFrom) dateFrom.value = '';
  if (dateTo) dateTo.value = '';
  // 售价范围默认不限（留空）
  const priceMin = $('#smPriceMin');
  const priceMax = $('#smPriceMax');
  if (priceMin) priceMin.value = '';
  if (priceMax) priceMax.value = '';

  await loadShopAccounts();
  await loadSmStats();
  initSmEventListeners();
  checkSmLoginStatus();

  // 恢复上次的商品状态和商品数量选择
  const savedStatus = localStorage.getItem('sm_goodsStatus');
  if (savedStatus) {
    const radio = document.querySelector(`input[name="smGoodsStatus"][value="${savedStatus}"]`);
    if (radio) radio.checked = true;
  }
  const savedQty = localStorage.getItem('sm_goodsQty');
  if (savedQty) {
    const radio = document.querySelector(`input[name="smGoodsQty"][value="${savedQty}"]`);
    if (radio) radio.checked = true;
  }
  const savedQtyN = localStorage.getItem('sm_goodsQtyN');
  if (savedQtyN) {
    const qtyN = $('#smQtyN');
    if (qtyN) qtyN.value = savedQtyN;
  }
}

// ========== 店铺账号管理 ==========

async function loadShopAccounts() {
  if (!window.electronAPI.getShopAccounts) return;
  const accounts = await window.electronAPI.getShopAccounts();
  smShopSelect.innerHTML = '<option value="">请先添加店铺</option>';
  if (accounts && accounts.length > 0) {
    smShopSelect.innerHTML = '<option value="">请选择店铺</option>';
    accounts.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.name || a.username;
      smShopSelect.appendChild(opt);
    });
  }
}

function initSmEventListeners() {
  // 管理按钮
  const manageBtn = $('#smManageBtn');
  if (manageBtn) manageBtn.addEventListener('click', openSmShopModal);

  // 店铺下拉切换时同步状态
  if (smShopSelect) {
    smShopSelect.addEventListener('change', async () => {
      const selectedId = smShopSelect.value;
      if (!selectedId) {
        updateSmLoginStatus(false, '');
        return;
      }
      // 先用 cookie 有效性快速判断状态
      const statusResult = await window.electronAPI.checkShopAccountsStatus();
      const isOnline = statusResult && statusResult.statusMap && statusResult.statusMap[selectedId];
      const accounts = await window.electronAPI.getShopAccounts();
      const account = accounts.find(a => a.id === selectedId);
      if (isOnline) {
        updateSmLoginStatus(true, account?.name || account?.username || '');
      } else {
        updateSmLoginStatus(false, '');
      }
      // 切换活跃账号
      if (account) {
        await window.electronAPI.switchShopAccount(account);
      }
    });
  }

  // 登录按钮
  const loginBtn = $('#smLoginBtn');
  if (loginBtn) loginBtn.addEventListener('click', handleSmLogin);

  // 查询按钮
  const queryBtn = $('#smQueryBtn');
  if (queryBtn) queryBtn.addEventListener('click', handleSmQuery);

  // 导出按钮
  const exportBtn = $('#smExportBtn');
  if (exportBtn) exportBtn.addEventListener('click', handleSmExport);

  // 发送按钮
  const sendBtn = $('#smSendBtn');
  if (sendBtn) sendBtn.addEventListener('click', () => handleSmSend('打标'));

  // 发送到下标按钮
  const sendDownBtn = $('#smSendDownBtn');
  if (sendDownBtn) sendDownBtn.addEventListener('click', () => handleSmSend('下标'));

  // 打开店铺后台按钮
  const openShopBtn = $('#smOpenShopBtn');
  if (openShopBtn) openShopBtn.addEventListener('click', async () => {
    if (!requireTier('shopManage')) return;
    openShopBtn.disabled = true;
    openShopBtn.textContent = '打开中...';
    const res = await window.electronAPI.openShopPage();
    openShopBtn.disabled = false;
    openShopBtn.textContent = '🌐 打开店铺后台';
    if (!res.success) showToast(res.error || '打开失败');
  });

  // 店铺抓包按钮
  let smCapturing = false;
  const smCaptureBtn = $('#smCaptureBtn');
  const smCaptureStatus = $('#smCaptureStatus');
  if (smCaptureBtn) {
    smCaptureBtn.addEventListener('click', async () => {
      if (!smCapturing) {
        const res = await window.electronAPI.startShopCapture();
        if (res.success) {
          smCapturing = true;
          smCaptureBtn.textContent = '\u23F9 停止抓包';
          smCaptureBtn.style.background = '#e74c3c';
          smCaptureBtn.style.color = '#fff';
          smCaptureBtn.style.borderColor = '#e74c3c';
          smCaptureStatus.style.display = 'inline';
          smCaptureStatus.textContent = '抓包中... 在店铺后台操作后点击停止';
          smCaptureStatus.style.color = '#e74c3c';
        } else {
          showToast(res.error || '启动抓包失败');
        }
      } else {
        smCaptureBtn.textContent = '停止中...';
        smCaptureBtn.disabled = true;
        const res = await window.electronAPI.stopShopCapture();
        smCapturing = false;
        smCaptureBtn.disabled = false;
        smCaptureBtn.textContent = '\uD83D\uDD0D 开始抓包';
        smCaptureBtn.style.background = '#f0f0f0';
        smCaptureBtn.style.color = '#666';
        smCaptureBtn.style.borderColor = '#d9d9d9';
        smCaptureStatus.style.display = 'none';

        if (res.success && res.count > 0) {
          let text = '===== 店铺抓包结果：共 ' + res.count + ' 个请求 =====\n\n';
          res.requests.forEach((r, i) => {
            text += '────── 请求 ' + (i + 1) + ' ──────\n';
            text += '时间: ' + (r.timestamp || '') + '\n';
            text += 'URL:  ' + r.url + '\n';
            text += '方法: ' + r.method + '\n';
            if (r.postData) text += '参数: ' + r.postData + '\n';
            if (r.responseBody) {
              try {
                const json = JSON.parse(r.responseBody);
                text += '响应: ' + JSON.stringify(json, null, 2).substring(0, 5000) + '\n';
              } catch(e) {
                text += '响应: ' + r.responseBody.substring(0, 5000) + '\n';
              }
            }
            text += '\n';
          });
          showCaptureResult(text);
        } else {
          showToast('未捕获到请求，请确保在店铺后台进行了操作');
        }
      }
    });
  }

  // 全选复选框
  const selectAll = $('#smSelectAll');
  if (selectAll && smGoodsTableBody) {
    selectAll.addEventListener('change', () => {
      const checks = smGoodsTableBody.querySelectorAll('.sm-goods-check');
      checks.forEach(cb => { cb.checked = selectAll.checked; });
    });
    smGoodsTableBody.addEventListener('change', (e) => {
      if (e.target.classList.contains('sm-goods-check')) {
        const checks = smGoodsTableBody.querySelectorAll('.sm-goods-check');
        selectAll.checked = Array.from(checks).every(cb => cb.checked);
      }
    });
  }

  // 商品状态选项切换时保存
  document.querySelectorAll('input[name="smGoodsStatus"]').forEach(radio => {
    radio.addEventListener('change', () => { localStorage.setItem('sm_goodsStatus', radio.value); });
  });

  // 商品数量选项切换时重新过滤并保存
  document.querySelectorAll('input[name="smGoodsQty"]').forEach(radio => {
    radio.addEventListener('change', () => {
      localStorage.setItem('sm_goodsQty', radio.value);
      if (smGoods.length > 0) applySmQtyFilter();
    });
  });
  const qtyNInput = $('#smQtyN');
  if (qtyNInput) {
    qtyNInput.addEventListener('change', () => {
      localStorage.setItem('sm_goodsQtyN', qtyNInput.value);
      const nRadio = document.querySelector('input[name="smGoodsQty"][value="N个"]');
      if (nRadio && nRadio.checked && smGoods.length > 0) applySmQtyFilter();
    });
    qtyNInput.addEventListener('focus', () => {
      const nRadio = document.querySelector('input[name="smGoodsQty"][value="N个"]');
      if (nRadio) { nRadio.checked = true; localStorage.setItem('sm_goodsQty', 'N个'); }
    });
  }

  // 店铺管理弹窗
  const smShopModalEl = $('#smShopModal');
  const smShopModalClose = $('#smShopModalClose');
  if (smShopModalClose) smShopModalClose.addEventListener('click', closeSmShopModal);
  if (smShopModalEl) smShopModalEl.addEventListener('click', (e) => { if (e.target === smShopModalEl) closeSmShopModal(); });

  // 添加店铺按钮
  const addShopBtn = $('#smAddShopBtn');
  if (addShopBtn) addShopBtn.addEventListener('click', () => openSmEditShop(null));

  // 编辑店铺弹窗
  const editModalEl = $('#smEditShopModal');
  const editClose = $('#smEditShopModalClose');
  if (editClose) editClose.addEventListener('click', closeSmEditShop);
  if (editModalEl) editModalEl.addEventListener('click', (e) => { if (e.target === editModalEl) closeSmEditShop(); });

  // 保存店铺
  const saveShopBtn = $('#smSaveShopBtn');
  if (saveShopBtn) saveShopBtn.addEventListener('click', saveSmShop);

  // 弹窗内登录按钮：先保存再登录
  const loginShopBtn = $('#smLoginShopBtn');
  if (loginShopBtn) loginShopBtn.addEventListener('click', handleSmEditShopLogin);

  // 发送确认弹窗
  const sendModalEl = $('#smSendModal');
  const sendModalClose = $('#smSendModalClose');
  if (sendModalClose) sendModalClose.addEventListener('click', closeSmSendModal);
  if (sendModalEl) sendModalEl.addEventListener('click', (e) => { if (e.target === sendModalEl) closeSmSendModal(); });
  const confirmSendBtn = $('#smConfirmSendBtn');
  if (confirmSendBtn) confirmSendBtn.addEventListener('click', confirmSmSend);

  // 监听店铺登录成功事件
  if (window.electronAPI.onShopLoginSuccess) {
    window.electronAPI.onShopLoginSuccess(async (data) => {
      updateSmLoginStatus(true, data?.shopName || '');
      addSmLog('success', `店铺后台登录成功${data?.shopName ? '：' + data.shopName : ''}`);
      // 如果店铺名称为空，用获取到的名称自动回填
      if (data?.shopName && data?.accountId) {
        const accounts = await window.electronAPI.getShopAccounts();
        const account = accounts.find(a => a.id === data.accountId);
        if (account && !account.name) {
          await window.electronAPI.saveShopAccount({ ...account, name: data.shopName });
          await loadShopAccounts();
          addSmLog('info', `已自动获取店铺名称：${data.shopName}`);
        }
      }
      // 如果编辑弹窗正在显示，关闭后打开店铺列表
      const editModal = $('#smEditShopModal');
      if (editModal && editModal.style.display !== 'none') {
        closeSmEditShop();
        openSmShopModal();
      }
    });
  }
}

// ===== 店铺管理弹窗 =====
async function openSmShopModal() {
  const modal = $('#smShopModal');
  modal.style.display = 'flex';

  const accounts = await window.electronAPI.getShopAccounts();
  const statusResult = await window.electronAPI.checkShopAccountsStatus();
  const statusMap = statusResult ? statusResult.statusMap || {} : {};
  const list = $('#smShopList');
  const empty = $('#smShopEmpty');

  if (!accounts || accounts.length === 0) {
    list.style.display = 'none';
    empty.style.display = 'block';
  } else {
    list.style.display = 'flex';
    empty.style.display = 'none';
    list.innerHTML = '';

    accounts.forEach(account => {
      const isOnline = !!statusMap[account.id];
      const item = document.createElement('div');
      item.className = 'sm-shop-item';
      item.innerHTML = `
        <div class="sm-shop-item-info">
          <span class="sm-shop-item-name">${escapeHtml(account.name || account.username)}</span>
          <span class="sm-shop-item-user">${escapeHtml(account.username)}</span>
        </div>
        <span class="sm-shop-status ${isOnline ? 'online' : 'offline'}">${isOnline ? '在线' : '离线'}</span>
        <div class="sm-shop-item-actions">
          <button class="btn btn-sm ${isOnline ? 'btn-success-outline' : 'btn-primary'}" data-action="login">${isOnline ? '重新登录' : '登录'}</button>
          <button class="btn btn-primary btn-sm" data-action="edit">编辑</button>
          <button class="btn btn-danger" data-action="delete">删除</button>
        </div>
      `;
      item.querySelector('[data-action="login"]').addEventListener('click', async () => {
        closeSmShopModal();
        await window.electronAPI.switchShopAccount(account);
        window.electronAPI.openShopLogin({ id: account.id, username: account.username, password: account.password });
      });
      item.querySelector('[data-action="edit"]').addEventListener('click', () => {
        closeSmShopModal();
        openSmEditShop(account);
      });
      item.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        await window.electronAPI.deleteShopAccount(account.id);
        await loadShopAccounts();
        openSmShopModal();
        addSmLog('info', `已删除店铺：${account.name || account.username}`);
      });
      list.appendChild(item);
    });
  }
}

function closeSmShopModal() {
  $('#smShopModal').style.display = 'none';
}

// ===== 添加/编辑店铺弹窗 =====
function openSmEditShop(account) {
  const modal = $('#smEditShopModal');
  const title = $('#smEditShopTitle');
  const idInput = $('#smEditShopId');
  const nameInput = $('#smShopName');
  const userInput = $('#smShopUsername');
  const pwdInput = $('#smShopPassword');
  const autoSendRadios = document.querySelectorAll('input[name="smAutoSend"]');

  if (account) {
    title.textContent = '编辑店铺';
    idInput.value = account.id;
    nameInput.value = account.name || '';
    userInput.value = account.username || '';
    pwdInput.value = account.password || '';
    autoSendRadios.forEach(r => { r.checked = r.value === (account.autoSend ? '1' : '0'); });
  } else {
    title.textContent = '添加店铺';
    idInput.value = '';
    nameInput.value = '';
    userInput.value = '';
    pwdInput.value = '';
    autoSendRadios.forEach(r => { r.checked = r.value === '0'; });
  }

  modal.style.display = 'flex';
  userInput.focus();
}

function closeSmEditShop() {
  $('#smEditShopModal').style.display = 'none';
}

// 弹窗内登录按钮：先保存账号，再打开登录窗口
async function handleSmEditShopLogin() {
  if (!requireTier('shopManage')) return;
  const username = $('#smShopUsername').value.trim();
  const password = $('#smShopPassword').value;

  if (!username) { showToast('请输入登录账号'); return; }
  if (!password) { showToast('请输入登录密码'); return; }

  // 先保存
  const id = $('#smEditShopId').value;
  const name = $('#smShopName').value.trim();
  const autoSend = document.querySelector('input[name="smAutoSend"]:checked')?.value === '1';

  const result = await window.electronAPI.saveShopAccount({ id: id || undefined, name, username, password, autoSend });
  if (!result.success) {
    showToast(result.error || '保存失败');
    return;
  }
  await loadShopAccounts();

  // 找到保存后的账号ID（新增时result.list里最后一个就是）
  const accounts = result.list || await window.electronAPI.getShopAccounts();
  const account = accounts.find(a => a.username === username) || accounts[accounts.length - 1];

  addSmLog('info', `正在打开店铺后台登录窗口：${account.name || account.username}...`);
  await window.electronAPI.openShopLogin({
    id: account.id,
    username: account.username,
    password: account.password,
    name: account.name,
    autoSend: account.autoSend
  });
  // 登录成功后弹窗会由 onShopLoginSuccess 回调自动关闭
}

async function saveSmShop() {
  if (!requireTier('shopManage')) return;
  const id = $('#smEditShopId').value;
  const name = $('#smShopName').value.trim();
  const username = $('#smShopUsername').value.trim();
  const password = $('#smShopPassword').value;
  const autoSend = document.querySelector('input[name="smAutoSend"]:checked')?.value === '1';

  if (!username) { showToast('请输入登录账号'); return; }
  if (!password) { showToast('请输入登录密码'); return; }

  const result = await window.electronAPI.saveShopAccount({ id: id || undefined, name, username, password, autoSend });
  if (result.success) {
    await loadShopAccounts();
    closeSmEditShop();
    addSmLog('success', `店铺"${name || username}"已保存`);
  } else {
    showToast(result.error || '保存失败');
  }
}

// ========== 店铺登录 ==========

async function handleSmLogin() {
  if (!requireTier('shopManage')) return;
  const selectedId = smShopSelect.value;
  if (!selectedId) {
    showToast('请先选择一个店铺');
    return;
  }

  const accounts = await window.electronAPI.getShopAccounts();
  const account = accounts.find(a => a.id === selectedId);
  if (!account) {
    showToast('店铺账号不存在');
    return;
  }

  addSmLog('info', `正在打开店铺后台登录窗口：${account.name || account.username}...`);
  await window.electronAPI.openShopLogin({
    id: account.id,
    username: account.username,
    password: account.password,
    name: account.name,
    autoSend: account.autoSend
  });
}

function updateSmLoginStatus(loggedIn, shopName) {
  smLoggedIn = loggedIn;

  if (loggedIn) {
    smStatusDot.className = 'sm-shop-status-inline online';
    smStatusDot.textContent = '在线';
    const queryBtn = $('#smQueryBtn');
    if (queryBtn) queryBtn.disabled = false;
  } else {
    smStatusDot.className = 'sm-shop-status-inline offline';
    smStatusDot.textContent = '离线';
    const queryBtn = $('#smQueryBtn');
    if (queryBtn) queryBtn.disabled = true;
  }
}

async function checkSmLoginStatus() {
  if (window.electronAPI.getShopLoginStatus) {
    const status = await window.electronAPI.getShopLoginStatus();
    if (status && status.loggedIn) {
      updateSmLoginStatus(true, status.shopName);
      addSmLog('info', '已恢复店铺登录状态' + (status.shopName ? '：' + status.shopName : ''));
    }
  }
}

// ========== 商品查询 ==========

async function handleSmQuery() {
  if (!requireTier('shopManage')) return;
  console.log('[SM] handleSmQuery called, smLoggedIn:', smLoggedIn);
  if (!smLoggedIn) {
    showToast('请先登录店铺后台');
    return;
  }

  const queryBtn = $('#smQueryBtn');
  queryBtn.disabled = true;
  queryBtn.textContent = '查询中...';
  addSmLog('info', '正在查询店铺商品...');

  try {
    const params = {
      dateFrom: $('#smDateFrom').value || '',
      dateTo: $('#smDateTo').value || '',
      priceMin: $('#smPriceMin').value || '',
      priceMax: $('#smPriceMax').value || '',
      goodsStatus: (document.querySelector('input[name="smGoodsStatus"]:checked') || {}).value || '在售'
    };

    const result = await window.electronAPI.shopQueryGoods(params);

    if (result.success) {
      smGoods = result.goods || [];
      applySmQtyFilter();
      addSmLog('success', `查询完成，共 ${smGoods.length} 条SKU记录`);

      if (smGoods.length > 0) {
        $('#smExportBtn').disabled = false;
        $('#smSendBtn').disabled = false;
        $('#smSendDownBtn').disabled = false;
      }

      if (result.message) {
        addSmLog('warn', result.message);
      }
    } else {
      smGoods = [];
      smFilteredGoods = [];
      renderSmGoodsTable();
      addSmLog('error', `查询失败: ${result.error}`);
    }
  } catch (err) {
    addSmLog('error', `查询异常: ${err.message}`);
  } finally {
    queryBtn.disabled = false;
    queryBtn.textContent = '查询商品';
  }
}

function renderSmGoodsTable() {
  if (smFilteredGoods.length === 0) {
    smGoodsTableBody.innerHTML = '<tr class="wms-empty-row"><td colspan="8" class="wms-empty-state">暂无数据</td></tr>';
    smGoodsCount.classList.remove('visible');
    const selectAll = $('#smSelectAll');
    if (selectAll) selectAll.checked = false;
    return;
  }

  // 按 productCode 分组
  const groups = [];
  const groupMap = new Map();
  smFilteredGoods.forEach((item, idx) => {
    const pcode = item.productCode || '';
    if (!groupMap.has(pcode)) {
      const group = { productCode: pcode, items: [], startIdx: idx };
      groups.push(group);
      groupMap.set(pcode, group);
    }
    groupMap.get(pcode).items.push({ ...item, originalIdx: idx });
  });

  smGoodsCount.textContent = `${smFilteredGoods.length} 个`;
  smGoodsCount.classList.add('visible');

  smGoodsTableBody.innerHTML = '';
  let spuSeq = 0;
  groups.forEach((group) => {
    spuSeq++;
    const firstItem = group.items[0];
    const skuCount = group.items.length;

    // 价格范围
    const prices = group.items.map(i => i.price).filter(p => p != null).map(p => parseFloat(p));
    let priceDisplay = '';
    if (prices.length > 0) {
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      priceDisplay = min === max ? `¥${min}` : `¥${min} ~ ¥${max}`;
    }

    // 主行（SPU 行）
    const mainTr = document.createElement('tr');
    mainTr.className = 'sm-spu-row';
    mainTr.style.cursor = 'pointer';
    mainTr.dataset.spu = group.productCode;
    mainTr.innerHTML = `
      <td><input type="checkbox" class="sm-goods-check" data-idx="${firstItem.originalIdx}" checked /></td>
      <td>${spuSeq}</td>
      <td><b>${escapeHtml(group.productCode)}</b> <span class="sm-sku-toggle" style="color:#2d7be0;font-size:12px;margin-left:6px;">▶ ${skuCount}个SKU</span></td>
      <td></td>
      <td>${firstItem.image ? `<span class="sm-thumb-wrap"><img class="sm-thumb" src="${escapeHtml(firstItem.image)}" /><img class="sm-thumb-zoom" src="${escapeHtml(firstItem.image)}" /></span>` : ''}</td>
      <td title="${escapeHtml(firstItem.name || '')}">${escapeHtml(firstItem.name || '')}</td>
      <td>${priceDisplay}</td>
      <td>${escapeHtml(firstItem.listDate || '')}</td>
    `;
    smGoodsTableBody.appendChild(mainTr);

    // SKU 子行
    group.items.forEach((item, subIdx) => {
      const subTr = document.createElement('tr');
      subTr.className = 'sm-sku-row';
      subTr.style.display = 'none';
      subTr.dataset.spuSku = group.productCode;
      subTr.innerHTML = `
        <td><input type="checkbox" class="sm-goods-check" data-idx="${item.originalIdx}" checked /></td>
        <td>${spuSeq}-${subIdx + 1}</td>
        <td>${escapeHtml(item.productCode || '')}</td>
        <td>${escapeHtml(item.sku || '')}</td>
        <td></td>
        <td title="${escapeHtml(item.name || '')}">└─ ${escapeHtml(item.name || '')}</td>
        <td>${item.price != null ? '¥' + item.price : ''}</td>
        <td>${escapeHtml(item.listDate || '')}</td>
      `;
      smGoodsTableBody.appendChild(subTr);
    });
  });

  // 展开/折叠事件
  smGoodsTableBody.querySelectorAll('.sm-spu-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT' && e.target.type === 'checkbox') return;
      const pcode = row.dataset.spu;
      const skuRows = smGoodsTableBody.querySelectorAll(`tr[data-spu-sku="${pcode}"]`);
      const toggleEl = row.querySelector('.sm-sku-toggle');
      const isHidden = skuRows.length > 0 && skuRows[0].style.display === 'none';
      skuRows.forEach(r => {
        r.style.display = isHidden ? '' : 'none';
      });
      if (toggleEl) {
        toggleEl.textContent = isHidden ? `▼ ${skuRows.length}个SKU` : `▶ ${skuRows.length}个SKU`;
      }
    });
  });

  // 图片悬停放大：动态定位放大图到鼠标旁边
  smGoodsTableBody.querySelectorAll('.sm-thumb-wrap').forEach(wrap => {
    wrap.addEventListener('mousemove', (e) => {
      const zoom = wrap.querySelector('.sm-thumb-zoom');
      if (zoom) {
        zoom.style.left = (e.clientX + 15) + 'px';
        zoom.style.top = Math.max(10, e.clientY - 140) + 'px';
      }
    });
  });

  const selectAll = $('#smSelectAll');
  if (selectAll) selectAll.checked = true;
}

function applySmQtyFilter() {
  if (!smGoods || smGoods.length === 0) {
    smFilteredGoods = [];
    renderSmGoodsTable();
    return;
  }

  const qtyRadio = document.querySelector('input[name="smGoodsQty"]:checked');
  const qtyVal = qtyRadio ? qtyRadio.value : '全部';

  switch (qtyVal) {
    case '第1个':
      smFilteredGoods = [smGoods[0]];
      break;
    case '最后1个':
      smFilteredGoods = [smGoods[smGoods.length - 1]];
      break;
    case '最低价': {
      const withPrice = smGoods.filter(g => g.price != null);
      if (withPrice.length > 0) {
        const min = withPrice.reduce((a, b) => parseFloat(a.price) <= parseFloat(b.price) ? a : b);
        smFilteredGoods = [min];
      } else {
        smFilteredGoods = [];
      }
      break;
    }
    case '最高价': {
      const withPrice = smGoods.filter(g => g.price != null);
      if (withPrice.length > 0) {
        const max = withPrice.reduce((a, b) => parseFloat(a.price) >= parseFloat(b.price) ? a : b);
        smFilteredGoods = [max];
      } else {
        smFilteredGoods = [];
      }
      break;
    }
    case 'N个': {
      const n = parseInt($('#smQtyN').value) || 10;
      const shuffled = smGoods.slice().sort(() => Math.random() - 0.5);
      smFilteredGoods = shuffled.slice(0, n);
      break;
    }
    default:
      smFilteredGoods = smGoods.slice();
      break;
  }

  renderSmGoodsTable();
}

function getSelectedSmSkus() {
  const checks = smGoodsTableBody.querySelectorAll('.sm-goods-check');
  const skus = [];
  checks.forEach(cb => {
    if (cb.checked) {
      const idx = parseInt(cb.dataset.idx);
      if (smFilteredGoods[idx]) {
        skus.push(smFilteredGoods[idx].sku);
      }
    }
  });
  return skus;
}

// ========== 导出 TXT ==========

async function handleSmExport() {
  const skus = getSelectedSmSkus();
  if (skus.length === 0) {
    showToast('请先勾选要导出的商品');
    return;
  }

  addSmLog('info', `正在导出 ${skus.length} 个SKU...`);
  const shopName = smShopSelect.options[smShopSelect.selectedIndex]?.text || '';
  const result = await window.electronAPI.exportSkuTxt({ skus, shopName });

  if (result.success) {
    addSmLog('success', `已导出到: ${result.fileName} (${skus.length}个SKU)`);
    showToast(`已导出 ${skus.length} 个SKU`);
  } else {
    addSmLog('error', `导出失败: ${result.error}`);
  }
}

// ========== 发送到打标/下标 ==========

let smSendType = '打标'; // 当前发送类型

async function handleSmSend(type) {
  if (!requireTier('shopManage')) return;
  smSendType = type || '打标';
  const skus = getSelectedSmSkus();
  if (skus.length === 0) {
    showToast('请先勾选要发送的商品');
    return;
  }

  // 打开发送确认弹窗
  const modal = $('#smSendModal');
  const info = $('#smSendInfo');
  info.textContent = `即将发送 ${skus.length} 个SKU到店铺${smSendType}任务`;

  // 加载快捷模式列表
  const smSendMode = $('#smSendMode');
  const modes = await window.electronAPI.getModes();
  smSendMode.innerHTML = '<option value="">请选择模式</option>';
  modes.forEach(mode => {
    const opt = document.createElement('option');
    opt.value = mode.name;
    opt.textContent = mode.name;
    smSendMode.appendChild(opt);
  });
  // 根据类型选择默认模式
  let defaultMode;
  if (smSendType === '下标') {
    defaultMode = modes.find(m => m.name.includes('下标'));
  } else {
    defaultMode = modes.find(m => m.name === '入仓打标') || modes.find(m => m.name.includes('打标'));
  }
  if (defaultMode) smSendMode.value = defaultMode.name;

  // 加载商家端店铺列表
  const smSendShop = $('#smSendShop');
  smSendShop.innerHTML = '<option value="">请选择店铺</option>';
  shopOptions.forEach(opt => {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    smSendShop.appendChild(o);
  });

  // 加载仓库列表
  const smSendWarehouse = $('#smSendWarehouse');
  smSendWarehouse.innerHTML = '<option value="">请选择仓库</option>';
  const warehouseOpts = warehouseSelect.querySelectorAll('option');
  warehouseOpts.forEach(opt => {
    if (opt.value) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.textContent;
      smSendWarehouse.appendChild(o);
    }
  });

  modal.style.display = 'flex';
}

function closeSmSendModal() {
  $('#smSendModal').style.display = 'none';
}

async function confirmSmSend() {
  const skus = getSelectedSmSkus();
  if (skus.length === 0) {
    showToast('没有可发送的SKU');
    return;
  }

  const modeName = $('#smSendMode').value;
  const targetShopId = $('#smSendShop').value;
  const targetWarehouseId = $('#smSendWarehouse').value;

  if (!modeName) { showToast('请选择快捷模式'); return; }

  // 获取模式配置
  const modes = await window.electronAPI.getModes();
  const targetMode = modes.find(m => m.name === modeName);

  // 1. 填充 SKU 到店铺打标页的输入框
  skuInput.value = skus.join('，');

  // 2. 设置店铺（如果选择了）
  if (targetShopId) {
    shopSelect.value = targetShopId;
    const shopOpt = shopOptions.find(o => o.value === targetShopId);
    if (shopOpt) shopSearchInput.value = shopOpt.label;
  }

  // 3. 设置仓库（如果选择了）
  if (targetWarehouseId) {
    warehouseSelect.value = targetWarehouseId;
  }

  // 4. 应用快捷模式配置
  if (targetMode && targetMode.config) {
    applyConfig(targetMode.config);
    modeSelect.value = modeName;
    modeSelect.classList.toggle('placeholder', !modeSelect.value);
  }

  // 5. 调用已有的 addTask() 添加到任务列表
  addTask();

  // 6. 更新统计
  await window.electronAPI.updateSmStats({ shops: 1, skus: skus.length });
  await updateSmDashboard();

  // 7. 关闭弹窗并切换页面
  closeSmSendModal();
  addSmLog('success', `已发送 ${skus.length} 个SKU到${smSendType}任务（模式：${modeName}）`);

  // 切换到店铺打标页面
  document.querySelector('[data-page="shopLabel"]').click();
}

// ========== 数据看板 ==========

async function loadSmStats() {
  if (!window.electronAPI.getSmStats) return;
  const stats = await window.electronAPI.getSmStats();
  const shopsEl = $('#smTodayShops');
  const skusEl = $('#smTodaySkus');
  if (shopsEl) shopsEl.textContent = stats.shops || 0;
  if (skusEl) skusEl.textContent = stats.skus || 0;
}

async function updateSmDashboard() {
  await loadSmStats();
}

// ========== 店铺管理日志 ==========

function addSmLog(type, message) {
  const now = new Date();
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const div = document.createElement('div');
  div.className = `log-${type}`;
  div.textContent = `[${time}] ${message}`;
  smLogBox.appendChild(div);
  while (smLogBox.childNodes.length > LOG_MAX_LINES) {
    smLogBox.removeChild(smLogBox.firstChild);
  }
  smLogBox.scrollTop = smLogBox.scrollHeight;
}

// ========== 异常订单处理模块 ==========

let aoOrders = [];
let aoCurrentPage = 1;
let aoPageSize = 20;
let aoTotalCount = 0;
let aoIsQuerying = false;

const aoOrderTableBody = $('#aoOrderTableBody');
const aoOrderCountEl = $('#aoOrderCount');

function initAoModule() {
  initAoYearSelect();
  initAoFiltersFromUserData();
  initAoEventListeners();
}

async function initAoFiltersFromUserData() {
  try {
    const data = await window.electronAPI.getUserData();
    if (!data) return;

    // 商家名称：多条 → 下拉选择，单条 → 只读文本
    const merchantList = data.merchantList || [];
    const oldMerchantEl = $('#aoMerchantName');
    if (merchantList.length > 1) {
      const sel = document.createElement('select');
      sel.id = 'aoMerchantName';
      const defOpt = document.createElement('option');
      defOpt.value = '';
      defOpt.textContent = '全部';
      sel.appendChild(defOpt);
      merchantList.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
      });
      sel.value = merchantList[0];
      oldMerchantEl.parentElement.replaceChild(sel, oldMerchantEl);
    } else {
      oldMerchantEl.value = data.merchantName || (merchantList[0] || '');
      oldMerchantEl.placeholder = (data.merchantName || merchantList[0]) ? '' : '未获取';
    }

    // 事业部：多条 → 下拉选择（value=deptNo），单条 → 只读文本
    const deptPairs = data.deptPairs || [];
    const deptList = data.deptList || [];
    const oldDeptEl = $('#aoDeptName');
    if (deptPairs.length > 1) {
      const sel = document.createElement('select');
      sel.id = 'aoDeptName';
      const defOpt = document.createElement('option');
      defOpt.value = '';
      defOpt.textContent = '全部';
      sel.appendChild(defOpt);
      deptPairs.forEach(pair => {
        const opt = document.createElement('option');
        opt.value = pair.deptNo;
        opt.textContent = pair.deptName;
        sel.appendChild(opt);
      });
      // 默认选中当前订阅的事业部
      const curDeptNo = data.selectedDeptId || data.departmentId || '';
      if (curDeptNo && deptPairs.find(p => p.deptNo === curDeptNo)) {
        sel.value = curDeptNo;
      } else {
        sel.value = deptPairs[0].deptNo;
      }
      oldDeptEl.parentElement.replaceChild(sel, oldDeptEl);
    } else {
      oldDeptEl.value = data.departmentName || (deptList[0] || '');
      oldDeptEl.placeholder = (data.departmentName || deptList[0]) ? '' : '未获取';
      // 存储 deptNo 到 dataset，查询时使用
      oldDeptEl.dataset.deptNo = data.selectedDeptId || data.departmentId || (deptPairs[0] && deptPairs[0].deptNo) || '';
    }
  } catch (e) {
    // 静默失败
  }
}

function initAoYearSelect() {
  const sel = $('#aoYear');
  const currentYear = new Date().getFullYear();
  sel.innerHTML = '';
  for (let y = currentYear; y >= currentYear - 2; y--) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y + '年';
    if (y === currentYear) opt.selected = true;
    sel.appendChild(opt);
  }
}

function initAoEventListeners() {
  $('#aoQueryBtn').addEventListener('click', () => handleAoQuery());
  $('#aoResetBtn').addEventListener('click', () => handleAoReset());

  // 全选复选框
  $('#aoSelectAll').addEventListener('change', (e) => {
    $$('.ao-row-check').forEach(cb => { cb.checked = e.target.checked; });
  });

  // 表格事件委托：单条处理按钮 + 复选框联动全选
  aoOrderTableBody.addEventListener('click', async (e) => {
    // 单条处理按钮
    const btn = e.target.closest('.ao-action-link');
    if (btn) {
      const idx = parseInt(btn.dataset.idx);
      const order = aoOrders[idx];
      if (!order) return;
      await handleAoProcess([order], btn);
    }
  });
  aoOrderTableBody.addEventListener('change', (e) => {
    if (e.target.classList.contains('ao-row-check')) {
      const allCbs = $$('.ao-row-check');
      const allChecked = [...allCbs].every(cb => cb.checked);
      $('#aoSelectAll').checked = allChecked;
    }
  });

  // 批量处理按钮
  $('#aoBatchBtn').addEventListener('click', async () => {
    const checkedIdxs = [...$$('.ao-row-check')].filter(cb => cb.checked).map(cb => parseInt(cb.dataset.idx));
    if (checkedIdxs.length === 0) {
      showToast('请先勾选需要处理的订单', 2000);
      return;
    }
    const selectedOrders = checkedIdxs.map(i => aoOrders[i]).filter(Boolean);
    await handleAoProcess(selectedOrders, $('#aoBatchBtn'));
  });

  // 网络抓包按钮
  let aoCapturing = false;
  const captureBtn = $('#aoCaptureBtn');
  const captureStatus = $('#aoCaptureStatus');
  if (captureBtn) {
    captureBtn.addEventListener('click', async () => {
      if (!requireTier('abnormalOrders')) return;
      if (!aoCapturing) {
        // 开始抓包
        const res = await window.electronAPI.startNetworkCapture();
        if (res.success) {
          aoCapturing = true;
          captureBtn.textContent = '\u23F9 停止抓包';
          captureBtn.style.background = '#e74c3c';
          captureBtn.style.color = '#fff';
          captureBtn.style.borderColor = '#e74c3c';
          captureStatus.style.display = 'inline';
          captureStatus.textContent = '抓包中... 请在弹出的JD后台窗口操作，完成后点击停止';
          captureStatus.style.color = '#e74c3c';
        } else {
          showToast(res.error || '启动抓包失败');
        }
      } else {
        // 停止抓包
        captureBtn.textContent = '停止中...';
        captureBtn.disabled = true;
        const res = await window.electronAPI.stopNetworkCapture();
        aoCapturing = false;
        captureBtn.disabled = false;
        captureBtn.textContent = '\uD83D\uDD0D 开始抓包';
        captureBtn.style.background = '#f0f0f0';
        captureBtn.style.color = '#666';
        captureBtn.style.borderColor = '#d9d9d9';
        captureStatus.style.display = 'none';

        if (res.success && res.count > 0) {
          // 格式化结果显示在弹窗
          let text = '===== 抓包结果：共 ' + res.count + ' 个API请求 =====\n\n';
          res.requests.forEach((r, i) => {
            text += '────── 请求 ' + (i + 1) + ' ──────\n';
            text += '时间: ' + (r.timestamp || '') + '\n';
            text += 'URL:  ' + r.url + '\n';
            text += '方法: ' + r.method + '\n';
            if (r.postData) text += '参数: ' + r.postData + '\n';
            if (r.responseBody) {
              try {
                const json = JSON.parse(r.responseBody);
                text += '响应: ' + JSON.stringify(json, null, 2).substring(0, 5000) + '\n';
              } catch(e) {
                text += '响应: ' + r.responseBody.substring(0, 5000) + '\n';
              }
            }
            text += '\n';
          });
          showCaptureResult(text);
        } else {
          showToast('未捕获到API请求，请确保在JD后台页面进行了操作');
        }
      }
    });
  }

  // 分页按钮
  $('#aoPageFirst').addEventListener('click', () => { aoCurrentPage = 1; handleAoQuery(); });
  $('#aoPagePrev').addEventListener('click', () => { if (aoCurrentPage > 1) { aoCurrentPage--; handleAoQuery(); } });
  $('#aoPageNext').addEventListener('click', () => {
    const totalPages = Math.ceil(aoTotalCount / aoPageSize);
    if (aoCurrentPage < totalPages) { aoCurrentPage++; handleAoQuery(); }
  });
  $('#aoPageLast').addEventListener('click', () => {
    aoCurrentPage = Math.ceil(aoTotalCount / aoPageSize) || 1;
    handleAoQuery();
  });
}

async function handleAoQuery() {
  if (aoIsQuerying) return;
  aoIsQuerying = true;

  const queryBtn = $('#aoQueryBtn');
  const origText = queryBtn.textContent;
  queryBtn.textContent = '查询中...';
  queryBtn.disabled = true;

  const deptEl = $('#aoDeptName');
  // select 的 value 已经是 deptNo；readonly input 从 dataset 取 deptNo
  const deptValue = deptEl.tagName === 'SELECT' ? deptEl.value : (deptEl.dataset.deptNo || '');

  const params = {
    merchantName: $('#aoMerchantName').value.trim(),
    deptName: deptValue,
    orderNo: $('#aoOrderNo').value.trim(),
    shopName: $('#aoShopName') ? $('#aoShopName').value.trim() : '',
    year: $('#aoYear').value,
    source: $('#aoSource').value,
    page: aoCurrentPage,
    pageSize: aoPageSize
  };

  addAoLog('info', '正在查询异常订单...');

  try {
    const result = await window.electronAPI.queryAbnormalOrders(params);
    if (result.success) {
      aoOrders = result.orders || [];
      aoTotalCount = result.total || 0;
      renderAoTable();
      renderAoPagination();
      updateAoDashboard({ billExCount: result.billExCount || result.total, soExCount: result.soExCount || 0 });
      addAoLog('success', `查询完成，共 ${aoTotalCount} 条记录`);
    } else {
      aoOrders = [];
      aoTotalCount = 0;
      renderAoTable();
      renderAoPagination();
      addAoLog('error', '查询失败: ' + (result.error || '未知错误'));
    }
  } catch (err) {
    aoOrders = [];
    aoTotalCount = 0;
    renderAoTable();
    renderAoPagination();
    addAoLog('error', '查询异常: ' + err.message);
  }

  queryBtn.textContent = origText;
  queryBtn.disabled = false;
  aoIsQuerying = false;
}

function handleAoReset() {
  // select → 重置为"全部"，readonly input → 保持不变（账号固定值）
  const merchantEl = $('#aoMerchantName');
  if (merchantEl.tagName === 'SELECT') merchantEl.value = '';
  const deptEl = $('#aoDeptName');
  if (deptEl.tagName === 'SELECT') deptEl.value = '';
  $('#aoOrderNo').value = '';
  if ($('#aoShopName')) $('#aoShopName').value = '';
  initAoYearSelect();
  $('#aoSource').value = '';
  aoCurrentPage = 1;
  addAoLog('info', '筛选条件已重置');
}

async function handleAoProcess(orders, triggerBtn) {
  if (!requireTier('abnormalOrders')) return;
  if (!orders || orders.length === 0) return;

  const count = orders.length;
  const label = count === 1 ? orders[0].billNo : `${count} 条订单`;

  // 禁用按钮防止重复点击
  const origText = triggerBtn.textContent;
  triggerBtn.textContent = '处理中...';
  triggerBtn.disabled = true;

  addAoLog('info', `正在处理 ${label}...`);

  try {
    const result = await window.electronAPI.handleAbnormalOrder({ orders });
    if (result.success) {
      addAoLog('success', `${label} 处理成功: ${result.message || '操作成功'}`);
      showToast(result.message || '处理成功', 3000);
      // 处理成功后自动刷新列表
      setTimeout(() => handleAoQuery(), 1000);
    } else {
      addAoLog('error', `${label} 处理失败: ${result.error || '未知错误'}`);
      showToast('处理失败: ' + (result.error || '未知错误'), 3000, 'error');
    }
  } catch (err) {
    addAoLog('error', `处理异常: ${err.message}`);
    showToast('处理异常: ' + err.message, 3000, 'error');
  }

  triggerBtn.textContent = origText;
  triggerBtn.disabled = false;
}

function renderAoTable() {
  if (!aoOrders || aoOrders.length === 0) {
    aoOrderTableBody.innerHTML = '<tr class="wms-empty-row"><td colspan="12" class="wms-empty-state">暂无数据，请设置筛选条件后查询</td></tr>';
    aoOrderCountEl.classList.remove('visible');
    if ($('#aoSelectAll')) $('#aoSelectAll').checked = false;
    return;
  }

  aoOrderCountEl.textContent = aoTotalCount;
  aoOrderCountEl.classList.add('visible');
  if ($('#aoSelectAll')) $('#aoSelectAll').checked = false;

  const startIdx = (aoCurrentPage - 1) * aoPageSize;
  aoOrderTableBody.innerHTML = aoOrders.map((order, idx) => {
    const canProcess = order.id && order.exceptionCode != null;
    // CLPS单据号：仅当 billNo 以 CSL/CDB 开头时显示，否则与订单号相同无意义
    const clpsNo = (order.billNo && /^(CSL|CDB)/i.test(order.billNo)) ? order.billNo : '';
    return `
    <tr>
      <td style="text-align:center"><input type="checkbox" class="ao-row-check" data-idx="${idx}" ${canProcess ? '' : 'disabled title="该订单不可处理"'}></td>
      <td style="text-align:center">${startIdx + idx + 1}</td>
      <td>${esc(order.sellerBillNo || '')}</td>
      <td>${esc(clpsNo)}</td>
      <td>${esc(order.shopName || '')}</td>
      <td>${esc(order.deptName || '')}</td>
      <td title="${esc(order.exceptionCodeStr || '')}">${esc(order.exceptionCodeStr || '')}</td>
      <td title="${esc(order.exceptionDesc || '')}">${esc(order.exceptionDesc || '')}</td>
      <td title="${esc(order.handlerAction || '')}">${esc(order.handlerAction || '')}</td>
      <td>${formatAoTime(order.createTime)}</td>
      <td style="text-align:center">${getAoSourceBadge(order._source)}</td>
      <td style="text-align:center">${canProcess
        ? `<button class="ao-action-link" data-idx="${idx}">处理</button>`
        : `<span style="color:#999;font-size:11px">—</span>`
      }</td>
    </tr>`;
  }).join('');
}

function esc(str) {
  return escapeHtml(str);
}

function formatAoTime(val) {
  if (!val) return '';
  // 如果是数字（时间戳），格式化为日期字符串
  if (typeof val === 'number' || /^\d{10,13}$/.test(String(val))) {
    const ts = Number(val);
    const d = new Date(ts < 1e12 ? ts * 1000 : ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  // 已经是字符串格式的日期，直接返回
  return esc(String(val));
}

function getAoPauseBadge(status) {
  if (!status) return '';
  let cls = 'ao-badge ';
  if (status === '未处理' || status.includes('暂停')) cls += 'ao-badge-paused';
  else if (status.includes('恢复') || status === '已处理') cls += 'ao-badge-resolved';
  else if (status === '处理中') cls += 'ao-badge-processing';
  else cls += 'ao-badge-paused';
  return `<span class="${cls}">${esc(status)}</span>`;
}

function getAoSourceBadge(source) {
  if (source === '异常中心') return '<span class="ao-source-badge ao-source-bill">异常中心</span>';
  if (source === '异常订单中心') return '<span class="ao-source-badge ao-source-so">异常订单中心</span>';
  return esc(source || '');
}

function renderAoPagination() {
  const totalPages = Math.ceil(aoTotalCount / aoPageSize) || 1;
  $('#aoPageFirst').disabled = aoCurrentPage <= 1;
  $('#aoPagePrev').disabled = aoCurrentPage <= 1;
  $('#aoPageNext').disabled = aoCurrentPage >= totalPages;
  $('#aoPageLast').disabled = aoCurrentPage >= totalPages;

  // 渲染页码按钮
  const numsEl = $('#aoPageNums');
  let pages = [];
  const maxVisible = 5;
  let startPage = Math.max(1, aoCurrentPage - Math.floor(maxVisible / 2));
  let endPage = Math.min(totalPages, startPage + maxVisible - 1);
  if (endPage - startPage < maxVisible - 1) startPage = Math.max(1, endPage - maxVisible + 1);
  for (let i = startPage; i <= endPage; i++) pages.push(i);
  numsEl.innerHTML = pages.map(p =>
    `<span class="ao-page-num${p === aoCurrentPage ? ' active' : ''}" data-page="${p}">${p}</span>`
  ).join('');
  numsEl.querySelectorAll('.ao-page-num').forEach(el => {
    el.addEventListener('click', () => {
      const p = parseInt(el.dataset.page);
      if (p !== aoCurrentPage) { aoCurrentPage = p; handleAoQuery(); }
    });
  });
  updateAoPageInfo();
}

function updateAoDashboard(data) {
  const billExCount = data.billExCount || 0;
  const soExCount = data.soExCount || 0;
  if ($('#aoBillExCount')) $('#aoBillExCount').textContent = billExCount;
  if ($('#aoSoExCount')) $('#aoSoExCount').textContent = soExCount;
  updateAoPageInfo();
}

function updateAoPageInfo() {
  const start = aoTotalCount === 0 ? 0 : (aoCurrentPage - 1) * aoPageSize + 1;
  const end = Math.min(aoCurrentPage * aoPageSize, aoTotalCount);
  $('#aoPageInfo').textContent = `显示 ${start} 至 ${end} 共 ${aoTotalCount} 条`;
}

function addAoLog(type, message) {
  // 日志区已移除，通过 toast 展示关键信息
  if (type === 'error') {
    showToast(message, 4000, 'error');
  } else if (type === 'success') {
    showToast(message, 2000);
  }
  console.log(`[AO ${type}]`, message);
}

// ========== 抓包结果弹窗 ==========

function showCaptureResult(text) {
  const modal = $('#captureResultModal');
  const textarea = $('#captureResultText');
  const title = $('#captureResultTitle');
  if (!modal || !textarea) return;
  title.textContent = '抓包结果';
  textarea.value = text;
  modal.style.display = 'flex';
}

(function initCaptureResultModal() {
  const modal = $('#captureResultModal');
  const closeBtn = $('#captureResultClose');
  const copyBtn = $('#captureResultCopy');
  if (!modal) return;

  if (closeBtn) closeBtn.addEventListener('click', () => { modal.style.display = 'none'; });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });

  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const textarea = $('#captureResultText');
      if (textarea && textarea.value) {
        textarea.select();
        document.execCommand('copy');
        showToast('已复制到剪贴板');
      }
    });
  }
})();

// ========== 打印出库模块 ==========
function initWmsPrintOutbound() {
  const openBtn = $('#wmsPrintOpenBtn');
  const refreshBtn = $('#wmsPrintRefreshBtn');
  const loginBtn = $('#wmsPrintLoginBtn');
  const statusEl = $('#wmsPrintStatus');
  const placeholder = $('#wmsPrintPlaceholder');
  const container = $('#wmsPrintWebviewContainer');

  if (!openBtn) return;

  const WMS_OUTBOUND_URL = 'https://unionwms.jdl.com/default#/app-v/jwms-webview/outbound/orderProcess/orderProcessList';
  let webview = null;
  let webviewLoaded = false;

  // 创建并加载 webview
  async function loadWebview() {
    if (!canUseFeature('wmsPrintOutbound')) {
      statusEl.textContent = '当前版本不支持';
      statusEl.style.color = '#999';
      loginBtn.style.display = 'none';
      placeholder.textContent = '打印出库功能需升级至标准版或高级版后使用';
      placeholder.style.display = 'flex';
      return;
    }
    if (webview) return;

    const result = await window.electronAPI.checkWmsSession();
    if (!result || !result.loggedIn || !result.partition) {
      statusEl.textContent = '未登录 WMS';
      statusEl.style.color = '#999';
      loginBtn.style.display = '';
      placeholder.style.display = 'flex';
      return;
    }

    statusEl.textContent = '已登录 WMS';
    statusEl.style.color = '#27ae60';
    loginBtn.style.display = 'none';
    placeholder.style.display = 'none';

    webview = document.createElement('webview');
    webview.setAttribute('partition', result.partition);
    webview.setAttribute('src', WMS_OUTBOUND_URL);
    webview.style.cssText = 'width:100%; height:100%; border:none;';
    webview.setAttribute('allowpopups', '');
    container.appendChild(webview);

    webview.addEventListener('did-finish-load', () => {
      webviewLoaded = true;
    });
  }

  // 切换到打印出库页面时加载 webview
  const navItem = document.querySelector('.nav-item[data-page="wmsPrintOutbound"]');
  if (navItem) {
    navItem.addEventListener('click', () => {
      loadWebview();
    });
  }

  // 请登录按钮 - 直接弹出 WMS 登录对话框
  loginBtn.addEventListener('click', async (e) => {
    if (!requireTier('wmsPrintOutbound')) return;
    e.preventDefault();
    const cred = await window.electronAPI.getWmsCredentials();
    window.electronAPI.openWmsLogin(cred || {});
  });

  // 刷新按钮
  refreshBtn.addEventListener('click', () => {
    if (webview && webviewLoaded) {
      webview.reload();
    } else {
      if (webview) {
        webview.remove();
        webview = null;
        webviewLoaded = false;
      }
      loadWebview();
    }
  });

  // 新窗口打开按钮
  openBtn.addEventListener('click', async () => {
    if (!requireTier('wmsPrintOutbound')) return;
    const result = await window.electronAPI.openWmsPrintOutbound();
    if (result && !result.success) {
      showToast(result.error || '打开失败');
    }
  });

  // WMS 登录成功后更新状态
  window.electronAPI.onWmsLoginSuccess(() => {
    statusEl.textContent = '已登录 WMS';
    statusEl.style.color = '#27ae60';
    loginBtn.style.display = 'none';
    placeholder.textContent = '点击「刷新」加载出库处理页面';
    const page = document.getElementById('page-wmsPrintOutbound');
    if (page && page.classList.contains('active') && !webview) {
      loadWebview();
    }
  });
}

// ========== 售后联系弹窗 ==========
function initContactModal() {
  const btn = $('#sidebarContact');
  const modal = $('#contactModal');
  const closeBtn = $('#contactModalClose');
  if (!btn || !modal) return;

  btn.addEventListener('click', () => {
    modal.style.display = '';
  });

  // 广告卡片点击
  const adCard = $('#adCard');
  if (adCard) {
    adCard.addEventListener('click', () => {
      window.electronAPI.openExternalDownload('http://150.158.54.108:3001/download/latest');
    });
  }

  closeBtn.addEventListener('click', () => {
    modal.style.display = 'none';
  });

  modal.querySelector('.contact-modal-mask').addEventListener('click', () => {
    modal.style.display = 'none';
  });
}
