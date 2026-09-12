// ========== 全局状态 ==========
let tasks = [];
let taskIdCounter = 0;
let isExecuting = false;
let stopRequested = false;
let labelTaskPersistenceChain = Promise.resolve();
let smAutomaticExecutionPending = false;
let shopOptions = []; // 店铺选项数据（当前事业部过滤后）
let allShopOptions = []; // 全量店铺选项（不受事业部筛选影响）
let importedFileName = ''; // 当前导入的文本文件名（无扩展名）
let currentTier = 'basic'; // 当前订阅版本：basic, standard, premium
let currentSubscriptionStatus = ''; // 当前订阅状态：trial, active, expired...
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
  await loadLabelTasks();
  initNavigation();
  await initMachineCodeModule();
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
      const page = item.dataset.page;
      $$('.nav-item').forEach(n => n.classList.remove('active'));
      item.classList.add('active');

      $$('.page').forEach(p => p.classList.remove('active'));
      $(`#page-${page}`).classList.add('active');
    });
  });
}

// ========== 机器码 ==========
async function initMachineCodeModule() {
  const valueEl = $('#machineCodeValue');
  const copyBtn = $('#machineCodeCopyBtn');
  const emptyStateEl = $('#machineCodeEmptyState');
  const generatedStateEl = $('#machineCodeGeneratedState');
  const generateBtn = $('#machineCodeGenerateBtn');
  const feedbackEl = $('#machineCodeCopyFeedback');
  const transportEl = $('#machineTransportStatus');
  const capabilitySummaryEl = $('#machineCapabilitySummary');
  const capabilityListEl = $('#machineCapabilityList');
  if (!valueEl || !copyBtn || !emptyStateEl || !generatedStateEl || !generateBtn) return;

  let currentMachineCode = '';

  const showPendingState = () => {
    currentMachineCode = '';
    valueEl.textContent = '';
    valueEl.classList.remove('machine-code-value-error');
    emptyStateEl.hidden = false;
    generatedStateEl.hidden = true;
    generateBtn.disabled = false;
    copyBtn.disabled = true;
  };

  const showGeneratedState = machineCode => {
    currentMachineCode = machineCode;
    valueEl.textContent = machineCode;
    valueEl.classList.remove('machine-code-value-error');
    emptyStateEl.hidden = true;
    generatedStateEl.hidden = false;
    copyBtn.disabled = false;
  };

  const renderExecutionStatus = statusResult => {
    if (!statusResult || statusResult.success !== true) {
      transportEl.textContent = '本机执行端不可用';
      transportEl.className = 'status-error';
      capabilitySummaryEl.textContent = statusResult?.error || '状态读取失败';
      capabilitySummaryEl.className = 'status-error';
      capabilityListEl.replaceChildren();
      return;
    }

    const transportEnabled = statusResult.transport?.enabled === true;
    const machineCodeGenerated = statusResult.generated === true;
    const controlPlaneConfigured = statusResult.control_plane?.configured === true;
    const executorAuthenticated = statusResult.control_plane?.authenticated === true;
    transportEl.textContent = statusResult.online === true
      ? '在线，正在等待指令'
      : transportEnabled
      ? '正在连接云仓助手服务'
      : machineCodeGenerated
      ? controlPlaneConfigured && !executorAuthenticated
        ? '云仓助手登录会话不可用'
        : '服务接口尚未启用'
      : '未启用（尚未生成机器码）';
    transportEl.className = statusResult.online === true ? 'status-ok' : 'status-muted';

    const capabilities = Array.isArray(statusResult.capabilities) ? statusResult.capabilities : [];
    const enabledCount = capabilities.filter(item => item.enabled === true).length;
    capabilitySummaryEl.textContent = `${enabledCount}/${capabilities.length} 已启用`;
    capabilitySummaryEl.className = enabledCount > 0 ? 'status-ok' : 'status-muted';

    capabilityListEl.replaceChildren();
    capabilities.forEach(capability => {
      const item = document.createElement('li');
      const command = document.createElement('code');
      const state = document.createElement('span');
      command.textContent = capability.command;
      state.textContent = capability.enabled ? '已启用' : '未接入';
      state.className = capability.enabled ? 'capability-enabled' : 'capability-disabled';
      item.append(command, state);
      capabilityListEl.appendChild(item);
    });
  };

  const machinePageEl = $('#page-machineCode');
  const statusRefresh = window.MachineStatusRefresh.createMachineStatusRefreshController({
    intervalMs: window.MachineStatusRefresh.DEFAULT_REFRESH_INTERVAL_MS,
    getStatus: () => window.electronAPI.getOrderCommandStatus(),
    renderStatus: renderExecutionStatus,
    renderError: error => renderExecutionStatus({
      success: false,
      error: error && error.message ? error.message : '状态读取失败'
    }),
    isActive: () => document.visibilityState !== 'hidden' && machinePageEl.classList.contains('active')
  });
  const syncStatusRefresh = () => {
    statusRefresh.sync();
  };
  $$('.nav-item').forEach(item => item.addEventListener('click', syncStatusRefresh));
  document.addEventListener('visibilitychange', syncStatusRefresh);
  window.addEventListener('beforeunload', () => statusRefresh.dispose(), { once: true });

  const copyMachineCode = async () => {
    if (!currentMachineCode) return;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(currentMachineCode);
      } else {
        const input = document.createElement('textarea');
        input.value = currentMachineCode;
        input.setAttribute('readonly', '');
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        const copied = document.execCommand('copy');
        input.remove();
        if (!copied) throw new Error('系统剪贴板不可用');
      }
      feedbackEl.textContent = '已复制到剪贴板';
      feedbackEl.className = 'machine-code-copy-feedback success';
    } catch (error) {
      feedbackEl.textContent = `复制失败：${error.message}`;
      feedbackEl.className = 'machine-code-copy-feedback error';
    }
  };
  copyBtn.addEventListener('click', copyMachineCode);

  generateBtn.addEventListener('click', async () => {
    generateBtn.disabled = true;
    generateBtn.textContent = '正在生成...';
    feedbackEl.textContent = '正在读取本机主板和系统设备信息，请稍候...';
    feedbackEl.className = 'machine-code-copy-feedback';
    try {
      const machineResult = await window.electronAPI.generateMachineCode();
      if (!machineResult || machineResult.success !== true || !machineResult.machine_code) {
        throw new Error(machineResult?.error || '机器码生成失败');
      }
      showGeneratedState(machineResult.machine_code);
      feedbackEl.textContent = '机器码已生成并安全保存在本机';
      feedbackEl.className = 'machine-code-copy-feedback success';
      await statusRefresh.refreshNow();
    } catch (error) {
      showPendingState();
      feedbackEl.textContent = `生成失败：${error.message}`;
      feedbackEl.className = 'machine-code-copy-feedback error';
    } finally {
      generateBtn.textContent = '生成机器码';
      if (!currentMachineCode) generateBtn.disabled = false;
    }
  });

  try {
    const [machineResult, statusResult] = await Promise.all([
      window.electronAPI.getMachineCode(),
      window.electronAPI.getOrderCommandStatus()
    ]);

    if (!machineResult || machineResult.success !== true) {
      throw new Error(machineResult?.error || '机器码读取失败');
    }
    if (machineResult.generated === true && machineResult.machine_code) {
      showGeneratedState(machineResult.machine_code);
    } else {
      showPendingState();
    }
    renderExecutionStatus(statusResult);
    await statusRefresh.sync();
  } catch (error) {
    showPendingState();
    generateBtn.disabled = true;
    feedbackEl.textContent = error.message;
    feedbackEl.className = 'machine-code-copy-feedback error';
    if (transportEl) transportEl.textContent = '本机执行端不可用';
    if (capabilitySummaryEl) capabilitySummaryEl.textContent = '0/5 已启用';
  }
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
  $('#stopTaskYes').addEventListener('click', async () => {
    stopRequested = true;
    $('#stopTaskModal').style.display = 'none';
    addLog('warn', '正在停止任务并中止当前请求...');
    try {
      const cancelResult = await window.electronAPI.cancelJdLabelRequest();
      if (cancelResult?.aborted) {
        addLog('info', '当前京配请求已中止');
      }
    } catch (_) {
      // 当前步骤不是京配请求时无需额外处理，执行循环仍会在步骤结束后停止。
    }
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
function enqueueLabelTasks({
  skus,
  shopId,
  warehouseId,
  config,
  modeName,
  sourceFileName = '',
  sourceTaskId = '',
  automationRunDate = '',
  autoCreated = false
}) {
  const normalizedSkus = [...new Set((Array.isArray(skus) ? skus : [])
    .map(value => String(value || '').trim())
    .filter(Boolean))];
  if (normalizedSkus.length === 0) {
    return { success: false, error: '没有可发布的SKU', taskCount: 0 };
  }

  const shopOpt = allShopOptions.find(o => o.value === shopId)
    || shopOptions.find(o => o.value === shopId);
  const shopName = shopOpt ? shopOpt.label : '';
  const spShopNo = shopOpt ? shopOpt.spShopNo : '';
  const shopDeptId = shopOpt ? shopOpt.deptId : '';
  const shopDeptName = shopOpt ? shopOpt.deptName : '';
  const taskConfig = config && typeof config === 'object' ? { ...config } : {};

  // 其他步骤（非京配/非采购）是否有勾选
  const hasOtherSteps = taskConfig.importShopProduct || taskConfig.enableShopProduct ||
    taskConfig.enableMasterData || taskConfig.disableMasterData || taskConfig.inventoryRatio ||
    taskConfig.disableShopProduct || taskConfig.logistics;

  // 仅勾选了"打标生效"和/或"取消京配"（无其他步骤，无采购入库）
  const onlyJdSteps = (taskConfig.jdLabel || taskConfig.cancelJdLabel) &&
    !taskConfig.enablePurchase && !hasOtherSteps;

  // 仅勾选了"采购入库"（无其他步骤，无京配相关）
  const onlyPurchase = taskConfig.enablePurchase &&
    !taskConfig.jdLabel && !taskConfig.cancelJdLabel && !hasOtherSteps;

  // 店铺验证：仅京配步骤或仅采购入库时可不选店铺
  if (!shopId && !onlyJdSteps && !onlyPurchase) {
    return { success: false, error: '请选择店铺', taskCount: 0 };
  }
  if (shopId && !shopOpt) {
    return { success: false, error: '目标店铺不存在，请重新选择', taskCount: 0 };
  }

  // 仓库验证：仅京配步骤时可不选仓库
  if (!warehouseId && !onlyJdSteps) {
    return { success: false, error: '请选择仓库', taskCount: 0 };
  }

  // 判断是否仅勾选了京配打标/取消京配打标步骤（用于批大小）
  const batchSize = onlyJdSteps ? 5000 : BATCH_SIZE;

  // 按 batchSize 拆分为多个任务，每个任务独立执行所有步骤
  const taskBatches = [];
  const createdTaskIds = [];
  for (let i = 0; i < normalizedSkus.length; i += batchSize) {
    taskBatches.push(normalizedSkus.slice(i, i + batchSize));
  }

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
      config: { ...taskConfig },
      modeName: modeName || '自定义',
      sourceFileName,
      sourceTaskId,
      automationRunDate,
      autoCreated: Boolean(autoCreated),
      status: 'pending'
    });
    createdTaskIds.push(taskIdCounter);
  }

  renderTaskTable();
  const persistence = persistLabelTasks();
  return {
    success: true,
    taskCount: taskBatches.length,
    skuCount: normalizedSkus.length,
    taskIds: createdTaskIds,
    persistence
  };
}

function toPersistedLabelTask(task) {
  return {
    id: task.id,
    skus: Array.isArray(task.skus) ? task.skus : [],
    shopId: task.shopId || '',
    spShopNo: task.spShopNo || '',
    shopName: task.shopName || '',
    shopDeptId: task.shopDeptId || '',
    shopDeptName: task.shopDeptName || '',
    warehouseId: task.warehouseId || '',
    config: task.config || {},
    modeName: task.modeName || '自定义',
    sourceFileName: task.sourceFileName || '',
    sourceTaskId: task.sourceTaskId || '',
    automationRunDate: task.automationRunDate || '',
    autoCreated: Boolean(task.autoCreated),
    status: task.status || 'pending',
    hasLabelFailure: Boolean(task.hasLabelFailure),
    failedLabelSkus: Array.isArray(task.failedLabelSkus) ? task.failedLabelSkus : []
  };
}

async function loadLabelTasks() {
  if (!window.electronAPI.getLabelTasks) return;
  try {
    const stored = await window.electronAPI.getLabelTasks();
    tasks = (Array.isArray(stored) ? stored : []).map(task => ({ ...task }));
    taskIdCounter = tasks.reduce((max, task) => Math.max(max, Number(task.id) || 0), 0);
    renderTaskTable();
    if (tasks.length > 0) await persistLabelTasks();
  } catch (error) {
    console.error('[打标任务] 恢复失败:', error);
  }
}

function persistLabelTasks() {
  if (!window.electronAPI.saveLabelTasks) return Promise.resolve({ success: false });
  const snapshot = tasks.map(toPersistedLabelTask);
  labelTaskPersistenceChain = labelTaskPersistenceChain
    .catch(() => {})
    .then(() => window.electronAPI.saveLabelTasks(snapshot));
  return labelTaskPersistenceChain;
}

async function confirmEnqueuedLabelTasksPersisted(result) {
  const saved = await result.persistence;
  if (saved?.success) return;
  const createdIds = new Set((result.taskIds || []).map(Number));
  tasks = tasks.filter(task => !createdIds.has(Number(task.id)));
  renderTaskTable();
  await persistLabelTasks();
  throw new Error(saved?.error || '打标任务保存失败');
}

function addTask() {
  const skuText = skuInput.value.trim();
  if (!skuText) {
    showToast('请输入商品SKU');
    skuInput.focus();
    return { success: false, error: '请输入商品SKU' };
  }

  const skus = skuText.split(/[,，]/).map(s => s.trim()).filter(Boolean);
  const result = enqueueLabelTasks({
    skus,
    shopId: shopSelect.value,
    warehouseId: warehouseSelect.value,
    config: getCurrentConfig(),
    modeName: modeSelect.value || '自定义',
    sourceFileName: importedFileName || ''
  });
  if (!result.success) {
    showToast(result.error);
    return result;
  }

  if (result.taskCount > 1) {
    addLog('info', `已添加 ${result.taskCount} 个任务（共${result.skuCount}个SKU）`);
  } else {
    addLog('info', `已添加 1 个任务（${result.skuCount} 个SKU）`);
  }

  // 清空SKU输入和文件名
  skuInput.value = '';
  importedFileName = '';
  return result;
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
    persistLabelTasks();
    addLog('info', `已删除任务 ${idx + 1}`);
  } else if (deleteAction === 'all') {
    const count = tasks.length;
    tasks.length = 0;
    renderTaskTable();
    persistLabelTasks();
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
    await persistLabelTasks();
    await syncSmSourceExecutionStatus(task.sourceTaskId);
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

        if (stopRequested) { stopped = true; break; }

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
    await persistLabelTasks();
    await syncSmSourceExecutionStatus(task.sourceTaskId);
  }

  const executionWasStopped = stopRequested;
  isExecuting = false;
  stopRequested = false;
  execBtn.textContent = '执行任务';
  execBtn.classList.remove('btn-stop');

  if (tasks.some(t => t.status === 'stopped')) {
    addLog('warn', '任务已停止，未完成的任务可再次执行');
  } else {
    addLog('info', '所有任务执行完毕');
  }

  const completedRunDates = [...new Set(pendingTasks
    .map(task => String(task.automationRunDate || ''))
    .filter(Boolean))];
  for (const runDate of completedRunDates) {
    if (executionWasStopped && smAutomationSettings.lastRunDate === runDate) {
      await saveSmAutomationRuntime({
        lastRunStatus: 'paused',
        lastRunError: '用户已停止自动打标任务'
      });
    } else {
      await finalizeSmAutomationRun(runDate);
    }
  }

  if (smAutomaticExecutionPending && executionWasStopped) {
    smAutomaticExecutionPending = false;
    if (smAutomationSettings.lastRunStatus === 'executing') {
      await saveSmAutomationRuntime({
        lastRunStatus: 'paused',
        lastRunError: '用户已停止任务执行'
      });
    }
  } else if (smAutomaticExecutionPending) {
    smAutomaticExecutionPending = false;
    setTimeout(() => executeTasks(), 0);
  }
}

async function syncSmSourceExecutionStatus(sourceTaskId) {
  const normalizedSourceTaskId = String(sourceTaskId || '');
  if (!normalizedSourceTaskId || typeof smTasks === 'undefined') return;
  const sourceTask = smTasks.find(task => String(task.id) === normalizedSourceTaskId);
  if (!sourceTask) return;
  const linkedTasks = tasks.filter(task => String(task.sourceTaskId || '') === normalizedSourceTaskId);
  if (linkedTasks.length === 0) return;
  sourceTask.executionStatus = getSmLinkedExecutionStatus(linkedTasks);
  sourceTask.updatedAt = new Date().toISOString();
  renderSmTaskTable();
  await persistSmTasks();
}

function getSmLinkedExecutionStatus(linkedTasks) {
  const statuses = linkedTasks.map(task => task.status);
  if (statuses.includes('running')) return 'running';
  if (statuses.some(status => status === 'pending' || status === 'stopped')) return 'queued';
  if (statuses.every(status => status === 'success')) return 'success';
  if (statuses.every(status => status === 'error')) return 'failed';
  return 'partial';
}

async function reconcileSmPersistedLabelTaskSources() {
  let changed = false;
  for (const sourceTask of smTasks) {
    const linkedTasks = tasks.filter(task => String(task.sourceTaskId || '') === String(sourceTask.id));
    if (linkedTasks.length === 0) continue;
    sourceTask.publishStatus = 'published';
    sourceTask.publishedTaskCount = linkedTasks.length;
    sourceTask.publishedAt = sourceTask.publishedAt || sourceTask.updatedAt || new Date().toISOString();
    sourceTask.executionStatus = getSmLinkedExecutionStatus(linkedTasks);
    sourceTask.publishError = '';
    sourceTask.updatedAt = new Date().toISOString();
    if (sourceTask.source === 'auto' && sourceTask.params?.dateTo) {
      try {
        await saveSmAutomaticAccountCursor(sourceTask.accountId, sourceTask.params.dateTo);
      } catch (error) {
        sourceTask.publishError = String(error?.message || '店铺增量进度保存失败');
      }
    }
    changed = true;
  }
  if (changed) await persistSmTasks();
  renderSmTaskTable();
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
      if (stopRequested) return;
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
        if (stopRequested) return;
        const batchLabel = batches.length > 1 ? `批次${i + 1}/${batches.length} ` : '';
        let retryOk = false;

        for (let attempt = 0; attempt <= JD_MAX_RETRIES; attempt++) {
          if (stopRequested) return;
          if (attempt > 0) {
            const waitSec = attempt * 15; // 15s, 30s, 45s 递增退避
            addLog('warn', `[${skuLabel}] ${batchLabel}重试第${attempt}次，等待${waitSec}秒...`);
            let elapsed = 0;
            while (elapsed < waitSec * 1000 && !stopRequested) {
              const waitMs = Math.min(200, waitSec * 1000 - elapsed);
              await sleep(waitMs);
              elapsed += waitMs;
            }
            if (stopRequested) return;
          }

          addLog('info', `[${skuLabel}] ${batchLabel}正在调用京配${label}接口 (${batches[i].length}个)...`);
          const result = await window.electronAPI.jdLabelGoods({
            goodArray: batches[i],
            enable
          });

          if (stopRequested || result.cancelled) return;

          if (result.success && result.data && result.data.resultCode === 1) {
            addLog('success', `[${skuLabel}] ${batchLabel}京配${label}成功`);
            jdSuccessCount += batches[i].length;
            retryOk = true;
            break;
          }

          const errMsg = result.error || (result.data && result.data.resultMessage) || '未知错误';
          const isRateLimit = errMsg.includes('频繁') || errMsg.includes('重试');
          const isPermissionErr = errMsg.includes('无权限') || errMsg.includes('无权');
          const isTransientError = result.transient
            || /超时|网络|空响应|页面.*中断|导航|context|frame|destroyed/i.test(errMsg);
          // 频控、权限或暂时性页面/网络错误均重试。
          const shouldRetry = (isRateLimit || isPermissionErr || isTransientError) && attempt < JD_MAX_RETRIES;
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
          let elapsed = 0;
          while (elapsed < JD_BATCH_DELAY && !stopRequested) {
            const waitMs = Math.min(200, JD_BATCH_DELAY - elapsed);
            await sleep(waitMs);
            elapsed += waitMs;
          }
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
let wmsWarehouseNo = '';
let wmsRestoreStatus = '';
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
    let loginAccount = { username, password };
    if (window.electronAPI.saveWmsCredentials) {
      const savedAccount = await window.electronAPI.saveWmsCredentials({ username, password });
      if (savedAccount?.success === false) {
        addWmsLog('error', savedAccount.error || 'WMS 账号保存失败');
        return;
      }
      if (savedAccount?.id) loginAccount = { ...loginAccount, id: savedAccount.id };
      // 刷新下拉账号列表
      if (window.electronAPI.getWmsAccounts) {
        wmsAccountsList = await window.electronAPI.getWmsAccounts() || [];
        if (wmsAccountsList.length > 1 && wmsAccountArrow) {
          wmsAccountArrow.classList.add('visible');
        }
      }
    }
    addWmsLog('info', '正在打开 WMS 登录窗口...');
    const openResult = await window.electronAPI.openWmsLogin(loginAccount);
    if (openResult?.success === false) {
      addWmsLog('error', openResult.error || 'WMS 登录窗口打开失败');
    }
  });

  // 查询按钮
  wmsQueryBtn.addEventListener('click', async () => {
    if (wmsIsProcessing) return;
    if (!wmsLoggedIn && (wmsRestoreStatus === 'network_error' || wmsRestoreStatus === 'service_error')) {
      await checkWmsInitialStatus();
      return;
    }
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
      const warehouseNo = data?.warehouseNo || '';
      wmsRestoreStatus = 'valid';
      updateWmsLoginStatus(true, warehouseName, warehouseNo);
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
function updateWmsLoginStatus(loggedIn, warehouseName, warehouseNo) {
  wmsLoggedIn = loggedIn;
  wmsWarehouseNo = loggedIn ? (warehouseNo || wmsWarehouseNo) : '';

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
    wmsQueryBtn.textContent = '查询待验收单据';
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
    const result = await window.electronAPI.wmsQueryOrders({ warehouseNo: wmsWarehouseNo });

    if (result.success) {
      wmsOrders = result.orders;
      renderWmsOrderTable();
      addWmsLog('success', `查询完成，共 ${result.orders.length} 条单据`);
    } else {
      wmsOrders = [];
      renderWmsOrderTable();
      if (result.failureType === 'auth') {
        wmsRestoreStatus = 'auth_failed';
        updateWmsLoginStatus(false);
        addWmsLog('warn', '保存的登录状态已失效，正在重新登录');
      } else if (result.failureType === 'network' || result.failureType === 'service') {
        addWmsLog('error', `WMS 验证失败，请稍后重试：${result.error}`);
      } else {
        addWmsLog('error', `查询失败: ${result.error}`);
      }
    }
  } catch (err) {
    addWmsLog('error', `查询异常: ${err.message}`);
  } finally {
    wmsIsProcessing = false;
    wmsQueryBtn.disabled = !wmsLoggedIn;
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
    const warehouseNo = wmsWarehouseNo;
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
  if (!window.electronAPI.restoreWmsSession) return;

  wmsRestoreStatus = 'restoring';
  updateWmsLoginStatus(false);
  wmsQueryBtn.textContent = '验证 WMS 中...';
  addWmsLog('info', '正在恢复上次 WMS 登录状态...');
  try {
    const result = await window.electronAPI.restoreWmsSession();
    wmsRestoreStatus = result?.status || '';
    wmsQueryBtn.textContent = '查询待验收单据';
    if (result?.status === 'valid') {
      updateWmsLoginStatus(true, result.warehouseName || '', result.warehouseNo || '');
      addWmsLog('success', 'Cookie 恢复成功');
      wmsOrders = Array.isArray(result.orders) ? result.orders : [];
      renderWmsOrderTable();
      addWmsLog('success', `查询完成，共 ${wmsOrders.length} 条单据`);
      return;
    }

    wmsOrders = [];
    renderWmsOrderTable();
    updateWmsLoginStatus(false);
    if (result?.status === 'auth_failed') {
      addWmsLog('warn', '保存的登录状态已失效，正在重新登录');
    } else if (result?.status === 'network_error' || result?.status === 'service_error') {
      addWmsLog('error', 'WMS 验证失败，请稍后重试');
      wmsQueryBtn.disabled = false;
      wmsQueryBtn.textContent = '重试 WMS 验证';
    } else if (result?.status === 'no_cookie') {
      addWmsLog('info', '未找到保存的 WMS Cookie，请登录 WMS 系统');
    } else if (result?.status === 'no_account') {
      addWmsLog('info', '尚未保存 WMS 账号，请先登录');
    } else if (result?.status === 'warehouse_missing') {
      addWmsLog('warn', '已恢复 WMS 会话，但缺少完整仓库信息，正在重新识别');
    }
  } catch (err) {
    wmsRestoreStatus = 'network_error';
    updateWmsLoginStatus(false);
    addWmsLog('error', `WMS 验证失败，请稍后重试：${err.message}`);
    wmsQueryBtn.disabled = false;
    wmsQueryBtn.textContent = '重试 WMS 验证';
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
    currentSubscriptionStatus = info.status || '';
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
  if (currentSubscriptionStatus === 'trial') return true;
  if (feature === 'shopManage') {
    return !!window.subscriptionAccess?.canUseAutomation({
      status: currentSubscriptionStatus,
      tier: currentTier
    });
  }
  if (!currentTier || currentTier === 'standard' || currentTier === 'premium') return true;
  const allowedFeatures = ['shopLabel', 'acceptance'];
  return allowedFeatures.includes(feature);
}

function requireTier(feature) {
  if (canUseFeature(feature)) return true;
  if (feature === 'shopManage') {
    showToast('快速打标功能需升级至标准版或高级版后使用', 4000, 'error');
    return false;
  }
  showToast('当前为基础版，该功能需升级至标准版或高级版后使用', 4000, 'error');
  return false;
}

// ========== 订阅事件监听 ==========

function initSubscriptionListeners() {
  if (window.electronAPI.onSubscriptionInfo) {
    window.electronAPI.onSubscriptionInfo((info) => {
      if (!info) return;
      currentTier = info.tier || 'basic';
      currentSubscriptionStatus = info.status || '';
      updateSubscriptionBadge(info);
    });
  }

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
      currentSubscriptionStatus = 'expired';
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
      if (text) {
        text.textContent = data.message
          || (data.version ? `正在下载 v${data.version}...` : '正在下载更新...');
      }
      const changelog = document.getElementById('updateDownloadChangelog');
      if (changelog) {
        changelog.textContent = data.changelog || '';
        changelog.style.display = data.changelog ? 'block' : 'none';
      }
      const modal = document.getElementById('updateDownloadModal');
      if (modal) modal.style.display = 'flex';
    });
  }
  if (window.electronAPI.onUpdateDownloadProgress) {
    window.electronAPI.onUpdateDownloadProgress((data) => {
      const bar = document.getElementById('updateDownloadBar');
      const pct = document.getElementById('updateDownloadPct');
      if (bar) bar.style.width = data.percent + '%';
      if (pct) {
        const details = [];
        if (data.mode) details.push(data.mode);
        details.push(Math.round(Number(data.percent) || 0) + '%');
        if (data.bytesPerSecond) {
          const mbps = Number(data.bytesPerSecond) / 1024 / 1024;
          details.push((mbps >= 0.1 ? mbps.toFixed(1) + ' MB/s' : Math.round(Number(data.bytesPerSecond) / 1024) + ' KB/s'));
        }
        if (data.etaSeconds) {
          const seconds = Math.ceil(Number(data.etaSeconds) || 0);
          details.push(seconds < 60 ? `约 ${seconds} 秒` : `约 ${Math.ceil(seconds / 60)} 分钟`);
        }
        pct.textContent = details.join(' · ');
      }
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
let smSelectedShopState = 'empty'; // empty | checking | online | offline | error
let smInlineQueryState = { stage: 'idle', title: '', detail: '', summary: '' };
let smQueryEstimateStartedAt = 0;
let smDateRangePickerController = null;
let smQueryRunning = false;
let smActiveQueryAccountId = '';
let smGoodsSourceAccountId = '';
let smGoodsContextTarget = null;
let smTasks = [];
let smTaskQueueRunning = false;
let smActiveTaskId = '';
let smViewingTaskId = '';
let smTaskRenderTimer = null;
let smTaskPersistenceChain = Promise.resolve();
let smBatchPublishRunning = false;
let smBatchPublishTaskIds = [];
let smAutomationSettings = {
  enabled: false,
  startTime: '02:00',
  catchUpMissed: true,
  scheduleActivatedAt: ''
};
let smAutomationTimer = null;
let smAutomationRunning = false;
let smAutomationCheckPromise = null;
let smAutomationEligibleSince = Date.now();
const SM_AUTOMATION_CHECK_INTERVAL_MS = 30000;
let smEditConfigLoadVersion = 0;
const smSelectedTaskIds = new Set();
const smTaskResultCache = new Map();

// DOM 引用
const smShopSelect = $('#smShopSelect');
const smLogBox = $('#smLogBox');
const smGoodsTableBody = $('#smGoodsTableBody');
const smGoodsCount = $('#smGoodsCount');
const smSelectedCount = $('#smSelectedCount');
const smStatusDot = $('#smStatusTag');
const smShopSelectTrigger = $('#smShopSelectTrigger');
const smShopSelectText = $('#smShopSelectText');
const smShopSelectDropdown = $('#smShopSelectDropdown');
const smShopSelectList = $('#smShopSelectList');
const smGoodsCtxMenu = $('#smGoodsCtxMenu');
const smCtxToggleSelection = $('#smCtxToggleSelection');
const smCtxDelete = $('#smCtxDelete');
const smCreateTaskBtn = $('#smCreateTaskBtn');
const smStartTasksBtn = $('#smStartTasksBtn');
const smGoodsTab = $('#smGoodsTab');
const smTasksTab = $('#smTasksTab');
const smGoodsPanel = $('#smGoodsPanel');
const smTasksPanel = $('#smTasksPanel');
const smTaskTableBody = $('#smTaskTableBody');
const smTaskCount = $('#smTaskCount');
const smProductPanelSummary = $('#smProductPanelSummary');
const smTaskPanelActions = $('#smTaskPanelActions');
const smProductContext = $('#smProductContext');
const smTaskSelectAll = $('#smTaskSelectAll');
const smBatchPublishBtn = $('#smBatchPublishBtn');
const smBatchPublishModal = $('#smBatchPublishModal');
const smBatchPublishRows = $('#smBatchPublishRows');
const smBatchPublishInfo = $('#smBatchPublishInfo');
const smBatchPublishConfirm = $('#smBatchPublishConfirm');
let smShopAccountStateMap = {};
let smShopDropdownCheckVersion = 0;

function setSmResultActionsEnabled(enabled) {
  const shouldEnable = Boolean(enabled) && !smQueryRunning;
  ['smExportBtn', 'smSendBtn', 'smSendDownBtn'].forEach(id => {
    const button = $(`#${id}`);
    if (button) button.disabled = !shouldEnable;
  });
}

function setSmQueryBusy(busy) {
  smQueryRunning = Boolean(busy);
  if (smQueryRunning) closeSmShopSelectDropdown();

  const queryBtn = $('#smQueryBtn');
  if (queryBtn) {
    queryBtn.disabled = smQueryRunning || smBatchPublishRunning || !smLoggedIn;
    queryBtn.textContent = smTaskQueueRunning ? '任务执行中...' : (smQueryRunning ? '查询中...' : '查询商品');
  }
  if (smCreateTaskBtn) {
    smCreateTaskBtn.disabled = smQueryRunning || smBatchPublishRunning || !smShopSelect?.value;
  }
  updateSmTaskActionState();
  if (smShopSelectTrigger) smShopSelectTrigger.disabled = smQueryRunning;
  const manageBtn = $('#smManageBtn');
  if (manageBtn) manageBtn.disabled = smQueryRunning;
  const loginBtn = $('#smLoginBtn');
  if (loginBtn) loginBtn.disabled = smQueryRunning || smSelectedShopState === 'checking';
  setSmResultActionsEnabled(smFilteredGoods.length > 0);
}

function getSmShopStateLabel(state) {
  if (state === 'online') return '在线';
  if (state === 'offline') return '离线';
  if (state === 'checking') return '检测中';
  return '检测失败';
}

function syncSmShopSelectTrigger() {
  if (!smShopSelectText || !smShopSelect) return;
  const selectedOption = smShopSelect.options[smShopSelect.selectedIndex];
  smShopSelectText.textContent = selectedOption?.value
    ? selectedOption.textContent
    : (smShopSelect.options.length > 1 ? '请选择店铺' : '请先添加店铺');
}

function closeSmShopSelectDropdown() {
  smShopDropdownCheckVersion++;
  if (smShopSelectDropdown) smShopSelectDropdown.hidden = true;
  if (smShopSelectTrigger) smShopSelectTrigger.setAttribute('aria-expanded', 'false');
  const wrapper = smShopSelectTrigger?.closest('.sm-shop-inline');
  if (wrapper) wrapper.classList.remove('is-open');
}

function renderSmShopSelectDropdown(accounts, stateMap = smShopAccountStateMap) {
  if (!smShopSelectList) return;
  smShopSelectList.innerHTML = '';
  if (!Array.isArray(accounts) || accounts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sm-shop-select-empty';
    empty.textContent = '暂无店铺，请先添加';
    smShopSelectList.appendChild(empty);
    return;
  }

  for (const account of accounts) {
    const state = stateMap[account.id] || 'checking';
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'sm-shop-select-option';
    option.setAttribute('role', 'option');
    option.dataset.accountId = account.id;
    if (String(smShopSelect.value) === String(account.id)) {
      option.classList.add('is-selected');
      option.setAttribute('aria-selected', 'true');
    }

    const name = document.createElement('span');
    name.className = 'sm-shop-select-option-name';
    name.textContent = account.name || account.username;
    name.title = account.name || account.username;
    const badge = document.createElement('span');
    badge.className = `sm-shop-option-status ${state}`;
    badge.textContent = getSmShopStateLabel(state);
    option.append(name, badge);
    option.addEventListener('click', () => {
      smShopSelect.value = account.id;
      syncSmShopSelectTrigger();
      closeSmShopSelectDropdown();
      smShopSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    smShopSelectList.appendChild(option);
  }
}

async function openSmShopSelectDropdown() {
  if (!smShopSelectDropdown || !smShopSelectTrigger) return;
  const checkVersion = ++smShopDropdownCheckVersion;
  smShopSelectDropdown.hidden = false;
  smShopSelectTrigger.setAttribute('aria-expanded', 'true');
  const wrapper = smShopSelectTrigger.closest('.sm-shop-inline');
  if (wrapper) wrapper.classList.add('is-open');

  const accounts = await window.electronAPI.getShopAccounts();
  if (checkVersion !== smShopDropdownCheckVersion || smShopSelectDropdown.hidden) return;
  renderSmShopSelectDropdown(accounts, smShopAccountStateMap);
  if (!accounts || accounts.length === 0) return;

  try {
    const statusResult = await window.electronAPI.checkShopAccountsStatus();
    if (checkVersion !== smShopDropdownCheckVersion || smShopSelectDropdown.hidden) return;
    const checkedStateMap = statusResult?.stateMap || {};
    smShopAccountStateMap = Object.fromEntries(
      accounts.map(account => [account.id, checkedStateMap[account.id] || 'error'])
    );
    renderSmShopSelectDropdown(accounts, smShopAccountStateMap);
  } catch (error) {
    if (checkVersion !== smShopDropdownCheckVersion || smShopSelectDropdown.hidden) return;
    smShopAccountStateMap = Object.fromEntries(accounts.map(account => [account.id, 'error']));
    renderSmShopSelectDropdown(accounts, smShopAccountStateMap);
  }
}

// 初始化店铺管理模块
async function initSmModule() {
  // 恢复上次运行时使用的筛选条件；首次使用时仍保持“不限”。
  const dateFrom = $('#smDateFrom');
  const dateTo = $('#smDateTo');
  const normalizeSavedDateTime = value => {
    const parsed = window.dateTimeRangePicker?.parseDateTimeValue(value);
    return parsed ? `${parsed.date}T${parsed.time}` : '';
  };
  const restoreSavedDateTime = (input, storageKey) => {
    if (!input) return;
    const savedValue = localStorage.getItem(storageKey) || '';
    const normalizedValue = normalizeSavedDateTime(savedValue);
    input.value = normalizedValue;
    if (savedValue !== normalizedValue) localStorage.setItem(storageKey, normalizedValue);
  };
  restoreSavedDateTime(dateFrom, 'sm_dateFrom');
  restoreSavedDateTime(dateTo, 'sm_dateTo');
  if (window.dateTimeRangePicker?.createDateTimeRangePicker) {
    if (smDateRangePickerController) smDateRangePickerController.destroy();
    smDateRangePickerController = window.dateTimeRangePicker.createDateTimeRangePicker({
      onError: message => showToast(message)
    });
  }
  const priceMin = $('#smPriceMin');
  const priceMax = $('#smPriceMax');
  if (priceMin) priceMin.value = localStorage.getItem('sm_priceMin') || '';
  if (priceMax) priceMax.value = localStorage.getItem('sm_priceMax') || '';

  await loadSmAutomationSettings();
  await loadShopAccounts();
  await loadSmTasks();
  await reconcileSmPersistedLabelTaskSources();
  await loadSmStats();
  initSmEventListeners();
  await checkSmLoginStatus();
  startSmAutomationScheduler();

  // 恢复上次的商品状态和“每个 SPU 取哪些 SKU”选择。
  const savedStatus = localStorage.getItem('sm_goodsStatus');
  if (savedStatus) {
    const normalizedStatus = savedStatus === '在售'
      ? '售卖中'
      : savedStatus === '下架'
        ? '已下架'
        : savedStatus;
    const radio = document.querySelector(`input[name="smGoodsStatus"][value="${normalizedStatus}"]`);
    if (radio) radio.checked = true;
    if (radio && normalizedStatus !== savedStatus) {
      localStorage.setItem('sm_goodsStatus', normalizedStatus);
    }
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
  const savedFirstQtyN = localStorage.getItem('sm_goodsFirstQtyN');
  if (savedFirstQtyN) {
    const firstQtyN = $('#smFirstQtyN');
    if (firstQtyN) firstQtyN.value = savedFirstQtyN;
  }
}

// ========== 店铺账号管理 ==========

function normalizeSmAutomationSettings(value = {}) {
  const startTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value.startTime || ''))
    ? String(value.startTime)
    : '02:00';
  return {
    enabled: Boolean(value.enabled),
    liveConfirmed: Boolean(value.liveConfirmed),
    startTime,
    catchUpMissed: value.catchUpMissed !== false,
    scheduleActivatedAt: String(value.scheduleActivatedAt || ''),
    lastRunDate: String(value.lastRunDate || ''),
    runWindowEnd: String(value.runWindowEnd || ''),
    lastRunStatus: String(value.lastRunStatus || ''),
    lastRunError: String(value.lastRunError || ''),
    lastStartedAt: String(value.lastStartedAt || ''),
    lastFinishedAt: String(value.lastFinishedAt || '')
  };
}

function getSmNextAutomationText(startTime) {
  const [hours, minutes] = String(startTime || '02:00').split(':').map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  let dayLabel = '今天';
  if (next <= now) {
    next.setDate(next.getDate() + 1);
    dayLabel = '明天';
  }
  return `${dayLabel}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function renderSmAutomationStatus(accounts = []) {
  const entry = $('#smAutomationEntry');
  const status = $('#smAutomationStatus');
  const next = $('#smAutomationNext');
  const shopCount = (Array.isArray(accounts) ? accounts : []).filter(account => account.autoSend).length;
  if (entry) entry.classList.toggle('is-on', smAutomationSettings.enabled && smAutomationSettings.liveConfirmed);
  if (status) {
    const runningLabels = {
      collecting: '正在采集',
      publishing: '正在创建任务',
      executing: '正在执行',
      paused: '已暂停',
      partial: '部分失败',
      failed: '执行失败'
    };
    status.textContent = smAutomationSettings.enabled
      ? smAutomationSettings.liveConfirmed
        ? `自动打标：${runningLabels[smAutomationSettings.lastRunStatus] || '已开启'}`
        : '自动打标：待确认'
      : '自动打标：已关闭';
  }
  if (next) {
    next.hidden = !smAutomationSettings.enabled;
    next.textContent = smAutomationSettings.enabled
      ? `· ${smAutomationSettings.startTime} · 下次${getSmNextAutomationText(smAutomationSettings.startTime)}`
      : '';
  }
  const count = $('#smAutomationShopCount');
  if (count) count.textContent = String(shopCount);
}

async function loadSmAutomationSettings() {
  if (!window.electronAPI.getAutoLabelSettings) return;
  const stored = await window.electronAPI.getAutoLabelSettings();
  smAutomationSettings = normalizeSmAutomationSettings(stored);
  renderSmAutomationStatus();
}

function updateSmAutomationSettingsFormState() {
  const enabled = Boolean($('#smAutomationEnabled')?.checked);
  const timeInput = $('#smAutomationStartTime');
  const catchUpInput = $('#smAutomationCatchUp');
  if (timeInput) timeInput.disabled = !enabled;
  if (catchUpInput) catchUpInput.disabled = !enabled;
}

async function openSmAutomationSettings() {
  if (!requireTier('shopManage')) return;
  const enabled = $('#smAutomationEnabled');
  const startTime = $('#smAutomationStartTime');
  const catchUp = $('#smAutomationCatchUp');
  if (enabled) enabled.checked = smAutomationSettings.enabled;
  if (startTime) startTime.value = smAutomationSettings.startTime;
  if (catchUp) catchUp.checked = smAutomationSettings.catchUpMissed;
  updateSmAutomationSettingsFormState();
  const accounts = await window.electronAPI.getShopAccounts();
  renderSmAutomationStatus(accounts);
  const modal = $('#smAutomationSettingsModal');
  if (modal) modal.style.display = 'flex';
}

function closeSmAutomationSettings() {
  const modal = $('#smAutomationSettingsModal');
  if (modal) modal.style.display = 'none';
}

async function saveSmAutomationSettings() {
  if (!requireTier('shopManage')) return;
  const settings = normalizeSmAutomationSettings({
    enabled: $('#smAutomationEnabled')?.checked,
    startTime: $('#smAutomationStartTime')?.value,
    catchUpMissed: $('#smAutomationCatchUp')?.checked
  });
  const result = await window.electronAPI.saveAutoLabelSettings(settings);
  if (!result?.success) {
    showToast(result?.error || '自动打标设置保存失败');
    return;
  }
  const wasEnabled = smAutomationSettings.enabled;
  const previousStartTime = smAutomationSettings.startTime;
  smAutomationSettings = normalizeSmAutomationSettings(result.settings || settings);
  if ((!wasEnabled && smAutomationSettings.enabled)
      || previousStartTime !== smAutomationSettings.startTime) {
    smAutomationEligibleSince = Date.now();
  }
  const accounts = await window.electronAPI.getShopAccounts();
  renderSmAutomationStatus(accounts);
  closeSmAutomationSettings();
  showToast('自动打标设置已保存', 3500);
  checkSmAutomationSchedule();
}

async function saveSmAutomationRuntime(update = {}) {
  if (!window.electronAPI.saveAutoLabelRuntime) return false;
  const result = await window.electronAPI.saveAutoLabelRuntime(update);
  if (!result?.success) {
    console.error('[自动打标] 运行状态保存失败:', result?.error || '未知错误');
    return false;
  }
  smAutomationSettings = normalizeSmAutomationSettings(result.settings || {
    ...smAutomationSettings,
    ...update
  });
  renderSmAutomationStatus(await window.electronAPI.getShopAccounts());
  return true;
}

function formatSmAutomationDateTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function validateSmAutomaticAccount(account, modes, warehouses, windowEnd) {
  const config = account?.autoLabelConfig && typeof account.autoLabelConfig === 'object'
    ? account.autoLabelConfig
    : {};
  const dateFrom = String(config.lastSuccessAt || config.firstRunFrom || '');
  if (!dateFrom) return { success: false, error: '未设置首次采集起点' };
  const fromTime = new Date(dateFrom).getTime();
  const endTime = new Date(windowEnd).getTime();
  if (!Number.isFinite(fromTime) || !Number.isFinite(endTime) || fromTime > endTime) {
    return { success: false, error: '首次采集起点或增量时间范围无效' };
  }
  const priceMin = String(config.priceMin || '').trim();
  const priceMax = String(config.priceMax || '').trim();
  const minValue = priceMin === '' ? null : Number(priceMin);
  const maxValue = priceMax === '' ? null : Number(priceMax);
  if ((minValue != null && (!Number.isFinite(minValue) || minValue < 0))
      || (maxValue != null && (!Number.isFinite(maxValue) || maxValue < 0))
      || (minValue != null && maxValue != null && minValue > maxValue)) {
    return { success: false, error: '售价范围配置无效' };
  }
  const targetMode = (Array.isArray(modes) ? modes : []).find(mode => (
    mode?.name === config.modeName && mode?.config?.jdLabel && !mode?.config?.cancelJdLabel
  ));
  if (!targetMode) return { success: false, error: '快捷模式不存在或不是入仓打标模式' };
  const targetShopId = findSmMatchingTargetShop(account?.name || account?.username || '', config.targetShopId);
  if (!targetShopId) return { success: false, error: '没有匹配到商家端目标店铺' };
  const targetWarehouseId = findSmDefaultWarehouse(account, warehouses);
  if (!targetWarehouseId) return { success: false, error: '未设置可用的默认仓库' };
  return {
    success: true,
    targetMode,
    params: {
      accountId: String(account.id),
      dateFrom,
      dateTo: windowEnd,
      priceMin,
      priceMax,
      goodsStatus: config.goodsStatus || '售卖中'
    },
    qtyMode: config.qtyMode || '全部',
    qtyCount: Math.max(1, Number.parseInt(config.qtyCount, 10) || 10),
    publishConfig: {
      modeName: targetMode.name,
      targetShopId,
      targetWarehouseId
    }
  };
}

async function saveSmAutomaticAccountCursor(accountId, lastSuccessAt) {
  const result = await window.electronAPI.saveShopAutoLabelRuntime({ accountId, lastSuccessAt });
  if (!result?.success) throw new Error(result?.error || '店铺增量进度保存失败');
}

async function createSmAutomaticCollectionTasks(accounts, runDate, windowEnd, modes, warehouses) {
  const api = getSmTaskStateApi();
  if (!api) throw new Error('任务模块未加载');
  const existingAccountIds = new Set(smTasks
    .filter(task => task.source === 'auto' && task.automationRunDate === runDate)
    .map(task => String(task.accountId)));
  const createdTasks = [];

  for (const account of accounts) {
    if (existingAccountIds.has(String(account.id))) continue;
    const persistedCursor = String(account?.autoLabelConfig?.lastSuccessAt || '');
    const taskCursor = smTasks
      .filter(task => task.source === 'auto'
        && String(task.accountId) === String(account.id)
        && task.publishStatus === 'published'
        && task.params?.dateTo)
      .map(task => String(task.params.dateTo))
      .sort()
      .pop() || '';
    const effectiveAccount = {
      ...account,
      autoLabelConfig: {
        ...(account.autoLabelConfig || {}),
        lastSuccessAt: [persistedCursor, taskCursor].filter(Boolean).sort().pop() || ''
      }
    };
    const validation = validateSmAutomaticAccount(effectiveAccount, modes, warehouses, windowEnd);
    const fallbackConfig = account?.autoLabelConfig || {};
    const task = api.createTask({
      accountId: account.id,
      shopName: account.name || account.username || '未命名店铺',
      source: 'auto',
      automationRunDate: runDate,
      params: validation.success ? validation.params : {
        accountId: String(account.id),
        dateFrom: fallbackConfig.lastSuccessAt || fallbackConfig.firstRunFrom || '',
        dateTo: windowEnd,
        priceMin: fallbackConfig.priceMin || '',
        priceMax: fallbackConfig.priceMax || '',
        goodsStatus: fallbackConfig.goodsStatus || '售卖中'
      },
      qtyMode: validation.success ? validation.qtyMode : fallbackConfig.qtyMode,
      qtyCount: validation.success ? validation.qtyCount : fallbackConfig.qtyCount,
      publishConfig: validation.success ? validation.publishConfig : {
        modeName: fallbackConfig.modeName || '',
        targetShopId: fallbackConfig.targetShopId || '',
        targetWarehouseId: account.defaultWarehouseId || ''
      }
    });
    if (!validation.success) {
      task.status = 'failed';
      task.error = `自动配置不完整：${validation.error}`;
      task.progress = { stage: 'error', message: task.error };
    }
    smTasks.push(task);
    createdTasks.push(task);
  }
  await persistSmTasks();
  renderSmTaskTable();
  return createdTasks;
}

async function publishSmAutomaticTasks(tasksForRun, modes) {
  const configuredModes = new Map((Array.isArray(modes) ? modes : []).map(mode => [mode.name, mode]));
  let publishedShops = 0;
  let publishedSkus = 0;
  let failedShops = 0;

  smBatchPublishRunning = true;
  updateSmTaskActionState();
  try {
    for (const task of tasksForRun) {
      if (task.status !== 'complete'
          || task.publishStatus === 'published'
          || task.publishStatus === 'skipped') continue;

      if ((task.resultSkuCount || 0) === 0) {
        task.publishStatus = 'skipped';
        task.publishError = '';
        task.executionStatus = 'not_started';
        task.updatedAt = new Date().toISOString();
        try {
          await saveSmAutomaticAccountCursor(task.accountId, task.params.dateTo);
        } catch (error) {
          task.publishStatus = 'publish_failed';
          task.publishError = String(error?.message || '店铺增量进度保存失败');
          failedShops += 1;
        }
        await persistSmTasks();
        renderSmTaskTable();
        continue;
      }

      task.publishStatus = 'publishing';
      task.publishError = '';
      task.updatedAt = new Date().toISOString();
      await persistSmTasks();
      renderSmTaskTable();

      try {
        const targetMode = configuredModes.get(task.publishConfig?.modeName);
        if (!targetMode?.config?.jdLabel || targetMode?.config?.cancelJdLabel) {
          throw new Error('快捷模式不存在或不是入仓打标模式');
        }
        const resultData = await loadSmTaskResultData(task);
        const skus = [...new Set(resultData.filteredGoods
          .map(item => String(item?.sku || '').trim())
          .filter(Boolean))];
        if (skus.length === 0) throw new Error('该任务没有可发布的SKU');
        const result = enqueueLabelTasks({
          skus,
          shopId: task.publishConfig.targetShopId,
          warehouseId: task.publishConfig.targetWarehouseId,
          config: targetMode.config,
          modeName: targetMode.name,
          sourceFileName: `自动采集-${task.shopName}`,
          sourceTaskId: task.id,
          automationRunDate: task.automationRunDate,
          autoCreated: true
        });
        if (!result.success) throw new Error(result.error || '打标任务创建失败');
        await confirmEnqueuedLabelTasksPersisted(result);
        task.publishStatus = 'published';
        task.executionStatus = 'queued';
        task.publishError = '';
        task.publishedAt = new Date().toISOString();
        task.publishedTaskCount = result.taskCount;
        try {
          await saveSmAutomaticAccountCursor(task.accountId, task.params.dateTo);
        } catch (cursorError) {
          task.publishError = String(cursorError?.message || '店铺增量进度保存失败');
          failedShops += 1;
        }
        publishedShops += 1;
        publishedSkus += result.skuCount;
      } catch (error) {
        task.publishStatus = 'publish_failed';
        task.executionStatus = 'not_started';
        task.publishError = String(error?.message || '打标任务创建失败');
        task.publishedTaskCount = 0;
        failedShops += 1;
      }
      task.updatedAt = new Date().toISOString();
      await persistSmTasks();
      renderSmTaskTable();
    }
  } finally {
    smBatchPublishRunning = false;
    updateSmTaskActionState();
  }

  if (publishedShops > 0) {
    await window.electronAPI.updateSmStats({ shops: publishedShops, skus: publishedSkus });
    await updateSmDashboard();
  }
  return { publishedShops, publishedSkus, failedShops };
}

async function requestSmAutomaticExecution(runDate) {
  const pendingForRun = tasks.some(task => (
    task.autoCreated
    && task.automationRunDate === runDate
    && (task.status === 'pending' || task.status === 'stopped')
  ));
  if (!pendingForRun) return false;
  await saveSmAutomationRuntime({ lastRunStatus: 'executing', lastRunError: '' });
  if (isExecuting) {
    smAutomaticExecutionPending = true;
    addSmLog('info', '打标执行器正在运行，本批自动任务已进入下一轮待执行队列');
    return true;
  }
  await executeTasks();
  return true;
}

async function finalizeSmAutomationRun(runDate) {
  if (!runDate || smAutomationSettings.lastRunDate !== runDate) return false;
  const runTasks = smTasks.filter(task => task.source === 'auto' && task.automationRunDate === runDate);
  if (runTasks.length === 0) return false;
  const linkedLabelTasks = tasks.filter(task => task.autoCreated && task.automationRunDate === runDate);
  if (runTasks.some(task => task.status === 'queued' || task.status === 'collecting'
      || task.publishStatus === 'publishing' || task.executionStatus === 'queued'
      || task.executionStatus === 'running')) return false;
  if (linkedLabelTasks.some(task => task.status === 'pending' || task.status === 'running' || task.status === 'stopped')) {
    return false;
  }

  const successful = runTasks.filter(task => (
    !task.error && !task.publishError
    && (task.publishStatus === 'skipped' || task.executionStatus === 'success')
  )).length;
  const errors = runTasks
    .map(task => task.error || task.publishError)
    .filter(Boolean);
  const status = successful === runTasks.length
    ? 'success'
    : successful > 0
      ? 'partial'
      : 'failed';
  await saveSmAutomationRuntime({
    lastRunStatus: status,
    lastRunError: errors.slice(0, 3).join('；'),
    lastFinishedAt: new Date().toISOString()
  });
  if (status === 'success') {
    showToast(`自动打标批次已完成：${successful} 家店铺`, 5000);
  } else {
    showToast(`自动打标批次${status === 'partial' ? '部分完成' : '执行失败'}，请到任务列表查看`, 6000, 'error');
  }
  return true;
}

async function runSmAutomaticLabelBatch(runDate, options = {}) {
  if (smAutomationRunning || !canUseFeature('shopManage')) return;
  if (smQueryRunning || smTaskQueueRunning || smBatchPublishRunning) return;
  smAutomationRunning = true;
  showSmPanel('tasks');
  try {
    const accounts = (await window.electronAPI.getShopAccounts())
      .filter(account => account?.autoSend);
    renderSmAutomationStatus(accounts);
    if (accounts.length === 0) return;

    const existingRunTasks = smTasks.filter(task => (
      task.source === 'auto' && task.automationRunDate === runDate
    ));
    const windowEnd = options.resume && smAutomationSettings.runWindowEnd
      ? smAutomationSettings.runWindowEnd
      : existingRunTasks[0]?.params?.dateTo || formatSmAutomationDateTime();
    if (!options.resume) {
      const saved = await saveSmAutomationRuntime({
        lastRunDate: runDate,
        runWindowEnd: windowEnd,
        lastRunStatus: 'collecting',
        lastRunError: '',
        lastStartedAt: new Date().toISOString(),
        lastFinishedAt: ''
      });
      if (!saved) throw new Error('无法保存自动打标批次状态');
    }

    const [modes, warehouses] = await Promise.all([
      window.electronAPI.getModes(),
      Promise.resolve(getSmWarehouseOptions())
    ]);
    await createSmAutomaticCollectionTasks(accounts, runDate, windowEnd, modes, warehouses);
    const runTasks = smTasks.filter(task => task.source === 'auto' && task.automationRunDate === runDate);
    const queuedIds = runTasks.filter(task => task.status === 'queued').map(task => task.id);
    if (queuedIds.length > 0) await runSmTaskQueue(queuedIds);

    await saveSmAutomationRuntime({ lastRunStatus: 'publishing', lastRunError: '' });
    const publishResult = await publishSmAutomaticTasks(runTasks, modes);
    const started = await requestSmAutomaticExecution(runDate);
    if (!started) {
      await finalizeSmAutomationRun(runDate);
      if (publishResult.publishedShops === 0 && publishResult.failedShops > 0) {
        addSmLog('error', '自动打标没有创建成功的打标任务，请检查失败店铺配置');
      }
    }
  } catch (error) {
    const message = String(error?.message || '自动打标执行失败');
    await saveSmAutomationRuntime({
      lastRunStatus: 'failed',
      lastRunError: message,
      lastFinishedAt: new Date().toISOString()
    });
    showToast(`自动打标失败：${message}`, 6000, 'error');
  } finally {
    smAutomationRunning = false;
    renderSmTaskTable();
  }
}

async function checkSmAutomationSchedule() {
  if (smAutomationCheckPromise) return smAutomationCheckPromise;
  smAutomationCheckPromise = (async () => {
    if (!smAutomationSettings.enabled || !smAutomationSettings.liveConfirmed
        || !canUseFeature('shopManage') || smAutomationRunning) return;
    const api = getSmTaskStateApi();
    if (!api?.getAutomationDueState) return;
    const now = new Date();
    const runDate = api.getLocalDateKey(now);
    const resumable = smAutomationSettings.lastRunDate === runDate
      && ['collecting', 'publishing', 'executing'].includes(smAutomationSettings.lastRunStatus);
    if (resumable) {
      await runSmAutomaticLabelBatch(runDate, { resume: true });
      return;
    }
    const dueState = api.getAutomationDueState(smAutomationSettings, now, smAutomationEligibleSince);
    if (dueState.due) await runSmAutomaticLabelBatch(dueState.runDate);
  })().finally(() => {
    smAutomationCheckPromise = null;
  });
  return smAutomationCheckPromise;
}

function startSmAutomationScheduler() {
  if (smAutomationTimer) return;
  smAutomationEligibleSince = Date.now();
  smAutomationTimer = setInterval(checkSmAutomationSchedule, SM_AUTOMATION_CHECK_INTERVAL_MS);
  setTimeout(checkSmAutomationSchedule, 1000);
  window.addEventListener('focus', checkSmAutomationSchedule);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkSmAutomationSchedule();
  });
}

async function loadShopAccounts(preferredAccountId) {
  if (!window.electronAPI.getShopAccounts) return;
  const selectedBeforeReload = preferredAccountId == null
    ? String(smShopSelect.value || '')
    : String(preferredAccountId || '');
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
    if (selectedBeforeReload && accounts.some(account => String(account.id) === selectedBeforeReload)) {
      smShopSelect.value = selectedBeforeReload;
    }
  }
  if (!smShopSelect.value) {
    updateSmLoginStatus(false, '', 'empty');
  }
  syncSmShopSelectTrigger();
  renderSmShopSelectDropdown(accounts, smShopAccountStateMap);
  renderSmAutomationStatus(accounts);
}

function initSmEventListeners() {
  if (window.electronAPI.onShopQueryProgress) {
    window.electronAPI.onShopQueryProgress(handleSmQueryProgress);
  }

  // 管理按钮
  const manageBtn = $('#smManageBtn');
  if (manageBtn) manageBtn.addEventListener('click', openSmShopModal);

  if (smShopSelectTrigger) {
    smShopSelectTrigger.addEventListener('click', () => {
      if (smQueryRunning) return;
      if (smShopSelectDropdown?.hidden) {
        openSmShopSelectDropdown();
      } else {
        closeSmShopSelectDropdown();
      }
    });

    document.addEventListener('pointerdown', (event) => {
      const wrapper = smShopSelectTrigger.closest('.sm-shop-inline');
      if (wrapper && !wrapper.contains(event.target)) closeSmShopSelectDropdown();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && smShopSelectDropdown && !smShopSelectDropdown.hidden) {
        closeSmShopSelectDropdown();
        smShopSelectTrigger.focus();
      }
    });
  }

  // 店铺下拉切换时同步状态
  if (smShopSelect) {
    smShopSelect.addEventListener('change', async () => {
      if (smQueryRunning) {
        showToast('商品查询进行中，请等待完成后再切换店铺');
        return;
      }
      const selectedId = smShopSelect.value;
      syncSmShopSelectTrigger();
      if (!selectedId) {
        updateSmLoginStatus(false, '', 'empty');
        return;
      }
      if (!requireTier('shopManage')) {
        smShopSelect.value = '';
        syncSmShopSelectTrigger();
        updateSmLoginStatus(false, '', 'empty');
        return;
      }
      const accounts = await window.electronAPI.getShopAccounts();
      const account = accounts.find(a => String(a.id) === String(selectedId));
      if (!account) {
        updateSmLoginStatus(false, '', 'empty');
        return;
      }

      updateSmLoginStatus(false, '', 'checking');
      addSmLog('info', `正在验证店铺登录状态：${account.name || account.username}...`);
      const result = await window.electronAPI.switchShopAccount(account);
      if (smShopSelect.value !== selectedId) return;

      if (result && result.loggedIn) {
        smShopAccountStateMap[selectedId] = 'online';
        updateSmLoginStatus(true, result.shopName || account.name || account.username || '', 'online');
        addSmLog('success', `店铺登录状态有效：${result.shopName || account.name || account.username}`);
      } else {
        const nextState = result && result.validationError ? 'error' : 'offline';
        smShopAccountStateMap[selectedId] = nextState;
        updateSmLoginStatus(false, '', nextState);
        if (result && result.validationError) {
          addSmLog('error', result.error || '店铺登录状态验证失败，请稍后重试');
        } else {
          addSmLog('info', '保存的店铺登录状态已失效，请重新登录');
        }
      }
    });
  }

  // 登录按钮
  const loginBtn = $('#smLoginBtn');
  if (loginBtn) loginBtn.addEventListener('click', handleSmLogin);

  // 查询按钮
  const queryBtn = $('#smQueryBtn');
  if (queryBtn) queryBtn.addEventListener('click', handleSmQuery);

  if (smCreateTaskBtn) smCreateTaskBtn.addEventListener('click', handleSmCreateTask);
  if (smStartTasksBtn) smStartTasksBtn.addEventListener('click', () => runSmTaskQueue());
  if (smGoodsTab) smGoodsTab.addEventListener('click', () => showSmPanel('goods'));
  if (smTasksTab) smTasksTab.addEventListener('click', () => showSmPanel('tasks'));
  if (smTaskTableBody) {
    smTaskTableBody.addEventListener('click', handleSmTaskTableAction);
    smTaskTableBody.addEventListener('change', handleSmTaskSelectionChange);
  }
  if (smTaskSelectAll) smTaskSelectAll.addEventListener('change', handleSmTaskSelectAll);
  if (smBatchPublishBtn) smBatchPublishBtn.addEventListener('click', openSmBatchPublishModal);
  const batchPublishClose = $('#smBatchPublishClose');
  const batchPublishCancel = $('#smBatchPublishCancel');
  if (batchPublishClose) batchPublishClose.addEventListener('click', closeSmBatchPublishModal);
  if (batchPublishCancel) batchPublishCancel.addEventListener('click', closeSmBatchPublishModal);
  if (smBatchPublishConfirm) smBatchPublishConfirm.addEventListener('click', confirmSmBatchPublish);
  if (smBatchPublishModal) {
    smBatchPublishModal.addEventListener('click', event => {
      if (event.target === smBatchPublishModal && !smBatchPublishRunning) closeSmBatchPublishModal();
    });
  }

  // 导出按钮
  const exportBtn = $('#smExportBtn');
  if (exportBtn) exportBtn.addEventListener('click', handleSmExport);

  // 发送按钮
  const sendBtn = $('#smSendBtn');
  if (sendBtn) sendBtn.addEventListener('click', () => handleSmSend('打标'));

  // 发送到下标按钮
  const sendDownBtn = $('#smSendDownBtn');
  if (sendDownBtn) sendDownBtn.addEventListener('click', () => handleSmSend('下标'));

  // 全选复选框
  const selectAll = $('#smSelectAll');
  if (selectAll && smGoodsTableBody) {
    selectAll.addEventListener('change', () => {
      const checks = smGoodsTableBody.querySelectorAll('.sm-sku-row .sm-goods-check');
      checks.forEach(cb => { cb.checked = selectAll.checked; });
      syncSmSelectionCheckboxes();
    });
    smGoodsTableBody.addEventListener('change', (e) => {
      if (e.target.classList.contains('sm-spu-check')) {
        const row = e.target.closest('.sm-spu-row');
        getSmSkuRowsForGroup(row?.dataset.groupKey).forEach(skuRow => {
          const checkbox = skuRow.querySelector('.sm-goods-check');
          if (checkbox) checkbox.checked = e.target.checked;
        });
      }
      if (e.target.classList.contains('sm-goods-check') || e.target.classList.contains('sm-spu-check')) {
        syncSmSelectionCheckboxes();
      }
    });
    smGoodsTableBody.addEventListener('contextmenu', handleSmGoodsContextMenu);
  }

  if (smCtxToggleSelection) smCtxToggleSelection.addEventListener('click', toggleSmGoodsContextSelection);
  if (smCtxDelete) smCtxDelete.addEventListener('click', deleteSmGoodsContextTarget);
  document.addEventListener('click', hideSmGoodsContextMenu);
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('#smGoodsTableBody') && !e.target.closest('#smGoodsCtxMenu')) {
      hideSmGoodsContextMenu();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideSmGoodsContextMenu();
  });
  window.addEventListener('blur', hideSmGoodsContextMenu);
  window.addEventListener('resize', hideSmGoodsContextMenu);

  // 商品状态选项切换时保存
  document.querySelectorAll('input[name="smGoodsStatus"]').forEach(radio => {
    radio.addEventListener('change', () => { localStorage.setItem('sm_goodsStatus', radio.value); });
  });

  // 上架时间和售价范围随输入持久化，下次启动直接恢复。
  [
    ['smDateFrom', 'sm_dateFrom'],
    ['smDateTo', 'sm_dateTo'],
    ['smPriceMin', 'sm_priceMin'],
    ['smPriceMax', 'sm_priceMax']
  ].forEach(([elementId, storageKey]) => {
    const input = $(`#${elementId}`);
    if (!input) return;
    input.addEventListener('input', () => localStorage.setItem(storageKey, input.value || ''));
    input.addEventListener('change', () => localStorage.setItem(storageKey, input.value || ''));
  });

  // 每个 SPU 的 SKU 取值方式切换时重新过滤并保存。
  document.querySelectorAll('input[name="smGoodsQty"]').forEach(radio => {
    radio.addEventListener('change', () => {
      localStorage.setItem('sm_goodsQty', radio.value);
      if (smGoods.length > 0) applySmQtyFilter();
    });
  });
  const bindSmQtyCountInput = (inputId, mode, storageKey) => {
    const input = $(`#${inputId}`);
    if (!input) return;
    input.addEventListener('input', () => localStorage.setItem(storageKey, input.value));
    input.addEventListener('change', () => {
      localStorage.setItem(storageKey, input.value);
      const radio = document.querySelector(`input[name="smGoodsQty"][value="${mode}"]`);
      if (radio && radio.checked && smGoods.length > 0) applySmQtyFilter();
    });
    input.addEventListener('focus', () => {
      const radio = document.querySelector(`input[name="smGoodsQty"][value="${mode}"]`);
      if (radio) {
        radio.checked = true;
        localStorage.setItem('sm_goodsQty', mode);
        if (smGoods.length > 0) applySmQtyFilter();
      }
    });
  };
  bindSmQtyCountInput('smFirstQtyN', '前N个', 'sm_goodsFirstQtyN');
  bindSmQtyCountInput('smQtyN', 'N个', 'sm_goodsQtyN');

  const automationSettingsBtn = $('#smAutomationSettingsBtn');
  const automationSettingsModal = $('#smAutomationSettingsModal');
  const automationSettingsClose = $('#smAutomationSettingsClose');
  const automationSettingsCancel = $('#smAutomationSettingsCancel');
  const automationSettingsSave = $('#smAutomationSettingsSave');
  const automationEnabled = $('#smAutomationEnabled');
  if (automationSettingsBtn) automationSettingsBtn.addEventListener('click', openSmAutomationSettings);
  if (automationSettingsClose) automationSettingsClose.addEventListener('click', closeSmAutomationSettings);
  if (automationSettingsCancel) automationSettingsCancel.addEventListener('click', closeSmAutomationSettings);
  if (automationSettingsSave) automationSettingsSave.addEventListener('click', saveSmAutomationSettings);
  if (automationEnabled) automationEnabled.addEventListener('change', updateSmAutomationSettingsFormState);
  if (automationSettingsModal) {
    automationSettingsModal.addEventListener('click', event => {
      if (event.target === automationSettingsModal) closeSmAutomationSettings();
    });
  }

  document.querySelectorAll('input[name="smAutoSend"]').forEach(radio => {
    radio.addEventListener('change', toggleSmAutoLabelConfig);
  });
  const autoQtyMode = $('#smAutoQtyMode');
  if (autoQtyMode) autoQtyMode.addEventListener('change', updateSmAutoQtyCountState);

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
      // 登录成功后将后台识别到的真实店铺名称覆盖到账号记录；账号、密码在
      // 打开登录窗口前已经保存，因此顶部“登录店铺”与“添加店铺”共用同一数据源。
      if (data?.shopName && data?.accountId) {
        const accounts = await window.electronAPI.getShopAccounts();
        const account = accounts.find(a => a.id === data.accountId);
        if (account && account.name !== data.shopName) {
          await window.electronAPI.saveShopAccount({ ...account, name: data.shopName });
          addSmLog('info', `已自动获取店铺名称：${data.shopName}`);
        }
      }
      await loadShopAccounts(data?.accountId || undefined);
      if (data?.accountId) smShopAccountStateMap[data.accountId] = 'online';
      updateSmLoginStatus(true, data?.shopName || '', 'online');
      addSmLog('success', `店铺后台登录成功${data?.shopName ? '：' + data.shopName : ''}`);
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
let smShopStatusCheckVersion = 0;

async function openSmShopModal() {
  const checkVersion = ++smShopStatusCheckVersion;
  const modal = $('#smShopModal');
  modal.style.display = 'flex';

  const accounts = await window.electronAPI.getShopAccounts();
  if (checkVersion !== smShopStatusCheckVersion) return;
  const list = $('#smShopList');
  const empty = $('#smShopEmpty');
  const statusRows = new Map();

  if (!accounts || accounts.length === 0) {
    list.style.display = 'none';
    empty.style.display = 'block';
  } else {
    list.style.display = 'flex';
    empty.style.display = 'none';
    list.innerHTML = '';

    accounts.forEach(account => {
      const item = document.createElement('div');
      item.className = 'sm-shop-item';
      item.innerHTML = `
        <div class="sm-shop-item-info">
          <span class="sm-shop-item-name">${escapeHtml(account.name || account.username)}</span>
          <span class="sm-shop-item-user">${escapeHtml(account.username)}</span>
        </div>
        <span class="sm-shop-status checking">检测中</span>
        <div class="sm-shop-item-actions">
          <button class="btn btn-sm btn-primary" data-action="login" disabled>检测中</button>
          <button class="btn btn-primary btn-sm" data-action="edit">编辑</button>
          <button class="btn btn-danger" data-action="delete">删除</button>
        </div>
      `;
      const statusEl = item.querySelector('.sm-shop-status');
      const loginButton = item.querySelector('[data-action="login"]');
      statusRows.set(account.id, { account, statusEl, loginButton });

      loginButton.addEventListener('click', async () => {
        if (!requireTier('shopManage')) return;
        const actionState = loginButton.dataset.state || 'checking';
        if (actionState === 'checking') return;
        closeSmShopModal();
        smShopSelect.value = account.id;
        syncSmShopSelectTrigger();
        await openShopAccountAction(account, actionState === 'online');
      });
      item.querySelector('[data-action="edit"]').addEventListener('click', () => {
        closeSmShopModal();
        openSmEditShop(account);
      });
      item.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        if (!requireTier('shopManage')) return;
        await window.electronAPI.deleteShopAccount(account.id);
        delete smShopAccountStateMap[account.id];
        await loadShopAccounts();
        openSmShopModal();
        addSmLog('info', `已删除店铺：${account.name || account.username}`);
      });
      list.appendChild(item);
    });

    let statusResult;
    try {
      statusResult = await window.electronAPI.checkShopAccountsStatus();
    } catch (error) {
      console.error('[SM] 店铺状态批量检测失败:', error);
      statusResult = { stateMap: {} };
    }
    if (checkVersion !== smShopStatusCheckVersion) return;

    const stateMap = statusResult ? statusResult.stateMap || {} : {};
    smShopAccountStateMap = { ...smShopAccountStateMap, ...stateMap };
    renderSmShopSelectDropdown(accounts, smShopAccountStateMap);
    statusRows.forEach(({ statusEl, loginButton }, accountId) => {
      const state = stateMap[accountId] || 'error';
      const label = state === 'online' ? '在线' : state === 'offline' ? '离线' : '检测失败';
      statusEl.className = `sm-shop-status ${state}`;
      statusEl.textContent = label;
      loginButton.className = `btn btn-sm ${state === 'online' ? 'btn-success-outline' : 'btn-primary'}`;
      loginButton.dataset.state = state;
      loginButton.disabled = false;
      loginButton.textContent = state === 'online' ? '进入后台' : '重新登录';
    });

    const selectedId = smShopSelect ? smShopSelect.value : '';
    const selectedRow = selectedId ? statusRows.get(selectedId) : null;
    const selectedState = selectedId ? stateMap[selectedId] : '';
    if (selectedRow && selectedState === 'online') {
      updateSmLoginStatus(true, selectedRow.account.name || selectedRow.account.username || '', 'online');
    } else if (selectedRow) {
      updateSmLoginStatus(false, '', selectedState === 'error' ? 'error' : 'offline');
    }
  }
}

function closeSmShopModal() {
  smShopStatusCheckVersion++;
  $('#smShopModal').style.display = 'none';
}

// ===== 添加/编辑店铺弹窗 =====
function getSmWarehouseOptions() {
  return Array.from(warehouseSelect?.options || [])
    .filter(option => option.value)
    .map(option => ({ value: String(option.value), label: option.textContent || option.value }));
}

function populateSmDefaultWarehouseSelect(selectedId = '') {
  const select = $('#smDefaultWarehouse');
  if (!select) return;
  const options = getSmWarehouseOptions();
  select.innerHTML = '';
  appendSmPublishSelectOption(select, '', options.length > 0 ? '不设置默认仓库' : '暂无可用仓库');
  options.forEach(option => appendSmPublishSelectOption(select, option.value, option.label));

  const normalizedSelectedId = String(selectedId || '');
  if (normalizedSelectedId && !options.some(option => option.value === normalizedSelectedId)) {
    const unavailable = document.createElement('option');
    unavailable.value = normalizedSelectedId;
    unavailable.textContent = '原默认仓库已不可用（请重新选择）';
    unavailable.disabled = true;
    select.appendChild(unavailable);
  }
  select.value = normalizedSelectedId;
  select.disabled = options.length === 0;
}

function getSmDefaultFirstRunFrom() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}T00:00`;
}

function updateSmAutoQtyCountState() {
  const mode = $('#smAutoQtyMode')?.value || '全部';
  const countInput = $('#smAutoQtyCount');
  if (countInput) countInput.disabled = !['前N个', 'N个'].includes(mode);
}

function toggleSmAutoLabelConfig() {
  const enabled = document.querySelector('input[name="smAutoSend"]:checked')?.value === '1';
  const config = $('#smAutoLabelConfig');
  if (config) config.hidden = !enabled;
  const firstRunFrom = $('#smAutoFirstRunFrom');
  if (enabled && firstRunFrom && !firstRunFrom.value) {
    firstRunFrom.value = getSmDefaultFirstRunFrom();
  }
  updateSmAutoQtyCountState();
}

async function populateSmAutoLabelConfig(account, loadVersion) {
  const config = account?.autoLabelConfig && typeof account.autoLabelConfig === 'object'
    ? account.autoLabelConfig
    : {};
  const firstRunFrom = $('#smAutoFirstRunFrom');
  const priceMin = $('#smAutoPriceMin');
  const priceMax = $('#smAutoPriceMax');
  const goodsStatus = $('#smAutoGoodsStatus');
  const qtyMode = $('#smAutoQtyMode');
  const qtyCount = $('#smAutoQtyCount');
  if (firstRunFrom) firstRunFrom.value = config.firstRunFrom || '';
  if (priceMin) priceMin.value = config.priceMin || '';
  if (priceMax) priceMax.value = config.priceMax || '';
  if (goodsStatus) goodsStatus.value = config.goodsStatus || '售卖中';
  if (qtyMode) qtyMode.value = config.qtyMode || '全部';
  if (qtyCount) qtyCount.value = Math.max(1, Number.parseInt(config.qtyCount, 10) || 10);

  const targetShop = $('#smAutoTargetShop');
  if (targetShop) {
    targetShop.innerHTML = '';
    appendSmPublishSelectOption(targetShop, '', '登录后按店铺名称自动匹配');
    allShopOptions.forEach(option => appendSmPublishSelectOption(targetShop, option.value, option.label));
    targetShop.value = findSmMatchingTargetShop(account?.name || '', config.targetShopId || '');
  }

  const modeSelectEl = $('#smAutoMode');
  if (modeSelectEl) {
    modeSelectEl.innerHTML = '<option value="">正在加载模式...</option>';
    let modes = [];
    try {
      modes = await window.electronAPI.getModes();
    } catch (error) {
      console.warn('自动打标模式加载失败:', error);
    }
    if (loadVersion !== smEditConfigLoadVersion) return;
    const availableModes = (Array.isArray(modes) ? modes : [])
      .filter(mode => mode?.config?.jdLabel && !mode?.config?.cancelJdLabel);
    modeSelectEl.innerHTML = '';
    appendSmPublishSelectOption(modeSelectEl, '', '请选择模式');
    availableModes.forEach(mode => appendSmPublishSelectOption(modeSelectEl, mode.name, mode.name));
    const preferredMode = config.modeName
      || availableModes.find(mode => mode.name === '入仓打标')?.name
      || availableModes[0]?.name
      || '';
    modeSelectEl.value = preferredMode;
  }
  toggleSmAutoLabelConfig();
}

function collectSmAutoLabelConfig() {
  return {
    firstRunFrom: $('#smAutoFirstRunFrom')?.value || '',
    priceMin: $('#smAutoPriceMin')?.value || '',
    priceMax: $('#smAutoPriceMax')?.value || '',
    goodsStatus: $('#smAutoGoodsStatus')?.value || '售卖中',
    qtyMode: $('#smAutoQtyMode')?.value || '全部',
    qtyCount: Math.max(1, Number.parseInt($('#smAutoQtyCount')?.value, 10) || 10),
    modeName: $('#smAutoMode')?.value || '',
    targetShopId: $('#smAutoTargetShop')?.value || ''
  };
}

async function openSmEditShop(account) {
  const loadVersion = ++smEditConfigLoadVersion;
  const modal = $('#smEditShopModal');
  const title = $('#smEditShopTitle');
  const idInput = $('#smEditShopId');
  const nameInput = $('#smShopName');
  const userInput = $('#smShopUsername');
  const pwdInput = $('#smShopPassword');
  const autoSendRadios = document.querySelectorAll('input[name="smAutoSend"]');
  populateSmDefaultWarehouseSelect(account?.defaultWarehouseId || '');

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

  const configLoadPromise = populateSmAutoLabelConfig(account, loadVersion);
  toggleSmAutoLabelConfig();
  modal.style.display = 'flex';
  userInput.focus();
  await configLoadPromise;
}

function closeSmEditShop() {
  smEditConfigLoadVersion++;
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
  const defaultWarehouseId = $('#smDefaultWarehouse')?.value || '';
  const autoLabelConfig = collectSmAutoLabelConfig();

  const result = await window.electronAPI.saveShopAccount({
    id: id || undefined,
    name,
    username,
    password,
    autoSend,
    defaultWarehouseId,
    autoLabelConfig
  });
  if (!result.success) {
    showToast(result.error || '保存失败');
    return;
  }
  if (result.merged) {
    addSmLog('info', `登录账号“${username}”已存在，将更新原店铺并在登录成功后覆盖 Cookie`);
  }
  await loadShopAccounts();

  // 使用主进程返回的确定账号，避免名称相近时取错记录。
  const accounts = result.list || await window.electronAPI.getShopAccounts();
  const account = result.account || accounts.find(a => a.username === username) || accounts[accounts.length - 1];

  addSmLog('info', `正在打开店铺后台登录窗口：${account.name || account.username}...`);
  const loginResult = await window.electronAPI.openShopLogin({
    id: account.id,
    username: account.username,
    password: account.password,
    name: account.name,
    autoSend: account.autoSend,
    defaultWarehouseId: account.defaultWarehouseId,
    autoLabelConfig: account.autoLabelConfig
  });
  if (loginResult?.success === false) {
    showToast(loginResult.error || '店铺登录窗口打开失败');
  }
  // 登录成功后弹窗会由 onShopLoginSuccess 回调自动关闭
}

async function saveSmShop() {
  if (!requireTier('shopManage')) return;
  const id = $('#smEditShopId').value;
  const name = $('#smShopName').value.trim();
  const username = $('#smShopUsername').value.trim();
  const password = $('#smShopPassword').value;
  const autoSend = document.querySelector('input[name="smAutoSend"]:checked')?.value === '1';
  const defaultWarehouseId = $('#smDefaultWarehouse')?.value || '';
  const autoLabelConfig = collectSmAutoLabelConfig();

  if (!username) { showToast('请输入登录账号'); return; }
  if (!password) { showToast('请输入登录密码'); return; }

  const result = await window.electronAPI.saveShopAccount({
    id: id || undefined,
    name,
    username,
    password,
    autoSend,
    defaultWarehouseId,
    autoLabelConfig
  });
  if (result.success) {
    await loadShopAccounts();
    closeSmEditShop();
    addSmLog(
      'success',
      result.merged
        ? `店铺"${name || username}"已存在，已更新原记录`
        : `店铺"${name || username}"已保存`
    );
  } else {
    showToast(result.error || '保存失败');
  }
}

// ========== 店铺登录 ==========

async function openShopAccountAction(account, preferBackend) {
  updateSmLoginStatus(false, '', 'checking');
  const switchResult = await window.electronAPI.switchShopAccount(account);

  if (preferBackend && switchResult && switchResult.loggedIn) {
    updateSmLoginStatus(true, switchResult.shopName || account.name || account.username || '', 'online');
    const openResult = await window.electronAPI.openShopBackend(account.id);
    if (openResult && openResult.success) {
      addSmLog('success', `已进入店铺后台：${account.name || account.username}`);
      return;
    }
    addSmLog('info', openResult?.error || '店铺登录状态已失效，正在重新登录');
  }

  updateSmLoginStatus(false, '', 'offline');
  addSmLog('info', `正在重新登录店铺：${account.name || account.username}...`);
  const loginResult = await window.electronAPI.openShopLogin({
    id: account.id,
    username: account.username,
    password: account.password,
    name: account.name,
    autoSend: account.autoSend
  });
  if (loginResult?.success === false) {
    updateSmLoginStatus(false, '', 'offline');
    addSmLog('error', loginResult.error || '店铺登录窗口打开失败');
  }
}

async function handleSmLogin() {
  if (!requireTier('shopManage')) return;
  const selectedId = smShopSelect.value;
  if (!selectedId) {
    // 与店铺管理中的“添加店铺”共用同一流程：先录入账号密码，登录成功后
    // 自动保存实际店铺名称，并出现在店铺选择和账号管理列表中。
    openSmEditShop(null);
    return;
  }

  const accounts = await window.electronAPI.getShopAccounts();
  const account = accounts.find(a => a.id === selectedId);
  if (!account) {
    showToast('店铺账号不存在');
    return;
  }

  await openShopAccountAction(account, smSelectedShopState === 'online');
}

function updateSmLoginStatus(loggedIn, shopName, state) {
  smLoggedIn = loggedIn;
  smSelectedShopState = state || (loggedIn ? 'online' : (smShopSelect.value ? 'offline' : 'empty'));
  const loginBtn = $('#smLoginBtn');

  if (loginBtn) {
    if (smSelectedShopState === 'empty') {
      loginBtn.textContent = '登录店铺';
      loginBtn.disabled = smQueryRunning;
    } else if (smSelectedShopState === 'checking') {
      loginBtn.textContent = '检测中...';
      loginBtn.disabled = true;
    } else if (smSelectedShopState === 'online') {
      loginBtn.textContent = '进入后台';
      loginBtn.disabled = smQueryRunning;
    } else {
      loginBtn.textContent = '重新登录';
      loginBtn.disabled = smQueryRunning;
    }
  }

  const visualState = loggedIn
    ? 'online'
    : ['offline', 'checking', 'error'].includes(smSelectedShopState)
      ? smSelectedShopState
      : 'offline';
  if (smShopSelect.value && smSelectedShopState !== 'empty') {
    smShopAccountStateMap[smShopSelect.value] = visualState;
  }
  syncSmShopSelectTrigger();

  if (loggedIn) {
    smStatusDot.className = `sm-shop-status-inline ${visualState}`;
    smStatusDot.textContent = getSmShopStateLabel(visualState);
    const queryBtn = $('#smQueryBtn');
    if (queryBtn) queryBtn.disabled = smQueryRunning || smBatchPublishRunning;
  } else {
    smStatusDot.className = `sm-shop-status-inline ${visualState}`;
    smStatusDot.textContent = smSelectedShopState === 'empty'
      ? '未选择'
      : getSmShopStateLabel(visualState);
    const queryBtn = $('#smQueryBtn');
    if (queryBtn) queryBtn.disabled = true;
  }
  if (smCreateTaskBtn) {
    smCreateTaskBtn.disabled = smQueryRunning || smBatchPublishRunning || !smShopSelect.value;
  }
}

async function checkSmLoginStatus() {
  if (window.electronAPI.getShopLoginStatus) {
    const status = await window.electronAPI.getShopLoginStatus();
    if (status && status.activeAccountId) {
      const optionExists = Array.from(smShopSelect.options)
        .some(option => option.value === String(status.activeAccountId));
      if (optionExists) smShopSelect.value = String(status.activeAccountId);
    }
    syncSmShopSelectTrigger();
    if (status && status.loggedIn) {
      updateSmLoginStatus(true, status.shopName, 'online');
      addSmLog('info', '已恢复店铺登录状态' + (status.shopName ? '：' + status.shopName : ''));
    } else {
      updateSmLoginStatus(false, '', smShopSelect.value ? 'offline' : 'empty');
    }
  }
}

function getSmTaskStateApi() {
  return window.shopGoodsTaskState || null;
}

function showSmPanel(panelName) {
  const showTasks = panelName === 'tasks';
  if (smGoodsPanel) smGoodsPanel.hidden = showTasks;
  if (smTasksPanel) smTasksPanel.hidden = !showTasks;
  if (smProductPanelSummary) smProductPanelSummary.hidden = showTasks;
  if (smTaskPanelActions) smTaskPanelActions.hidden = !showTasks;
  if (smGoodsTab) {
    smGoodsTab.classList.toggle('is-active', !showTasks);
    smGoodsTab.setAttribute('aria-selected', String(!showTasks));
  }
  if (smTasksTab) {
    smTasksTab.classList.toggle('is-active', showTasks);
    smTasksTab.setAttribute('aria-selected', String(showTasks));
  }
  if (showTasks) {
    if (smProductContext) smProductContext.hidden = true;
    renderSmTaskTable();
  } else {
    updateSmProductPanelContext();
  }
}

function updateSmProductPanelContext() {
  const task = smViewingTaskId
    ? smTasks.find(item => item.id === smViewingTaskId)
    : null;
  if (smProductContext) {
    smProductContext.textContent = task ? `当前结果：${task.shopName}` : '';
    smProductContext.hidden = !task;
  }
}

async function loadSmTasks() {
  const api = getSmTaskStateApi();
  if (!api || !window.electronAPI.getShopGoodsTasks) return;
  try {
    const storedTasks = await window.electronAPI.getShopGoodsTasks();
    smTasks = api.normalizeTasks(storedTasks);
    renderSmTaskTable();
    if (smTasks.some(task => task.status === 'queued')) await persistSmTasks();
  } catch (error) {
    console.error('[SM任务] 任务列表加载失败:', error);
    smTasks = [];
    renderSmTaskTable();
  }
}

function persistSmTasks() {
  const api = getSmTaskStateApi();
  if (!api || !window.electronAPI.saveShopGoodsTasks) return Promise.resolve({ success: false });
  const snapshot = smTasks.map(task => api.toPersistedTask(task));
  smTaskPersistenceChain = smTaskPersistenceChain
    .catch(() => {})
    .then(() => window.electronAPI.saveShopGoodsTasks(snapshot));
  return smTaskPersistenceChain;
}

function updateSmTaskActionState() {
  const hasQueuedTask = smTasks.some(task => task.status === 'queued');
  if (smStartTasksBtn) {
    smStartTasksBtn.disabled = smQueryRunning || smTaskQueueRunning || smBatchPublishRunning || !hasQueuedTask;
    smStartTasksBtn.textContent = smTaskQueueRunning ? '正在采集...' : '开始采集';
  }
  if (smCreateTaskBtn) {
    smCreateTaskBtn.disabled = smQueryRunning || smBatchPublishRunning || !smShopSelect?.value;
  }

  const eligibleTasks = smTasks.filter(task =>
    task.status === 'complete'
    && task.publishStatus !== 'published'
    && task.publishStatus !== 'publishing'
  );
  const eligibleIds = new Set(eligibleTasks.map(task => task.id));
  [...smSelectedTaskIds].forEach(taskId => {
    if (!eligibleIds.has(taskId)) smSelectedTaskIds.delete(taskId);
  });
  const selectedCount = eligibleTasks.filter(task => smSelectedTaskIds.has(task.id)).length;
  if (smTaskSelectAll) {
    smTaskSelectAll.disabled = smTaskQueueRunning || smBatchPublishRunning || eligibleTasks.length === 0;
    smTaskSelectAll.checked = eligibleTasks.length > 0 && selectedCount === eligibleTasks.length;
    smTaskSelectAll.indeterminate = selectedCount > 0 && selectedCount < eligibleTasks.length;
  }
  if (smBatchPublishBtn) {
    smBatchPublishBtn.disabled = smTaskQueueRunning || smBatchPublishRunning || selectedCount === 0;
    smBatchPublishBtn.textContent = smBatchPublishRunning ? '正在发布...' : '批量打标';
  }
}

function scheduleSmTaskTableRender() {
  if (smTaskRenderTimer) return;
  smTaskRenderTimer = setTimeout(() => {
    smTaskRenderTimer = null;
    renderSmTaskTable();
  }, 120);
}

function renderSmTaskTable() {
  const api = getSmTaskStateApi();
  if (!smTaskTableBody || !api) return;
  if (smTaskCount) smTaskCount.textContent = String(smTasks.length);
  updateSmTaskActionState();

  if (smTasks.length === 0) {
    smTaskTableBody.innerHTML = `
      <tr class="wms-empty-row sm-task-empty-row">
        <td colspan="8" class="wms-empty-state sm-task-empty-state">
          <strong>还没有采集任务</strong>
          <span>设置店铺和筛选条件后，点击“创建任务”</span>
        </td>
      </tr>`;
    return;
  }

  smTaskTableBody.innerHTML = smTasks.map((task, index) => {
    const statusLabel = api.getStatusLabel(task.status);
    const progressText = api.getProgressText(task);
    const publishLabel = api.getPublishStatusLabel(task);
    const publishDetail = api.getPublishDetail(task);
    const publishStatusClass = task.executionStatus && task.executionStatus !== 'not_started'
      ? `execution-${task.executionStatus}`
      : task.publishStatus || 'unpublished';
    const sourceBadge = task.source === 'auto'
      ? '<span class="sm-task-source-badge">自动</span>'
      : '';
    const isPublishEligible = task.status === 'complete'
      && task.publishStatus !== 'published'
      && task.publishStatus !== 'publishing';
    const selectionDisabled = smTaskQueueRunning || smBatchPublishRunning || !isPublishEligible
      ? ' disabled'
      : '';
    const disabled = smTaskQueueRunning || smBatchPublishRunning || task.status === 'collecting'
      ? ' disabled'
      : '';
    let primaryAction = '';
    if (task.status === 'complete') {
      primaryAction = `<button type="button" class="sm-task-action" data-task-action="view" data-task-id="${escapeHtml(task.id)}"${disabled}>查看商品</button>`;
    } else if (task.status === 'failed') {
      primaryAction = `<button type="button" class="sm-task-action" data-task-action="retry" data-task-id="${escapeHtml(task.id)}"${disabled}>重试</button>`;
    } else if (task.status === 'queued') {
      primaryAction = `<button type="button" class="sm-task-action" data-task-action="run" data-task-id="${escapeHtml(task.id)}"${disabled}>开始</button>`;
    }
    const republishAction = task.publishStatus === 'published'
      ? `<button type="button" class="sm-task-action" data-task-action="republish" data-task-id="${escapeHtml(task.id)}"${disabled}>再次发布</button>`
      : '';
    return `
      <tr data-task-id="${escapeHtml(task.id)}">
        <td><input type="checkbox" class="sm-task-select" data-task-id="${escapeHtml(task.id)}"
                   aria-label="选择${escapeHtml(task.shopName)}发布打标"
                   ${smSelectedTaskIds.has(task.id) ? 'checked' : ''}${selectionDisabled} /></td>
        <td>${index + 1}</td>
        <td><div class="sm-task-shop-name" title="${escapeHtml(task.shopName)}">${escapeHtml(task.shopName)}${sourceBadge}</div></td>
        <td><div class="sm-task-time" title="${escapeHtml(api.formatTimeRange(task))}">${escapeHtml(api.formatTimeRange(task))}</div></td>
        <td><div class="sm-task-config" title="${escapeHtml(api.formatConfiguration(task))}">${escapeHtml(api.formatConfiguration(task))}</div></td>
        <td>
          <div class="sm-task-progress">
            <span class="sm-task-status is-${escapeHtml(task.status)}">${escapeHtml(statusLabel)}</span>
            <span class="sm-task-progress-detail" title="${escapeHtml(progressText)}">${escapeHtml(progressText)}</span>
          </div>
        </td>
        <td>
          <div class="sm-task-progress">
            <span class="sm-task-status is-${escapeHtml(publishStatusClass)}">${escapeHtml(publishLabel)}</span>
            <span class="sm-task-progress-detail" title="${escapeHtml(publishDetail)}">${escapeHtml(publishDetail)}</span>
          </div>
        </td>
        <td>
          <div class="sm-task-operations">
            ${primaryAction}
            ${republishAction}
            <button type="button" class="sm-task-action is-danger" data-task-action="delete"
                    data-task-id="${escapeHtml(task.id)}"${disabled}>删除</button>
          </div>
        </td>
      </tr>`;
  }).join('');
}

function handleSmTaskSelectionChange(event) {
  const checkbox = event.target.closest('.sm-task-select');
  if (!checkbox) return;
  const taskId = String(checkbox.dataset.taskId || '');
  if (checkbox.checked) smSelectedTaskIds.add(taskId);
  else smSelectedTaskIds.delete(taskId);
  updateSmTaskActionState();
}

function handleSmTaskSelectAll() {
  const checked = Boolean(smTaskSelectAll?.checked);
  smTasks.forEach(task => {
    const eligible = task.status === 'complete'
      && task.publishStatus !== 'published'
      && task.publishStatus !== 'publishing';
    if (!eligible) return;
    if (checked) smSelectedTaskIds.add(task.id);
    else smSelectedTaskIds.delete(task.id);
  });
  smTaskTableBody.querySelectorAll('.sm-task-select:not(:disabled)').forEach(checkbox => {
    checkbox.checked = checked;
  });
  updateSmTaskActionState();
}

function closeSmBatchPublishModal() {
  if (smBatchPublishRunning) return;
  if (smBatchPublishModal) smBatchPublishModal.style.display = 'none';
  smBatchPublishTaskIds = [];
}

function appendSmPublishSelectOption(select, value, label) {
  const option = document.createElement('option');
  option.value = String(value || '');
  option.textContent = String(label || '');
  select.appendChild(option);
}

function normalizeSmShopMatchName(value) {
  const api = getSmTaskStateApi();
  if (api?.normalizeShopMatchName) return api.normalizeShopMatchName(value);
  return String(value || '')
    .replace(/[（(][^）)]*[）)]\s*$/, '')
    .replace(/[\s\-—_]/g, '')
    .toLowerCase();
}

function findSmMatchingTargetShop(sourceName, preferredId = '') {
  const normalizedPreferredId = String(preferredId || '');
  if (normalizedPreferredId && allShopOptions.some(option => String(option.value) === normalizedPreferredId)) {
    return normalizedPreferredId;
  }
  const api = getSmTaskStateApi();
  if (api?.findMatchingShopValue) {
    return api.findMatchingShopValue(sourceName, allShopOptions);
  }
  const sourceNameNormalized = normalizeSmShopMatchName(sourceName);
  const exact = allShopOptions.find(option =>
    normalizeSmShopMatchName(option.label) === sourceNameNormalized
  );
  return exact?.value || '';
}

function findSmDefaultTargetShop(task) {
  return findSmMatchingTargetShop(task.shopName, task.publishConfig?.targetShopId);
}

function findSmDefaultWarehouse(account, warehouses, preferredId = '') {
  const api = getSmTaskStateApi();
  if (api?.resolveWarehouseValue) {
    return api.resolveWarehouseValue({
      preferredId,
      defaultId: account?.defaultWarehouseId,
      options: warehouses
    });
  }
  const availableIds = warehouses.map(option => String(option.value || '')).filter(Boolean);
  if (preferredId && availableIds.includes(String(preferredId))) return String(preferredId);
  if (account?.defaultWarehouseId && availableIds.includes(String(account.defaultWarehouseId))) {
    return String(account.defaultWarehouseId);
  }
  return availableIds.length === 1 ? availableIds[0] : '';
}

async function openSmBatchPublishModal() {
  if (!requireTier('shopManage')) return;
  if (smBatchPublishRunning || smTaskQueueRunning) {
    showToast('请等待当前任务完成');
    return;
  }
  const selectedTasks = smTasks.filter(task =>
    smSelectedTaskIds.has(task.id)
    && task.status === 'complete'
    && task.publishStatus !== 'published'
    && task.publishStatus !== 'publishing'
  );
  if (selectedTasks.length === 0) {
    showToast('请先勾选采集完成的店铺任务');
    return;
  }

  const modes = await window.electronAPI.getModes();
  const availableModes = (Array.isArray(modes) ? modes : [])
    .filter(mode => mode?.config?.jdLabel && !mode?.config?.cancelJdLabel);
  if (availableModes.length === 0) {
    showToast('没有可用的快捷模式，请先在店铺打标中创建模式');
    return;
  }
  if (allShopOptions.length === 0) {
    showToast('没有可用的商家端目标店铺');
    return;
  }
  const warehouses = getSmWarehouseOptions();
  if (warehouses.length === 0) {
    showToast('没有可用的目标仓库');
    return;
  }

  const defaultMode = availableModes.find(mode => mode.name === '入仓打标')
    || availableModes[0];
  const sourceAccounts = await window.electronAPI.getShopAccounts();
  const sourceAccountMap = new Map(
    (Array.isArray(sourceAccounts) ? sourceAccounts : [])
      .map(account => [String(account.id), account])
  );
  smBatchPublishTaskIds = selectedTasks.map(task => task.id);
  smBatchPublishRows.innerHTML = '';

  selectedTasks.forEach(task => {
    const row = document.createElement('tr');
    row.dataset.taskId = task.id;
    row.innerHTML = `
      <td><div class="sm-batch-source-name" title="${escapeHtml(task.shopName)}">${escapeHtml(task.shopName)}</div></td>
      <td>${task.resultSkuCount || 0}</td>
      <td><select class="sm-batch-mode" aria-label="${escapeHtml(task.shopName)}快捷模式"></select></td>
      <td><select class="sm-batch-shop" aria-label="${escapeHtml(task.shopName)}目标店铺"></select></td>
      <td><select class="sm-batch-warehouse" aria-label="${escapeHtml(task.shopName)}目标仓库"></select></td>`;
    const modeSelectEl = row.querySelector('.sm-batch-mode');
    const shopSelectEl = row.querySelector('.sm-batch-shop');
    const warehouseSelectEl = row.querySelector('.sm-batch-warehouse');
    appendSmPublishSelectOption(modeSelectEl, '', '请选择模式');
    availableModes.forEach(mode => appendSmPublishSelectOption(modeSelectEl, mode.name, mode.name));
    appendSmPublishSelectOption(shopSelectEl, '', '请选择目标店铺');
    allShopOptions.forEach(option => appendSmPublishSelectOption(shopSelectEl, option.value, option.label));
    appendSmPublishSelectOption(warehouseSelectEl, '', '请选择目标仓库');
    warehouses.forEach(option => appendSmPublishSelectOption(warehouseSelectEl, option.value, option.label));

    modeSelectEl.value = task.publishConfig?.modeName || defaultMode?.name || '';
    shopSelectEl.value = findSmDefaultTargetShop(task);
    warehouseSelectEl.value = findSmDefaultWarehouse(
      sourceAccountMap.get(String(task.accountId)),
      warehouses,
      task.publishConfig?.targetWarehouseId
    );
    [modeSelectEl, shopSelectEl, warehouseSelectEl].forEach(select => {
      select.addEventListener('change', () => select.classList.remove('is-invalid'));
    });
    smBatchPublishRows.appendChild(row);
  });

  if (smBatchPublishInfo) {
    smBatchPublishInfo.textContent = `已选择 ${selectedTasks.length} 个店铺任务。每家配置独立，确认后按顺序逐个创建打标任务。`;
  }
  if (smBatchPublishModal) smBatchPublishModal.style.display = 'flex';
}

async function loadSmTaskResultData(task) {
  const cached = smTaskResultCache.get(task.id);
  if (cached) return cached;
  if (!window.electronAPI.getShopGoodsTaskResult) {
    throw new Error('当前版本不支持读取任务商品结果');
  }
  const storedResult = await window.electronAPI.getShopGoodsTaskResult(task.id);
  if (!storedResult?.success) {
    throw new Error(storedResult?.error || '没有找到该任务的商品结果');
  }
  const result = {
    rawGoods: Array.isArray(storedResult.rawGoods) ? storedResult.rawGoods : [],
    filteredGoods: Array.isArray(storedResult.filteredGoods) ? storedResult.filteredGoods : []
  };
  smTaskResultCache.set(task.id, result);
  return result;
}

async function confirmSmBatchPublish() {
  if (!requireTier('shopManage') || smBatchPublishRunning) return;
  const rows = Array.from(smBatchPublishRows?.querySelectorAll('tr[data-task-id]') || []);
  const expectedTaskIds = new Set(smBatchPublishTaskIds.map(String));
  if (rows.length === 0 || rows.length !== expectedTaskIds.size
    || rows.some(row => !expectedTaskIds.has(String(row.dataset.taskId)))) {
    showToast('待发布任务已发生变化，请重新选择');
    closeSmBatchPublishModal();
    return;
  }
  const modes = await window.electronAPI.getModes();
  const availableModes = (Array.isArray(modes) ? modes : [])
    .filter(mode => mode?.config?.jdLabel && !mode?.config?.cancelJdLabel);
  const configuredTasks = [];
  let firstInvalid = null;

  rows.forEach(row => {
    const task = smTasks.find(item => item.id === row.dataset.taskId);
    if (!task || task.status !== 'complete'
      || task.publishStatus === 'published'
      || task.publishStatus === 'publishing') {
      if (!firstInvalid) firstInvalid = row;
      return;
    }
    const modeSelectEl = row.querySelector('.sm-batch-mode');
    const shopSelectEl = row.querySelector('.sm-batch-shop');
    const warehouseSelectEl = row.querySelector('.sm-batch-warehouse');
    [modeSelectEl, shopSelectEl, warehouseSelectEl].forEach(select => {
      const invalid = !select.value;
      select.classList.toggle('is-invalid', invalid);
      if (invalid && !firstInvalid) firstInvalid = select;
    });
    const targetMode = availableModes.find(mode => mode.name === modeSelectEl.value);
    if (modeSelectEl.value && !targetMode) {
      modeSelectEl.classList.add('is-invalid');
      if (!firstInvalid) firstInvalid = modeSelectEl;
    }
    if (!modeSelectEl.value || !shopSelectEl.value || !warehouseSelectEl.value || !targetMode) return;
    task.publishConfig = {
      modeName: modeSelectEl.value,
      targetShopId: shopSelectEl.value,
      targetWarehouseId: warehouseSelectEl.value
    };
    configuredTasks.push({ task, targetMode });
  });

  if (firstInvalid || configuredTasks.length !== rows.length) {
    const taskChanged = firstInvalid instanceof HTMLTableRowElement;
    showToast(taskChanged
      ? '待发布任务状态已发生变化，请重新选择'
      : '请为每个店铺完整选择模式、目标店铺和仓库');
    if (taskChanged) {
      closeSmBatchPublishModal();
    } else {
      firstInvalid?.focus();
    }
    return;
  }

  if (smBatchPublishModal) smBatchPublishModal.style.display = 'none';
  await publishSmLabelTasksSequentially(configuredTasks);
}

async function publishSmLabelTasksSequentially(configuredTasks) {
  if (smBatchPublishRunning) return;
  smBatchPublishRunning = true;
  updateSmTaskActionState();
  renderSmTaskTable();
  let successCount = 0;
  let failedCount = 0;
  let successSkuCount = 0;

  try {
    for (const { task, targetMode } of configuredTasks) {
      task.publishStatus = 'publishing';
      task.publishError = '';
      task.updatedAt = new Date().toISOString();
      renderSmTaskTable();
      await persistSmTasks();

      try {
        const resultData = await loadSmTaskResultData(task);
        const skus = [...new Set(resultData.filteredGoods
          .map(item => String(item?.sku || '').trim())
          .filter(Boolean))];
        if (skus.length === 0) throw new Error('该任务没有可发布的SKU');
        const result = enqueueLabelTasks({
          skus,
          shopId: task.publishConfig.targetShopId,
          warehouseId: task.publishConfig.targetWarehouseId,
          config: targetMode.config,
          modeName: targetMode.name,
          sourceFileName: `采集任务-${task.shopName}`,
          sourceTaskId: task.id
        });
        if (!result.success) throw new Error(result.error || '打标任务创建失败');
        await confirmEnqueuedLabelTasksPersisted(result);

        task.publishStatus = 'published';
        task.executionStatus = 'queued';
        task.publishError = '';
        task.publishedAt = new Date().toISOString();
        task.publishedTaskCount = result.taskCount;
        successCount += 1;
        successSkuCount += result.skuCount;
        smSelectedTaskIds.delete(task.id);
      } catch (error) {
        task.publishStatus = 'publish_failed';
        task.publishError = String(error?.message || '打标任务创建失败');
        task.publishedTaskCount = 0;
        failedCount += 1;
      }
      task.updatedAt = new Date().toISOString();
      renderSmTaskTable();
      await persistSmTasks();
    }
  } finally {
    smBatchPublishRunning = false;
    smBatchPublishTaskIds = [];
    if (successCount > 0) {
      await window.electronAPI.updateSmStats({ shops: successCount, skus: successSkuCount });
      await updateSmDashboard();
    }
    renderSmTaskTable();
  }

  if (failedCount > 0) {
    showToast(`批量发布完成：成功 ${successCount} 家，失败 ${failedCount} 家；可勾选失败项重试`, 5000);
  } else {
    showToast(`已逐个发布 ${successCount} 家店铺，共 ${successSkuCount} 个SKU`, 5000);
  }
}

async function handleSmCreateTask() {
  if (!requireTier('shopManage')) return;
  if (smBatchPublishRunning) {
    showToast('请等待批量发布完成');
    return;
  }
  if (smQueryRunning) {
    showToast('请等待当前商品查询完成');
    return;
  }
  const accountId = String(smShopSelect?.value || '');
  if (!accountId) {
    showToast('请先选择店铺');
    return;
  }
  const collected = collectSmQueryParams(accountId);
  if (!collected.success) {
    showToast(collected.error);
    return;
  }
  const api = getSmTaskStateApi();
  if (!api) {
    showToast('任务模块未加载，请重启软件后重试');
    return;
  }
  const existingTask = smTasks.find(task => String(task.accountId) === accountId);
  if (existingTask) {
    showSmPanel('tasks');
    showToast('该店铺已有采集任务，请先处理或删除原任务');
    return;
  }
  const selectedOption = smShopSelect.options[smShopSelect.selectedIndex];
  const qtyConfig = getSmQtyFilterConfig();
  const task = api.createTask({
    accountId,
    shopName: selectedOption?.textContent || '未命名店铺',
    params: collected.params,
    qtyMode: qtyConfig.mode,
    qtyCount: qtyConfig.count
  });
  smTasks.push(task);
  const saveResult = await persistSmTasks();
  if (saveResult && saveResult.success === false) {
    smTasks = smTasks.filter(item => item.id !== task.id);
    renderSmTaskTable();
    showToast(saveResult.error || '任务保存失败');
    return;
  }
  renderSmTaskTable();
  showSmPanel('tasks');
  showToast(`已创建“${task.shopName}”采集任务`);
}

async function runSmTaskQueue(taskIds) {
  if (!requireTier('shopManage')) return;
  if (smBatchPublishRunning) {
    showToast('请等待批量发布完成');
    return;
  }
  if (smQueryRunning || smTaskQueueRunning) {
    showToast('已有商品采集正在进行中');
    return;
  }
  const requestedIds = Array.isArray(taskIds) ? new Set(taskIds.map(String)) : null;
  const queue = smTasks.filter(task =>
    task.status === 'queued' && (!requestedIds || requestedIds.has(String(task.id)))
  );
  if (queue.length === 0) {
    showToast('没有等待采集的任务');
    return;
  }

  smTaskQueueRunning = true;
  setSmQueryBusy(true);
  showSmPanel('tasks');
  try {
    for (const task of queue) {
      await executeSmTask(task);
    }
  } finally {
    smActiveTaskId = '';
    smActiveQueryAccountId = '';
    smTaskQueueRunning = false;
    setSmQueryBusy(false);
    renderSmTaskTable();
  }
}

async function executeSmTask(task) {
  const api = getSmTaskStateApi();
  task.status = 'collecting';
  task.error = '';
  task.progress = { stage: 'preparing', message: '正在验证店铺登录状态' };
  task.updatedAt = new Date().toISOString();
  renderSmTaskTable();
  await persistSmTasks();

  try {
    const accounts = await window.electronAPI.getShopAccounts();
    const account = (Array.isArray(accounts) ? accounts : [])
      .find(item => String(item.id) === String(task.accountId));
    if (!account) throw new Error('店铺账号已不存在，请重新创建任务');

    const switchResult = await window.electronAPI.switchShopAccount(account);
    smShopSelect.value = String(task.accountId);
    syncSmShopSelectTrigger();
    if (!switchResult || !switchResult.loggedIn) {
      updateSmLoginStatus(false, '', switchResult?.validationError ? 'error' : 'offline');
      throw new Error(switchResult?.error || '店铺登录状态已失效，请重新登录后重试');
    }
    updateSmLoginStatus(true, switchResult.shopName || task.shopName, 'online');

    smActiveTaskId = task.id;
    smActiveQueryAccountId = String(task.accountId);
    task.progress = { stage: 'preparing', message: '正在准备查询' };
    renderSmTaskTable();

    const result = await window.electronAPI.shopQueryGoods(task.params);
    if (!result || !result.success) {
      if (result?.needLogin) updateSmLoginStatus(false, '', 'offline');
      throw new Error(result?.error || '商品采集失败');
    }

    const rawGoods = Array.isArray(result.goods) ? result.goods : [];
    const filteredGoods = selectSmGoodsByQtyConfig(rawGoods, task.qtyMode, task.qtyCount);
    const productCodes = new Set();
    let missingProductCodes = 0;
    filteredGoods.forEach(item => {
      const productCode = String(item?.productCode || '').trim();
      if (productCode) productCodes.add(productCode);
      else missingProductCodes += 1;
    });

    smTaskResultCache.set(task.id, { rawGoods, filteredGoods });
    task.status = 'complete';
    task.progress = {
      stage: 'complete',
      completed: productCodes.size + missingProductCodes,
      total: productCodes.size + missingProductCodes,
      loadedSkuTotal: filteredGoods.length
    };
    task.resultSpuCount = productCodes.size + missingProductCodes;
    task.resultSkuCount = filteredGoods.length;
    task.error = '';
    task.updatedAt = new Date().toISOString();

    const savedResult = await window.electronAPI.saveShopGoodsTaskResult({
      taskId: task.id,
      rawGoods,
      filteredGoods
    });
    task.resultSaved = Boolean(savedResult?.success);
    if (!task.resultSaved) {
      console.error('[SM任务] 采集结果本地保存失败:', savedResult?.error || '未知错误');
    }
  } catch (error) {
    task.status = 'failed';
    task.error = String(error?.message || '商品采集失败');
    task.progress = { stage: 'error', message: task.error };
    task.resultSpuCount = 0;
    task.resultSkuCount = 0;
    task.resultSaved = false;
    task.updatedAt = new Date().toISOString();
    smTaskResultCache.delete(task.id);
  } finally {
    smActiveTaskId = '';
    smActiveQueryAccountId = '';
    renderSmTaskTable();
    await persistSmTasks();
  }
}

async function viewSmTaskResult(task) {
  let result;
  try {
    result = await loadSmTaskResultData(task);
  } catch (error) {
    showToast(error.message || '没有找到该任务的商品结果');
    return;
  }

  smViewingTaskId = task.id;
  smGoodsSourceAccountId = String(task.accountId || '');
  smGoods = result.rawGoods.slice();
  smFilteredGoods = result.filteredGoods.slice();
  renderSmGoodsTable();
  updateSmProductPanelContext();
  showSmPanel('goods');
}

async function handleSmTaskTableAction(event) {
  const button = event.target.closest('[data-task-action]');
  if (!button || button.disabled) return;
  const task = smTasks.find(item => item.id === button.dataset.taskId);
  if (!task) return;
  const action = button.dataset.taskAction;
  if (action === 'view') {
    await viewSmTaskResult(task);
    return;
  }
  if (action === 'run' || action === 'retry') {
    task.status = 'queued';
    task.error = '';
    task.progress = { stage: 'queued' };
    await persistSmTasks();
    renderSmTaskTable();
    await runSmTaskQueue([task.id]);
    return;
  }
  if (action === 'republish') {
    if (!confirm(`“${task.shopName}”已经发布过打标任务，确定允许再次发布吗？`)) return;
    task.publishStatus = 'unpublished';
    task.publishError = '';
    task.publishedAt = '';
    task.publishedTaskCount = 0;
    task.executionStatus = 'not_started';
    smSelectedTaskIds.add(task.id);
    await persistSmTasks();
    renderSmTaskTable();
    await openSmBatchPublishModal();
    return;
  }
  if (action === 'delete') {
    const publishedNotice = task.publishStatus === 'published'
      ? '（已经创建的打标任务不会被删除）'
      : '';
    if (!confirm(`确定删除“${task.shopName}”采集任务吗？${publishedNotice}`)) return;
    smTasks = smTasks.filter(item => item.id !== task.id);
    smTaskResultCache.delete(task.id);
    smSelectedTaskIds.delete(task.id);
    if (smViewingTaskId === task.id) {
      smViewingTaskId = '';
      smGoodsSourceAccountId = '';
      smGoods = [];
      smFilteredGoods = [];
      renderSmGoodsTable();
      updateSmProductPanelContext();
    }
    await persistSmTasks();
    if (window.electronAPI.deleteShopGoodsTaskResult) {
      await window.electronAPI.deleteShopGoodsTaskResult(task.id);
    }
    renderSmTaskTable();
  }
}

// ========== 商品查询 ==========

function startSmQueryProgress() {
  smQueryEstimateStartedAt = 0;
  smInlineQueryState = {
    stage: 'preparing',
    title: '正在准备商品查询',
    detail: '每完成一页，就会在这里显示这一批商品',
    summary: ''
  };
}

function formatSmRemainingTime(remainingMs) {
  const remainingSeconds = Math.max(1, Math.ceil(Number(remainingMs || 0) / 1000));
  if (remainingSeconds < 60) return '预计不到 1 分钟完成';
  const remainingMinutes = Math.ceil(remainingSeconds / 60);
  if (remainingMinutes < 60) return `预计 ${remainingMinutes} 分钟完成`;
  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  return minutes > 0
    ? `预计 ${hours} 小时 ${minutes} 分钟完成`
    : `预计 ${hours} 小时完成`;
}

function updateSmQueryProgress(progress = {}) {
  const stage = String(progress.stage || 'preparing');
  const completed = Math.max(0, Number(progress.completed) || 0);
  const total = Math.max(0, Number(progress.total) || 0);
  const pageNum = Math.max(1, Number(progress.pageNum) || 1);
  const totalPages = Math.max(pageNum, Number(progress.totalPages) || pageNum);
  const loadedSkuTotal = Math.max(0, Number(progress.loadedSkuTotal) || 0);
  let title = '正在读取商品';
  let detail = String(progress.message || '商品会按批次直接显示在列表中');
  let summary = '';

  if (stage === 'preparing' || stage === 'initial-wait') {
    title = '正在准备商品查询';
    detail = String(progress.message || '每完成一页，就会在这里显示这一批商品');
  } else if (stage === 'rate-limit') {
    title = '查询暂时等待';
    detail = String(progress.message || '京东接口限流，等待后将重试一次');
    summary = '限流等待中';
  } else if (stage === 'complete') {
    title = '没有符合条件的商品';
    detail = '可以调整时间、售价或商品状态后重新查询';
    const skuTotal = Math.max(0, Number(progress.skuTotal ?? progress.loadedSkuTotal) || 0);
    summary = total > 0 ? `${total} SPU · ${skuTotal} SKU` : `${skuTotal} SKU`;
  } else if (stage === 'error') {
    title = '查询失败';
    detail = String(progress.message || '请稍后重新查询');
    summary = total > 0 ? `查询中断 · 已读取 ${completed} / ${total} 个 SPU` : '查询失败';
  } else if (stage === 'page-wait' || stage === 'page-complete') {
    const completedPage = stage === 'page-wait' ? Math.max(0, pageNum - 1) : pageNum;
    title = '正在读取商品';
    detail = stage === 'page-wait'
      ? `已完成 ${completedPage}/${totalPages} 页，等待读取第 ${pageNum} 页`
      : `第 ${pageNum}/${totalPages} 页已完成，商品已加入列表`;
    const nextText = stage === 'page-wait'
      ? ` · ${Math.max(1, Math.round((Number(progress.waitMs) || 4000) / 1000))}秒后继续`
      : pageNum >= totalPages ? ' · 正在汇总' : '';
    summary = `查询中 · 已读取 ${completed} / ${total} 个 SPU · ${loadedSkuTotal} 个 SKU${nextText}`;
  } else {
    if (!smQueryEstimateStartedAt) smQueryEstimateStartedAt = Date.now();
    const elapsedMs = Date.now() - smQueryEstimateStartedAt;
    const etaText = total > completed && completed >= 3 && elapsedMs >= 1500
      ? formatSmRemainingTime((elapsedMs / completed) * (total - completed))
      : '正在读取';
    const pageCompleted = Math.max(0, Number(progress.pageCompleted) || 0);
    const pageTotal = Math.max(0, Number(progress.pageTotal) || 0);
    detail = `正在查询第 ${pageNum}/${totalPages} 页 SKU` +
      (pageTotal > 0 ? `（本页 ${pageCompleted}/${pageTotal} 个 SPU）` : '');
    summary = `查询中 · 已读取 ${completed} / ${total} 个 SPU · ${etaText}`;
  }

  smInlineQueryState = { stage, title, detail, summary };
  if (smFilteredGoods.length === 0) {
    renderSmGoodsTable();
  } else if (smGoodsCount) {
    smGoodsCount.textContent = summary;
    smGoodsCount.classList.add('visible', 'is-querying');
    smGoodsCount.classList.toggle('is-error', stage === 'error');
  }
}

function collectSmQueryParams(accountId) {
  const normalizedAccountId = String(accountId || '');
  if (!normalizedAccountId) return { success: false, error: '请先选择店铺' };

  const dateFrom = $('#smDateFrom').value || '';
  const dateTo = $('#smDateTo').value || '';
  if (Boolean(dateFrom) !== Boolean(dateTo)) {
    return { success: false, error: '请同时选择上架开始时间和结束时间' };
  }
  if (dateFrom && dateTo && new Date(dateFrom).getTime() > new Date(dateTo).getTime()) {
    return { success: false, error: '上架开始时间不能晚于结束时间' };
  }

  const priceMinText = $('#smPriceMin').value.trim();
  const priceMaxText = $('#smPriceMax').value.trim();
  const priceMin = priceMinText === '' ? null : Number(priceMinText);
  const priceMax = priceMaxText === '' ? null : Number(priceMaxText);
  if ((priceMin != null && (!Number.isFinite(priceMin) || priceMin < 0)) ||
      (priceMax != null && (!Number.isFinite(priceMax) || priceMax < 0))) {
    return { success: false, error: '售价范围必须是大于或等于0的有效数字' };
  }
  if (priceMin != null && priceMax != null && priceMin > priceMax) {
    return { success: false, error: '最低售价不能高于最高售价' };
  }

  return {
    success: true,
    params: {
      accountId: normalizedAccountId,
      dateFrom,
      dateTo,
      priceMin: priceMinText,
      priceMax: priceMaxText,
      goodsStatus: (document.querySelector('input[name="smGoodsStatus"]:checked') || {}).value || '售卖中'
    }
  };
}

function getSmQtyFilterConfig() {
  const qtyRadio = document.querySelector('input[name="smGoodsQty"]:checked');
  const mode = qtyRadio ? qtyRadio.value : '全部';
  const countInput = mode === '前N个' ? $('#smFirstQtyN') : $('#smQtyN');
  return { mode, count: parseInt(countInput?.value, 10) || 10 };
}

function selectSmGoodsForCurrentQty(goods) {
  const source = Array.isArray(goods) ? goods : [];
  const { mode, count } = getSmQtyFilterConfig();
  return selectSmGoodsByQtyConfig(source, mode, count);
}

function selectSmGoodsByQtyConfig(goods, mode, count) {
  const source = Array.isArray(goods) ? goods : [];
  if (!window.shopGoodsSelection || typeof window.shopGoodsSelection.selectGoodsPerProduct !== 'function') {
    return source.slice();
  }
  return window.shopGoodsSelection.selectGoodsPerProduct(source, mode, count);
}

function mergeSmGoodsBySku(currentGoods, incomingGoods) {
  if (window.shopGoodsSelection?.mergeGoodsBySku) {
    return window.shopGoodsSelection.mergeGoodsBySku(currentGoods, incomingGoods);
  }
  return [...(Array.isArray(currentGoods) ? currentGoods : []), ...(Array.isArray(incomingGoods) ? incomingGoods : [])];
}

function appendSmGoodsBatch(batchGoods) {
  const incoming = Array.isArray(batchGoods) ? batchGoods : [];
  if (incoming.length === 0) return;
  const previousFilteredCount = smFilteredGoods.length;
  const selectedIncoming = selectSmGoodsForCurrentQty(incoming);
  smGoods = mergeSmGoodsBySku(smGoods, incoming);
  smFilteredGoods = mergeSmGoodsBySku(smFilteredGoods, selectedIncoming);
  const appendedGoods = smFilteredGoods.slice(previousFilteredCount);
  if (appendedGoods.length === 0) return;
  if (appendedGoods.length !== selectedIncoming.length) {
    // 极少数接口重复返回既有 SKU 时需要更新旧行；此时才进行一次完整校正。
    renderSmGoodsTable();
    return;
  }

  // 查询期间每一页只追加本页新行，不再反复重建前面已经展示的全部商品。
  // 这让渲染成本从“累计数据反复重绘”降为“每条数据只创建一次”。
  if (previousFilteredCount === 0) smGoodsTableBody.innerHTML = '';
  const existingSpuCount = smGoodsTableBody.querySelectorAll('.sm-spu-row').length;
  appendSmGoodsGroupRows(
    buildSmGoodsGroups(appendedGoods, previousFilteredCount),
    existingSpuCount
  );
  updateSmGoodsSummary();
  syncSmSelectionCheckboxes();
}

function haveSameSmSkuSet(leftGoods, rightGoods) {
  const left = new Set((Array.isArray(leftGoods) ? leftGoods : []).map(item => String(item?.sku || '')).filter(Boolean));
  const right = new Set((Array.isArray(rightGoods) ? rightGoods : []).map(item => String(item?.sku || '')).filter(Boolean));
  return left.size === right.size && [...left].every(sku => right.has(sku));
}

function handleSmQueryProgress(progress = {}) {
  const progressAccountId = String(progress.accountId || '');
  if (smActiveQueryAccountId && progressAccountId && progressAccountId !== smActiveQueryAccountId) return;
  if (smActiveTaskId) {
    const task = smTasks.find(item => item.id === smActiveTaskId);
    const api = getSmTaskStateApi();
    if (task && api) {
      api.applyProgress(task, progress);
      scheduleSmTaskTableRender();
    }
    return;
  }
  if (progress.stage === 'page-complete' && Array.isArray(progress.batchGoods)) {
    appendSmGoodsBatch(progress.batchGoods);
  }
  updateSmQueryProgress(progress);
}

function finishSmQueryProgress(success, message = '') {
  if (success) {
    smInlineQueryState = { stage: 'complete', title: '', detail: '', summary: '' };
    if (smFilteredGoods.length > 0) updateSmGoodsSummary();
    else renderSmGoodsTable();
  } else if (smInlineQueryState.stage !== 'error') {
    updateSmQueryProgress({ stage: 'error', message });
  }
}

async function handleSmQuery() {
  if (!requireTier('shopManage')) return;
  console.log('[SM] handleSmQuery called, smLoggedIn:', smLoggedIn);
  if (smBatchPublishRunning) {
    showToast('请等待批量发布完成');
    return;
  }
  if (smQueryRunning) {
    showToast('商品查询正在进行中');
    return;
  }
  if (!smLoggedIn) {
    showToast('请先登录店铺后台');
    return;
  }

  const queryAccountId = String(smShopSelect.value || '');
  if (!queryAccountId) {
    showToast('请先选择店铺');
    return;
  }

  const collected = collectSmQueryParams(queryAccountId);
  if (!collected.success) {
    showToast(collected.error);
    return;
  }
  const params = collected.params;

  smViewingTaskId = '';
  smGoodsSourceAccountId = queryAccountId;
  showSmPanel('goods');
  setSmQueryBusy(true);
  smActiveQueryAccountId = queryAccountId;
  smGoods = [];
  smFilteredGoods = [];
  startSmQueryProgress();
  renderSmGoodsTable();
  setSmResultActionsEnabled(false);
  addSmLog('info', '正在查询店铺商品...');
  let querySucceeded = false;
  let queryError = '';

  try {
    const result = await window.electronAPI.shopQueryGoods(params);

    if (result.success) {
      if (String(smShopSelect.value || '') !== queryAccountId) {
        throw new Error('查询期间店铺已发生变化，本次结果已丢弃，请重新查询');
      }
      querySucceeded = true;
      const finalGoods = Array.isArray(result.goods) ? result.goods : [];
      const incrementalResultComplete = haveSameSmSkuSet(smGoods, finalGoods);
      smGoods = finalGoods;
      if (incrementalResultComplete) {
        // 所有分页事件均已到达时保留现有 DOM，避免完成时再重绘上万条记录。
        updateSmGoodsSummary();
        syncSmSelectionCheckboxes();
      } else {
        // IPC 进度若因窗口刷新等原因漏过一页，以最终完整结果纠正列表。
        applySmQtyFilter();
      }
      addSmLog('success', `查询完成，共 ${smGoods.length} 条SKU记录`);

      if (result.message) {
        addSmLog('info', result.message);
      }
    } else {
      queryError = result.error || '未知错误';
      if (smGoods.length > 0) {
        addSmLog('info', `已保留前面成功读取的 ${smGoods.length} 条SKU记录，仅供查看`);
      }
      setSmResultActionsEnabled(false);
      if (result.needLogin) updateSmLoginStatus(false, '', 'offline');
      console.error('[SM] 店铺商品查询失败:', result.error || '未知错误');
      addSmLog('error', `查询失败: ${result.error}`);
    }
  } catch (err) {
    queryError = err.message || '未知错误';
    if (smGoods.length > 0) {
      addSmLog('info', `已保留前面成功读取的 ${smGoods.length} 条SKU记录，仅供查看`);
    }
    setSmResultActionsEnabled(false);
    console.error('[SM] 店铺商品查询异常:', err);
    addSmLog('error', `查询异常: ${err.message}`);
  } finally {
    finishSmQueryProgress(querySucceeded, queryError);
    setSmQueryBusy(false);
    if (!querySucceeded) setSmResultActionsEnabled(false);
    if (smGoods.length === 0) renderSmGoodsTable();
    smActiveQueryAccountId = '';
  }
}

function getSmStatusBadgeMarkup(status) {
  if (status === '售卖中') {
    return '<span class="sm-status-badge is-on-sale"><span class="sm-status-dot" aria-hidden="true"></span>售卖中</span>';
  }
  if (status === '已下架') {
    return '<span class="sm-status-badge is-off-shelf"><span class="sm-status-dot" aria-hidden="true"></span>已下架</span>';
  }
  return '<span class="sm-status-badge is-unknown"><span class="sm-status-dot" aria-hidden="true"></span>未知</span>';
}

function hideSmGoodsContextMenu() {
  if (smGoodsCtxMenu) smGoodsCtxMenu.style.display = 'none';
  if (smGoodsTableBody) {
    smGoodsTableBody.querySelectorAll('.is-context-target').forEach(row => {
      row.classList.remove('is-context-target');
    });
  }
  smGoodsContextTarget = null;
}

function showSmGoodsContextMenu(x, y, target, row) {
  if (!smGoodsCtxMenu || !smCtxToggleSelection || !smCtxDelete) return;
  hideSmGoodsContextMenu();
  smGoodsContextTarget = target;
  row.classList.add('is-context-target');
  smCtxToggleSelection.textContent = target.isChecked ? '取消勾选' : '勾选';
  smCtxDelete.textContent = target.type === 'spu'
    ? `删除该商品（含 ${target.skuCount} 个 SKU）`
    : '删除当前 SKU';
  smGoodsCtxMenu.style.left = '0px';
  smGoodsCtxMenu.style.top = '0px';
  smGoodsCtxMenu.style.display = 'block';
  const rect = smGoodsCtxMenu.getBoundingClientRect();
  const maxX = Math.max(4, window.innerWidth - rect.width - 4);
  const maxY = Math.max(4, window.innerHeight - rect.height - 4);
  smGoodsCtxMenu.style.left = `${Math.max(4, Math.min(x, maxX))}px`;
  smGoodsCtxMenu.style.top = `${Math.max(4, Math.min(y, maxY))}px`;
  smCtxToggleSelection.focus({ preventScroll: true });
}

function handleSmGoodsContextMenu(event) {
  const row = event.target.closest('.sm-spu-row, .sm-sku-row');
  if (!row || !smGoodsTableBody.contains(row)) return;
  event.preventDefault();
  if (smQueryRunning) {
    hideSmGoodsContextMenu();
    showToast('商品查询进行中，暂时不能操作列表商品');
    return;
  }

  const itemIndex = Number.parseInt(row.dataset.itemIdx, 10);
  const item = smFilteredGoods[itemIndex];
  if (!item) return;
  const type = row.classList.contains('sm-spu-row') ? 'spu' : 'sku';
  const productCode = String(item.productCode || '').trim();
  const checkbox = type === 'spu'
    ? row.querySelector('.sm-spu-check')
    : row.querySelector('.sm-goods-check');
  const isChecked = Boolean(checkbox && checkbox.checked && !checkbox.indeterminate);
  const skuCount = type === 'spu'
    ? (productCode
        ? smGoods.filter(goodsItem => String(goodsItem && goodsItem.productCode || '').trim() === productCode).length
        : 1)
    : 1;
  showSmGoodsContextMenu(event.clientX, event.clientY, {
    type,
    item,
    itemIndex,
    groupKey: String(row.dataset.groupKey || ''),
    isChecked,
    skuCount
  }, row);
}

function captureSmGoodsTableState() {
  const selectedItems = new Set();
  smGoodsTableBody.querySelectorAll('.sm-sku-row .sm-goods-check:checked').forEach(checkbox => {
    const index = Number.parseInt(checkbox.dataset.idx, 10);
    const item = smFilteredGoods[index];
    if (item) selectedItems.add(item);
  });
  const expandedGroupKeys = new Set(
    Array.from(smGoodsTableBody.querySelectorAll('.sm-spu-row.is-expanded'))
      .map(row => String(row.dataset.groupKey || ''))
  );
  return { selectedItems, expandedGroupKeys };
}

function toggleSmGoodsContextSelection() {
  const target = smGoodsContextTarget;
  if (!target) {
    hideSmGoodsContextMenu();
    return;
  }

  const shouldCheck = !target.isChecked;
  if (target.type === 'spu') {
    getSmSkuRowsForGroup(target.groupKey).forEach(skuRow => {
      const checkbox = skuRow.querySelector('.sm-goods-check');
      if (checkbox) checkbox.checked = shouldCheck;
    });
  } else {
    const row = Array.from(smGoodsTableBody.querySelectorAll('.sm-sku-row'))
      .find(skuRow => Number.parseInt(skuRow.dataset.itemIdx, 10) === target.itemIndex);
    const checkbox = row?.querySelector('.sm-goods-check');
    if (checkbox) checkbox.checked = shouldCheck;
  }

  hideSmGoodsContextMenu();
  syncSmSelectionCheckboxes();
}

function deleteSmGoodsContextTarget() {
  const target = smGoodsContextTarget;
  if (!target || !window.shopGoodsSelection?.removeGoodsByTarget) {
    hideSmGoodsContextMenu();
    return;
  }

  const tableState = captureSmGoodsTableState();
  const previousGoodsCount = smGoods.length;
  smGoods = window.shopGoodsSelection.removeGoodsByTarget(smGoods, target);
  smFilteredGoods = window.shopGoodsSelection.removeGoodsByTarget(smFilteredGoods, target);
  const removedCount = Math.max(0, previousGoodsCount - smGoods.length);
  const removedSku = String(target.item.sku || '').trim();
  hideSmGoodsContextMenu();
  renderSmGoodsTable(tableState);

  if (target.type === 'spu') {
    const productCode = String(target.item.productCode || '').trim() || '无编码商品';
    addSmLog('info', `已从列表删除 SPU ${productCode}，共 ${removedCount} 个 SKU`);
    showToast(`已删除该商品的 ${removedCount} 个 SKU`);
  } else {
    addSmLog('info', `已从列表删除 SKU ${removedSku || '无编号'}`);
    showToast('已删除当前 SKU');
  }
}

function buildSmGoodsGroups(goods, startIndex = 0) {
  const groups = [];
  const groupMap = new Map();
  (Array.isArray(goods) ? goods : []).forEach((item, offset) => {
    const originalIdx = startIndex + offset;
    const productCode = String(item.productCode || '').trim();
    // 响应异常缺少 productCode 时，每条记录必须独立成组，不能把不同商品合并。
    const groupKey = productCode || `__missing_product_${originalIdx}`;
    if (!groupMap.has(groupKey)) {
      const group = { groupKey, productCode, items: [], startIdx: originalIdx };
      groups.push(group);
      groupMap.set(groupKey, group);
    }
    groupMap.get(groupKey).items.push({ ...item, originalIdx });
  });
  return groups;
}

function getSmHighResolutionImageUrl(value) {
  const api = getSmTaskStateApi();
  return api?.toJdHighResolutionImageUrl
    ? api.toJdHighResolutionImageUrl(value)
    : String(value || '');
}

function bindSmGoodsRowInteractions(root) {
  root.querySelectorAll('.sm-spu-row').forEach(row => {
    row.addEventListener('click', (event) => {
      if (event.target.tagName === 'INPUT' && event.target.type === 'checkbox') return;
      const skuRows = getSmSkuRowsForGroup(row.dataset.groupKey);
      const isHidden = skuRows.length > 0 && skuRows[0].style.display === 'none';
      skuRows.forEach(skuRow => {
        skuRow.style.display = isHidden ? '' : 'none';
      });
      row.classList.toggle('is-expanded', isHidden);
      row.setAttribute('aria-expanded', String(isHidden));
    });
  });

  root.querySelectorAll('.sm-thumb-wrap').forEach(wrap => {
    const zoom = wrap.querySelector('.sm-thumb-zoom');
    wrap.addEventListener('mouseenter', () => {
      if (zoom && !zoom.getAttribute('src')) {
        zoom.src = zoom.dataset.previewSrc || zoom.dataset.fallbackSrc || '';
      }
    });
    wrap.addEventListener('mousemove', (event) => {
      if (zoom) {
        zoom.style.left = (event.clientX + 15) + 'px';
        zoom.style.top = Math.max(10, event.clientY - 140) + 'px';
      }
    });
    if (zoom) {
      zoom.addEventListener('error', () => {
        if (zoom.dataset.fallbackApplied === '1' || !zoom.dataset.fallbackSrc) return;
        zoom.dataset.fallbackApplied = '1';
        zoom.src = zoom.dataset.fallbackSrc;
      });
    }
  });
}

function appendSmGoodsGroupRows(groups, spuSequenceStart = 0) {
  const fragment = document.createDocumentFragment();
  (Array.isArray(groups) ? groups : []).forEach((group, groupOffset) => {
    const spuSeq = spuSequenceStart + groupOffset + 1;
    const firstItem = group.items[0];
    const previewImageUrl = getSmHighResolutionImageUrl(firstItem.image);
    const skuCount = group.items.length;
    const prices = group.items
      .map(item => item.price)
      .filter(value => value != null && String(value).trim() !== '')
      .map(Number)
      .filter(Number.isFinite);
    let priceDisplay = '';
    if (prices.length > 0) {
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      priceDisplay = min === max ? `¥${min}` : `¥${min} ~ ¥${max}`;
    }

    const mainTr = document.createElement('tr');
    mainTr.className = 'sm-spu-row';
    mainTr.dataset.spu = group.productCode;
    mainTr.dataset.groupKey = group.groupKey;
    mainTr.dataset.itemIdx = String(firstItem.originalIdx);
    mainTr.setAttribute('aria-expanded', 'false');
    mainTr.innerHTML = `
      <td><span class="sm-check-wrap"><input type="checkbox" class="sm-spu-check" aria-label="选择该商品的全部SKU" checked /></span></td>
      <td><span class="sm-index-badge">${spuSeq}</span></td>
      <td>${firstItem.image
        ? `<span class="sm-thumb-wrap"><img class="sm-thumb" src="${escapeHtml(firstItem.image)}" alt="" /><img class="sm-thumb-zoom" data-preview-src="${escapeHtml(previewImageUrl)}" data-fallback-src="${escapeHtml(firstItem.image)}" alt="" /></span>`
        : `<span class="sm-thumb-placeholder" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m4 16 4.2-4.2 3 3L14 12l6 6"></path><circle cx="15.5" cy="7.5" r="2"></circle><rect x="3" y="3" width="18" height="18" rx="4"></rect></svg></span>`}
      </td>
      <td>
        <div class="sm-title-cell" title="${escapeHtml(firstItem.name || '')}">
          <strong class="sm-product-title">${escapeHtml(firstItem.name || '未命名商品')}</strong>
          <span class="sm-product-subtitle sm-spu-subtitle">SPU：${escapeHtml(group.productCode || '暂无编码')} · 共 ${skuCount} 个 SKU</span>
        </div>
      </td>
      <td>${priceDisplay ? `<span class="sm-price-value">${priceDisplay}</span>` : '<span class="sm-cell-empty">—</span>'}</td>
      <td>${getSmStatusBadgeMarkup(firstItem.status)}</td>
      <td><span class="sm-date-value">${escapeHtml(firstItem.listDate || '—')}</span></td>
    `;
    fragment.appendChild(mainTr);

    group.items.forEach((item, subIdx) => {
      const skuDisplayName = item.skuName || item.name || '未命名商品';
      const subTr = document.createElement('tr');
      subTr.className = 'sm-sku-row';
      subTr.style.display = 'none';
      subTr.dataset.spuSku = group.productCode;
      subTr.dataset.groupKey = group.groupKey;
      subTr.dataset.itemIdx = String(item.originalIdx);
      subTr.innerHTML = `
        <td><span class="sm-check-wrap"><input type="checkbox" class="sm-goods-check" data-idx="${item.originalIdx}" aria-label="选择SKU ${escapeHtml(item.sku || '')}" checked /></span></td>
        <td><span class="sm-sku-index">${spuSeq}.${subIdx + 1}</span></td>
        <td><span class="sm-hierarchy-line" aria-hidden="true"></span></td>
        <td>
          <div class="sm-title-cell sm-sku-title-cell" title="${escapeHtml(skuDisplayName)}">
            <span class="sm-sku-title">${escapeHtml(skuDisplayName)}</span>
            <span class="sm-product-meta-row">
              <span class="sm-sku-code">SKU：${escapeHtml(item.sku || '暂无编号')}</span>
            </span>
          </div>
        </td>
        <td>${item.price != null ? `<span class="sm-price-value is-sku">¥${escapeHtml(item.price)}</span>` : '<span class="sm-cell-empty">—</span>'}</td>
        <td>${getSmStatusBadgeMarkup(item.status)}</td>
        <td><span class="sm-date-value">${escapeHtml(item.listDate || '—')}</span></td>
      `;
      fragment.appendChild(subTr);
    });
  });

  bindSmGoodsRowInteractions(fragment);
  smGoodsTableBody.appendChild(fragment);
}

function updateSmGoodsSummary(groups) {
  let groupCount;
  if (Array.isArray(groups)) {
    groupCount = groups.length;
  } else {
    const productCodes = new Set();
    let missingProductCodes = 0;
    smFilteredGoods.forEach(item => {
      const productCode = String(item.productCode || '').trim();
      if (productCode) productCodes.add(productCode);
      else missingProductCodes++;
    });
    groupCount = productCodes.size + missingProductCodes;
  }
  smGoodsCount.textContent = `${groupCount} SPU · ${smFilteredGoods.length} SKU`;
  smGoodsCount.classList.add('visible');
  smGoodsCount.classList.remove('is-querying', 'is-error');
}

function renderSmGoodsTable(options = {}) {
  hideSmGoodsContextMenu();
  if (smFilteredGoods.length === 0) {
    const queryStateVisible = smQueryRunning && !['complete', 'error'].includes(smInlineQueryState.stage);
    const emptyTitle = smInlineQueryState.stage === 'error'
      ? '查询失败'
      : queryStateVisible
        ? smInlineQueryState.title || '正在读取商品'
        : '没有符合条件的商品';
    const emptyDescription = smInlineQueryState.stage === 'error'
      ? smInlineQueryState.detail || '请稍后重新查询'
      : queryStateVisible
        ? smInlineQueryState.detail || '商品会按批次直接显示在列表中'
        : '可以调整时间、售价或商品状态后重新查询';
    smGoodsTableBody.innerHTML = `
      <tr class="wms-empty-row sm-empty-row">
        <td colspan="7" class="wms-empty-state sm-product-empty-state">
          <strong>${escapeHtml(emptyTitle)}</strong>
          <span>${escapeHtml(emptyDescription)}</span>
        </td>
      </tr>`;
    smGoodsCount.classList.remove('visible', 'is-querying', 'is-error');
    if (smSelectedCount) {
      smSelectedCount.textContent = '已选 0';
      smSelectedCount.classList.remove('has-selection');
    }
    const selectAll = $('#smSelectAll');
    if (selectAll) {
      selectAll.checked = false;
      selectAll.indeterminate = false;
    }
    setSmResultActionsEnabled(false);
    return;
  }

  const groups = buildSmGoodsGroups(smFilteredGoods);
  updateSmGoodsSummary(groups);
  smGoodsTableBody.innerHTML = '';
  appendSmGoodsGroupRows(groups);

  const selectAll = $('#smSelectAll');
  if (selectAll) selectAll.checked = true;
  if (options.selectedItems instanceof Set) {
    smGoodsTableBody.querySelectorAll('.sm-sku-row .sm-goods-check').forEach(checkbox => {
      const index = Number.parseInt(checkbox.dataset.idx, 10);
      checkbox.checked = options.selectedItems.has(smFilteredGoods[index]);
    });
  }
  if (options.expandedGroupKeys instanceof Set) {
    smGoodsTableBody.querySelectorAll('.sm-spu-row').forEach(row => {
      const isExpanded = options.expandedGroupKeys.has(String(row.dataset.groupKey || ''));
      row.classList.toggle('is-expanded', isExpanded);
      row.setAttribute('aria-expanded', String(isExpanded));
      getSmSkuRowsForGroup(row.dataset.groupKey).forEach(skuRow => {
        skuRow.style.display = isExpanded ? '' : 'none';
      });
    });
  }
  syncSmSelectionCheckboxes();
  setSmResultActionsEnabled(true);
}

function getSmSkuRowsForGroup(groupKey) {
  const normalizedKey = String(groupKey || '');
  return Array.from(smGoodsTableBody.querySelectorAll('.sm-sku-row'))
    .filter(row => String(row.dataset.groupKey || '') === normalizedKey);
}

function syncSmSelectionCheckboxes() {
  const skuChecks = Array.from(smGoodsTableBody.querySelectorAll('.sm-sku-row .sm-goods-check'));
  const groupChecks = new Map();
  smGoodsTableBody.querySelectorAll('.sm-sku-row').forEach(skuRow => {
    const groupKey = String(skuRow.dataset.groupKey || '');
    const checkbox = skuRow.querySelector('.sm-goods-check');
    if (!checkbox) return;
    if (!groupChecks.has(groupKey)) groupChecks.set(groupKey, []);
    groupChecks.get(groupKey).push(checkbox);
    skuRow.classList.toggle('is-unselected', !checkbox.checked);
  });

  smGoodsTableBody.querySelectorAll('.sm-spu-row').forEach(row => {
    const checks = groupChecks.get(String(row.dataset.groupKey || '')) || [];
    const checkedCount = checks.filter(checkbox => checkbox.checked).length;
    const groupCheck = row.querySelector('.sm-spu-check');
    if (groupCheck) {
      groupCheck.checked = checks.length > 0 && checkedCount === checks.length;
      groupCheck.indeterminate = checkedCount > 0 && checkedCount < checks.length;
    }
    row.classList.toggle('is-unselected', checkedCount === 0);
    row.classList.toggle('is-partial', checkedCount > 0 && checkedCount < checks.length);
  });

  const selectAll = $('#smSelectAll');
  if (selectAll) {
    const checkedCount = skuChecks.filter(checkbox => checkbox.checked).length;
    selectAll.checked = skuChecks.length > 0 && checkedCount === skuChecks.length;
    selectAll.indeterminate = checkedCount > 0 && checkedCount < skuChecks.length;
    if (smSelectedCount) {
      smSelectedCount.textContent = `已选 ${checkedCount}`;
      smSelectedCount.classList.toggle('has-selection', checkedCount > 0);
    }
  }
}

function applySmQtyFilter() {
  if (!smGoods || smGoods.length === 0) {
    smFilteredGoods = [];
    renderSmGoodsTable();
    return;
  }

  const { mode: qtyVal, count: qtyCount } = getSmQtyFilterConfig();
  if (!window.shopGoodsSelection || typeof window.shopGoodsSelection.selectGoodsPerProduct !== 'function') {
    console.error('[SM] 每个SPU取SKU筛选模块未加载，保留全部SKU');
    smFilteredGoods = smGoods.slice();
  } else {
    smFilteredGoods = selectSmGoodsForCurrentQty(smGoods);
  }

  const spuCount = new Set(smGoods.map(item => String(item.productCode || ''))).size;
  const modeLabel = qtyVal === 'N个'
    ? `每个SPU随机${qtyCount}个`
    : qtyVal === '前N个'
      ? `每个SPU前${qtyCount}个`
      : `每个SPU ${qtyVal}`;
  console.log(
    `[SM] 每个SPU取SKU: mode=${modeLabel}, ` +
    `SPU=${spuCount}, 输入SKU=${smGoods.length}, 输出SKU=${smFilteredGoods.length}`
  );

  renderSmGoodsTable();
}

function getSelectedSmSkus() {
  const checks = smGoodsTableBody.querySelectorAll('.sm-sku-row .sm-goods-check');
  const selectedIndexes = [];
  checks.forEach(cb => {
    if (cb.checked) {
      selectedIndexes.push(Number.parseInt(cb.dataset.idx, 10));
    }
  });
  if (window.shopGoodsSelection?.collectUniqueSkuValues) {
    return window.shopGoodsSelection.collectUniqueSkuValues(smFilteredGoods, selectedIndexes);
  }
  return [...new Set(selectedIndexes
    .map(index => String(smFilteredGoods[index]?.sku || '').trim())
    .filter(Boolean))];
}

// ========== 导出 TXT ==========

async function handleSmExport() {
  if (!requireTier('shopManage')) return;
  const skus = getSelectedSmSkus();
  if (skus.length === 0) {
    showToast('请先勾选要导出的商品');
    return;
  }

  addSmLog('info', `正在导出 ${skus.length} 个SKU...`);
  const viewedTask = smViewingTaskId
    ? smTasks.find(task => task.id === smViewingTaskId)
    : null;
  const shopName = viewedTask?.shopName || smShopSelect.options[smShopSelect.selectedIndex]?.text || '';
  const result = await window.electronAPI.exportSkuTxt({
    skus,
    shopName,
    dateFrom: viewedTask?.params?.dateFrom || $('#smDateFrom').value || '',
    dateTo: viewedTask?.params?.dateTo || $('#smDateTo').value || ''
  });

  if (result.success) {
    addSmLog('success', `已导出到桌面：${result.fileName} (${skus.length}个SKU)`);
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

  const viewedTask = smViewingTaskId
    ? smTasks.find(task => task.id === smViewingTaskId)
    : null;
  const sourceAccountId = String(viewedTask?.accountId || smGoodsSourceAccountId || smShopSelect.value || '');
  const [modes, sourceAccounts] = await Promise.all([
    window.electronAPI.getModes(),
    window.electronAPI.getShopAccounts()
  ]);
  const availableSendModes = Array.isArray(modes) ? modes : [];
  const sourceAccount = (Array.isArray(sourceAccounts) ? sourceAccounts : [])
    .find(account => String(account.id) === sourceAccountId);
  const sourceShopName = viewedTask?.shopName
    || sourceAccount?.name
    || smShopSelect.options[smShopSelect.selectedIndex]?.textContent
    || '';

  // 加载快捷模式列表
  const smSendMode = $('#smSendMode');
  smSendMode.innerHTML = '<option value="">请选择模式</option>';
  availableSendModes.forEach(mode => {
    const opt = document.createElement('option');
    opt.value = mode.name;
    opt.textContent = mode.name;
    smSendMode.appendChild(opt);
  });
  // 根据类型选择默认模式
  let defaultMode;
  if (smSendType === '下标') {
    defaultMode = availableSendModes.find(m => m.name.includes('下标'));
  } else {
    defaultMode = availableSendModes.find(m => m.name === '入仓打标')
      || availableSendModes.find(m => m.name.includes('打标'));
  }
  if (defaultMode) smSendMode.value = defaultMode.name;

  // 加载商家端店铺列表
  const smSendShop = $('#smSendShop');
  smSendShop.innerHTML = '<option value="">请选择店铺</option>';
  allShopOptions.forEach(opt => {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    smSendShop.appendChild(o);
  });
  smSendShop.value = findSmMatchingTargetShop(sourceShopName);

  // 加载仓库列表
  const smSendWarehouse = $('#smSendWarehouse');
  smSendWarehouse.innerHTML = '<option value="">请选择仓库</option>';
  const warehouseOptions = getSmWarehouseOptions();
  warehouseOptions.forEach(option => {
    const o = document.createElement('option');
    o.value = option.value;
    o.textContent = option.label;
    smSendWarehouse.appendChild(o);
  });
  smSendWarehouse.value = findSmDefaultWarehouse(sourceAccount, warehouseOptions);

  modal.style.display = 'flex';
}

function closeSmSendModal() {
  $('#smSendModal').style.display = 'none';
}

async function confirmSmSend() {
  if (!requireTier('shopManage')) return;
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
    const shopOpt = allShopOptions.find(o => o.value === targetShopId);
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
  const openPortal = async (event, opener, fallbackMessage) => {
    const button = event.currentTarget;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = '正在打开...';
    try {
      const result = await opener();
      if (!result || result.success !== true) {
        showToast(result?.error || fallbackMessage, 3000, 'error');
      }
    } catch (error) {
      showToast(error?.message || fallbackMessage, 3000, 'error');
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  };
  $('#aoOpenMerchantBtn').addEventListener('click', event => {
    openPortal(event, () => window.electronAPI.openMerchantWorkspace(), '商家端页面打开失败');
  });
  $('#aoOpenCpBtn').addEventListener('click', event => {
    openPortal(event, () => window.electronAPI.openCpWorkspace(), 'CP 端页面打开失败');
  });
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

// ========== 打印出库模块 ==========
function initWmsPrintOutbound() {
  const openBtn = $('#wmsPrintOpenBtn');
  const refreshBtn = $('#wmsPrintRefreshBtn');
  const loginBtn = $('#wmsPrintLoginBtn');
  const statusEl = $('#wmsPrintStatus');
  const placeholder = $('#wmsPrintPlaceholder');
  const container = $('#wmsPrintWebviewContainer');

  if (!openBtn) return;

  const directPrintOrderInput = document.createElement('input');
  directPrintOrderInput.id = 'wmsDirectPrintOrderInput';
  directPrintOrderInput.type = 'text';
  directPrintOrderInput.autocomplete = 'off';
  directPrintOrderInput.placeholder = '输入订单号';
  directPrintOrderInput.style.cssText = 'margin-left:auto; width:210px; height:28px; padding:0 10px; border:1px solid #d9d9d9; border-radius:4px; font-size:12px;';
  const directPrintBtn = document.createElement('button');
  directPrintBtn.id = 'wmsDirectPrintBtn';
  directPrintBtn.className = 'btn btn-primary';
  directPrintBtn.style.cssText = 'padding:4px 12px; font-size:12px;';
  directPrintBtn.textContent = '打印订单';
  const directReprintBtn = document.createElement('button');
  directReprintBtn.id = 'wmsDirectReprintBtn';
  directReprintBtn.className = 'btn';
  directReprintBtn.style.cssText = 'padding:4px 12px; font-size:12px; color:#fff; background:#7b61c9; border-color:#7b61c9;';
  directReprintBtn.textContent = '通道补打';
  const directOutboundBtn = document.createElement('button');
  directOutboundBtn.id = 'wmsDirectOutboundBtn';
  directOutboundBtn.className = 'btn';
  directOutboundBtn.style.cssText = 'padding:4px 12px; font-size:12px; color:#fff; background:#e67e22; border-color:#e67e22;';
  directOutboundBtn.textContent = '快速发货';
  refreshBtn.style.marginLeft = '0';
  refreshBtn.parentElement.insertBefore(directPrintOrderInput, refreshBtn);
  refreshBtn.parentElement.insertBefore(directPrintBtn, refreshBtn);
  refreshBtn.parentElement.insertBefore(directReprintBtn, refreshBtn);
  refreshBtn.parentElement.insertBefore(directOutboundBtn, refreshBtn);

  const WMS_OUTBOUND_URL = 'https://unionwms.jdl.com/default';
  const WMS_OUTBOUND_HASH = '#/app-v/jwms-webview/outbound/orderProcess/orderProcessList';
  let webview = null;
  let webviewLoaded = false;
  let initialOutboundRoutePrepared = false;
  let initialOutboundRouteTimer = null;

  function clearInitialOutboundRouteTimer() {
    if (!initialOutboundRouteTimer) return;
    clearTimeout(initialOutboundRouteTimer);
    initialOutboundRouteTimer = null;
  }

  function scheduleInitialOutboundRoute(targetWebview) {
    if (initialOutboundRoutePrepared || initialOutboundRouteTimer) return;
    initialOutboundRouteTimer = setTimeout(async () => {
      initialOutboundRouteTimer = null;
      if (webview !== targetWebview) return;
      try {
        const prepared = await targetWebview.executeJavaScript(`
          (() => {
            const targetHash = ${JSON.stringify(WMS_OUTBOUND_HASH)};
            if (location.origin !== 'https://unionwms.jdl.com') return false;
            if (!/^\\\/(?:default|gray)(?:\\\/|$)/i.test(location.pathname)) return false;
            if (location.hash !== targetHash) location.hash = targetHash;
            return true;
          })()
        `);
        if (webview !== targetWebview || prepared !== true) return;
        initialOutboundRoutePrepared = true;
        webviewLoaded = true;
      } catch (error) {
        if (webview === targetWebview) {
          webviewLoaded = false;
          console.warn('[WMS 打印页面后台准备失败]', String(error?.message || '未知错误'));
        }
      }
    }, 1200);
  }

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
    if (webview) return;
    if (!result || (!result.loggedIn && !result.hasCookies) || !result.partition) {
      const temporarilyUnavailable = result?.restoreStatus === 'network_error' || result?.restoreStatus === 'service_error';
      statusEl.textContent = temporarilyUnavailable ? 'WMS 验证失败' : '未登录 WMS';
      statusEl.style.color = temporarilyUnavailable ? '#e67e22' : '#999';
      loginBtn.style.display = '';
      placeholder.textContent = temporarilyUnavailable
        ? 'WMS 验证失败，请稍后点击刷新重试'
        : '请先登录 WMS 后再加载出库处理页面';
      placeholder.style.display = 'flex';
      return;
    }

    statusEl.textContent = result.loggedIn ? '已登录 WMS' : '正在加载 WMS';
    statusEl.style.color = result.loggedIn ? '#27ae60' : '#e67e22';
    loginBtn.style.display = 'none';
    placeholder.style.display = 'none';

    webview = document.createElement('webview');
    webview.setAttribute('partition', result.partition);
    webview.setAttribute('src', WMS_OUTBOUND_URL);
    webview.style.cssText = 'width:100%; height:100%; border:none;';
    webview.setAttribute('allowpopups', '');
    webview.setAttribute('webpreferences', 'backgroundThrottling=false');
    container.appendChild(webview);
    const createdWebview = webview;

    const updatePrintAuthState = (url) => {
      const currentUrl = String(url || '');
      const isLoginPage = /passport\.jd\.com|unionwms\.jdl\.com\/(?:login|logon)(?:[/?#]|$)|sso\.jdl\./i.test(currentUrl);
      if (isLoginPage) {
        statusEl.textContent = '未登录 WMS';
        statusEl.style.color = '#999';
        loginBtn.style.display = '';
        placeholder.textContent = 'WMS 登录状态已失效，请重新登录';
        placeholder.style.display = 'flex';
        if (webview) {
          const expiredWebview = webview;
          webview = null;
          webviewLoaded = false;
          initialOutboundRoutePrepared = false;
          clearInitialOutboundRouteTimer();
          setTimeout(() => expiredWebview.remove(), 0);
        }
        return;
      }
      if (/unionwms\.jdl\.com\/(?:default|gray)(?:[/?#]|$)/i.test(currentUrl)) {
        statusEl.textContent = '已登录 WMS';
        statusEl.style.color = '#27ae60';
        loginBtn.style.display = 'none';
        placeholder.style.display = 'none';
      }
    };

    webview.addEventListener('did-finish-load', () => {
      if (webview !== createdWebview) return;
      const currentUrl = createdWebview.getURL();
      webviewLoaded = currentUrl.includes('/outbound/orderProcess/orderProcessList');
      updatePrintAuthState(currentUrl);
      scheduleInitialOutboundRoute(createdWebview);
    });
    webview.addEventListener('did-navigate', (event) => updatePrintAuthState(event.url));
    webview.addEventListener('did-navigate-in-page', (event) => {
      updatePrintAuthState(event.url);
      if (String(event.url || '').includes('/outbound/orderProcess/orderProcessList')) {
        initialOutboundRoutePrepared = true;
        webviewLoaded = true;
      }
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
    const result = await window.electronAPI.openWmsLogin(cred || {});
    if (result?.success === false) showToast(result.error || 'WMS 登录窗口打开失败');
  });

  // 刷新按钮
  refreshBtn.addEventListener('click', () => {
    if (webview && webviewLoaded) {
      initialOutboundRoutePrepared = false;
      clearInitialOutboundRouteTimer();
      webview.reload();
    } else {
      if (webview) {
        webview.remove();
        webview = null;
        webviewLoaded = false;
        initialOutboundRoutePrepared = false;
        clearInitialOutboundRouteTimer();
      }
      loadWebview();
    }
  });

  directPrintBtn?.addEventListener('click', async () => {
    if (!requireTier('wmsPrintOutbound')) return;
    if (!webview || !webviewLoaded) {
      showToast('请先加载打印出库页面', 3000, 'error');
      return;
    }
    const orderNo = String(directPrintOrderInput.value || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(orderNo)) {
      showToast('请输入正确的订单号', 3000, 'error');
      return;
    }

    directPrintBtn.disabled = true;
    directReprintBtn.disabled = true;
    directOutboundBtn.disabled = true;
    if (directPrintOrderInput) directPrintOrderInput.disabled = true;
    directPrintBtn.textContent = '正在查询...';
    statusEl.textContent = '正在准备打印';
    statusEl.style.color = '#e67e22';
    try {
      directPrintBtn.textContent = '正在打印...';
      const result = await window.electronAPI.executeWmsOutboundPrint({
        orderNo,
        printMode: 'print',
        webContentsId: webview.getWebContentsId()
      });
      if (!result || result.success !== true) {
        throw new Error(result?.error || 'WMS 未返回明确的打印结果');
      }
      showToast('订单已成功打印', 4000);
      statusEl.textContent = '打印成功';
      statusEl.style.color = '#27ae60';
    } catch (error) {
      console.error('[WMS 本机打印失败]', String(error?.message || '未知错误'));
      showToast(`打印失败：${error.message || '未知错误'}`, 6000, 'error');
      statusEl.textContent = '打印失败';
      statusEl.style.color = '#e74c3c';
    } finally {
      directPrintBtn.disabled = false;
      directReprintBtn.disabled = false;
      directOutboundBtn.disabled = false;
      if (directPrintOrderInput) directPrintOrderInput.disabled = false;
      directPrintBtn.textContent = '打印订单';
    }
  });

  directReprintBtn?.addEventListener('click', async () => {
    if (!requireTier('wmsPrintOutbound')) return;
    if (!webview || !webviewLoaded) {
      showToast('请先加载打印出库页面', 3000, 'error');
      return;
    }
    const orderNo = String(directPrintOrderInput.value || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(orderNo)) {
      showToast('请输入正确的订单号', 3000, 'error');
      return;
    }

    directPrintBtn.disabled = true;
    directReprintBtn.disabled = true;
    directOutboundBtn.disabled = true;
    directPrintOrderInput.disabled = true;
    directReprintBtn.textContent = '正在补打...';
    statusEl.textContent = '正在准备通道补打';
    statusEl.style.color = '#7b61c9';
    try {
      const result = await window.electronAPI.executeWmsOutboundPrint({
        orderNo,
        printMode: 'reprint',
        webContentsId: webview.getWebContentsId()
      });
      if (!result || result.success !== true) {
        throw new Error(result?.error || 'WMS 未返回明确的补打结果');
      }
      showToast('订单已成功通道补打', 4000);
      statusEl.textContent = '补打成功';
      statusEl.style.color = '#27ae60';
    } catch (error) {
      console.error('[WMS 本机通道补打失败]', String(error?.message || '未知错误'));
      showToast('补打失败：' + String(error?.message || '未知错误'), 7000, 'error');
      statusEl.textContent = '补打失败';
      statusEl.style.color = '#e74c3c';
    } finally {
      directPrintBtn.disabled = false;
      directReprintBtn.disabled = false;
      directOutboundBtn.disabled = false;
      directPrintOrderInput.disabled = false;
      directReprintBtn.textContent = '通道补打';
    }
  });

  directOutboundBtn?.addEventListener('click', async () => {
    if (!requireTier('wmsPrintOutbound')) return;
    if (!webview || !webviewLoaded) {
      showToast('请先加载打印出库页面', 3000, 'error');
      return;
    }
    const orderNo = String(directPrintOrderInput.value || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(orderNo)) {
      showToast('请输入正确的订单号', 3000, 'error');
      return;
    }
    if (!window.confirm('确认将订单 ' + orderNo + ' 在当前 WMS 仓库执行发货？')) {
      return;
    }

    directPrintBtn.disabled = true;
    directReprintBtn.disabled = true;
    directOutboundBtn.disabled = true;
    directPrintOrderInput.disabled = true;
    directOutboundBtn.textContent = '正在发货...';
    statusEl.textContent = '正在校验并发货';
    statusEl.style.color = '#e67e22';
    try {
      const result = await window.electronAPI.outboundWmsOrder({ orderNo });
      if (!result || result.success !== true) {
        throw new Error(result?.error || 'WMS 未返回明确的发货结果');
      }
      showToast('订单已成功发货', 4000);
      statusEl.textContent = '发货成功';
      statusEl.style.color = '#27ae60';
    } catch (error) {
      console.error('[WMS 本机发货失败]', String(error?.message || '未知错误'));
      showToast('发货失败：' + String(error?.message || '未知错误'), 7000, 'error');
      statusEl.textContent = '发货失败';
      statusEl.style.color = '#e74c3c';
    } finally {
      directPrintBtn.disabled = false;
      directReprintBtn.disabled = false;
      directOutboundBtn.disabled = false;
      directPrintOrderInput.disabled = false;
      directOutboundBtn.textContent = '快速发货';
    }
  });

  directPrintOrderInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !directPrintBtn.disabled) directPrintBtn.click();
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
    placeholder.textContent = '正在后台准备打印出库页面';
    if (!webview) {
      loadWebview();
    }
  });

  // 主界面初始化后提前加载同一 WMS webview，打印指令无需用户先点菜单。
  loadWebview();
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
