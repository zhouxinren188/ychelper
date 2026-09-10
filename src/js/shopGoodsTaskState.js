'use strict';

(function exposeShopGoodsTaskState(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.shopGoodsTaskState = api;
  if (root && root.document && typeof api.mountTaskUi === 'function') {
    api.mountTaskUi(root.document);
  }
})(typeof window !== 'undefined' ? window : globalThis, function createShopGoodsTaskState() {
  const VALID_STATUSES = new Set(['queued', 'collecting', 'complete', 'failed']);
  const VALID_PUBLISH_STATUSES = new Set(['unpublished', 'publishing', 'published', 'publish_failed', 'skipped']);
  const VALID_EXECUTION_STATUSES = new Set(['not_started', 'queued', 'running', 'success', 'partial', 'failed']);

  function normalizeText(value, fallback = '') {
    const text = String(value == null ? '' : value).trim();
    return text || fallback;
  }

  function createTaskId(now = Date.now(), random = Math.random) {
    const suffix = Math.floor(random() * 0xFFFFFF).toString(36).padStart(5, '0');
    return `sm_${Number(now).toString(36)}_${suffix}`;
  }

  function normalizeTask(task = {}) {
    const status = VALID_STATUSES.has(task.status) ? task.status : 'queued';
    const normalizedStatus = status === 'collecting' ? 'queued' : status;
    const params = task.params && typeof task.params === 'object' ? task.params : {};
    const progress = task.progress && typeof task.progress === 'object' ? task.progress : {};
    const publishConfig = task.publishConfig && typeof task.publishConfig === 'object'
      ? task.publishConfig
      : {};
    const publishStatus = VALID_PUBLISH_STATUSES.has(task.publishStatus)
      ? task.publishStatus
      : 'unpublished';
    const normalizedPublishStatus = publishStatus === 'publishing' ? 'publish_failed' : publishStatus;
    const executionStatus = VALID_EXECUTION_STATUSES.has(task.executionStatus)
      ? task.executionStatus
      : 'not_started';
    return {
      id: normalizeText(task.id),
      accountId: normalizeText(task.accountId),
      shopName: normalizeText(task.shopName, '未命名店铺'),
      source: task.source === 'auto' ? 'auto' : 'manual',
      automationRunDate: normalizeText(task.automationRunDate),
      createdAt: normalizeText(task.createdAt, new Date().toISOString()),
      updatedAt: normalizeText(task.updatedAt, task.createdAt || new Date().toISOString()),
      status: normalizedStatus,
      params: {
        accountId: normalizeText(params.accountId || task.accountId),
        dateFrom: normalizeText(params.dateFrom),
        dateTo: normalizeText(params.dateTo),
        priceMin: normalizeText(params.priceMin),
        priceMax: normalizeText(params.priceMax),
        goodsStatus: normalizeText(params.goodsStatus, '售卖中')
      },
      qtyMode: normalizeText(task.qtyMode, '全部'),
      qtyCount: Math.max(1, Number.parseInt(task.qtyCount, 10) || 10),
      progress: {
        stage: normalizeText(progress.stage, normalizedStatus === 'complete' ? 'complete' : 'queued'),
        pageNum: Math.max(0, Number(progress.pageNum) || 0),
        totalPages: Math.max(0, Number(progress.totalPages) || 0),
        completed: Math.max(0, Number(progress.completed) || 0),
        total: Math.max(0, Number(progress.total) || 0),
        loadedSkuTotal: Math.max(0, Number(progress.loadedSkuTotal) || 0),
        message: normalizeText(progress.message)
      },
      resultSpuCount: Math.max(0, Number(task.resultSpuCount) || 0),
      resultSkuCount: Math.max(0, Number(task.resultSkuCount) || 0),
      error: normalizeText(task.error),
      resultSaved: Boolean(task.resultSaved),
      publishStatus: normalizedPublishStatus,
      publishConfig: {
        modeName: normalizeText(publishConfig.modeName),
        targetShopId: normalizeText(publishConfig.targetShopId),
        targetWarehouseId: normalizeText(publishConfig.targetWarehouseId)
      },
      publishError: normalizeText(task.publishError),
      publishedAt: normalizeText(task.publishedAt),
      publishedTaskCount: Math.max(0, Number(task.publishedTaskCount) || 0),
      executionStatus
    };
  }

  function createTask(input = {}, options = {}) {
    const now = options.now == null ? Date.now() : Number(options.now);
    const createdAt = new Date(now).toISOString();
    return normalizeTask({
      id: input.id || createTaskId(now, options.random),
      accountId: input.accountId,
      shopName: input.shopName,
      source: input.source,
      automationRunDate: input.automationRunDate,
      createdAt,
      updatedAt: createdAt,
      status: 'queued',
      params: input.params,
      qtyMode: input.qtyMode,
      qtyCount: input.qtyCount,
      publishConfig: input.publishConfig,
      progress: { stage: 'queued' }
    });
  }

  function normalizeTasks(tasks) {
    return (Array.isArray(tasks) ? tasks : [])
      .map(normalizeTask)
      .filter(task => task.id && task.accountId)
      .slice(-100);
  }

  function applyProgress(task, progress = {}) {
    if (!task || typeof task !== 'object') return task;
    task.progress = {
      stage: normalizeText(progress.stage, task.progress?.stage || 'collecting'),
      pageNum: Math.max(0, Number(progress.pageNum) || 0),
      totalPages: Math.max(0, Number(progress.totalPages) || 0),
      completed: Math.max(0, Number(progress.completed) || 0),
      total: Math.max(0, Number(progress.total) || 0),
      loadedSkuTotal: Math.max(0, Number(progress.loadedSkuTotal ?? progress.skuTotal) || 0),
      message: normalizeText(progress.message)
    };
    task.updatedAt = new Date().toISOString();
    return task;
  }

  function formatDateTime(value) {
    return normalizeText(value).replace('T', ' ');
  }

  function formatTimeRange(task) {
    const from = formatDateTime(task?.params?.dateFrom);
    const to = formatDateTime(task?.params?.dateTo);
    return from && to ? `${from} 至 ${to}` : '不限时间';
  }

  function formatPriceRange(task) {
    const min = normalizeText(task?.params?.priceMin);
    const max = normalizeText(task?.params?.priceMax);
    if (min && max) return `¥${min} 至 ¥${max}`;
    if (min) return `¥${min} 起`;
    if (max) return `不高于 ¥${max}`;
    return '不限价格';
  }

  function formatQtyRule(task) {
    const mode = normalizeText(task?.qtyMode, '全部');
    const count = Math.max(1, Number.parseInt(task?.qtyCount, 10) || 10);
    if (mode === '前N个') return `每个SPU前${count}个SKU`;
    if (mode === 'N个') return `每个SPU随机${count}个SKU`;
    if (mode === '全部') return '每个SPU全部SKU';
    return `每个SPU取${mode}`;
  }

  function formatConfiguration(task) {
    return `${formatPriceRange(task)} · ${normalizeText(task?.params?.goodsStatus, '售卖中')} · ${formatQtyRule(task)}`;
  }

  function getStatusLabel(status) {
    if (status === 'collecting') return '采集中';
    if (status === 'complete') return '采集完成';
    if (status === 'failed') return '采集失败';
    return '排队中';
  }

  function getProgressText(task) {
    if (!task) return '';
    if (task.status === 'complete') {
      return `${task.resultSpuCount || 0} SPU · ${task.resultSkuCount || 0} SKU`;
    }
    if (task.status === 'failed') return task.error || '请重试';
    if (task.status === 'queued') return '等待开始采集';
    const progress = task.progress || {};
    if (progress.stage === 'rate-limit') return progress.message || '请求过快，正在等待后重试';
    if (progress.totalPages > 0) {
      const currentPage = Math.max(1, progress.pageNum || 1);
      return `${Math.min(currentPage, progress.totalPages)}/${progress.totalPages} 页 · ${progress.completed || 0}/${progress.total || 0} SPU`;
    }
    return progress.message || '正在准备查询';
  }

  function getPublishStatusLabel(task) {
    if (task?.executionStatus === 'running') return '执行中';
    if (task?.executionStatus === 'success') return '已完成';
    if (task?.executionStatus === 'partial') return '部分失败';
    if (task?.executionStatus === 'failed') return '执行失败';
    if (task?.executionStatus === 'queued') return '待执行';
    if (task?.publishStatus === 'publishing') return '发布中';
    if (task?.publishStatus === 'published') return '已发布';
    if (task?.publishStatus === 'publish_failed') return '发布失败';
    if (task?.publishStatus === 'skipped') return '无需发布';
    return '未发布';
  }

  function getPublishDetail(task) {
    if (task?.executionStatus === 'running') return '正在执行打标任务';
    if (task?.executionStatus === 'success') return '打标任务已全部完成';
    if (task?.executionStatus === 'partial') return '部分打标任务失败';
    if (task?.executionStatus === 'failed') return '打标任务执行失败';
    if (task?.executionStatus === 'queued') return '等待统一执行';
    if (task?.publishStatus === 'skipped') return '本次没有符合条件的SKU';
    if (task?.publishStatus === 'published') {
      return task.publishedTaskCount > 1 ? `已创建${task.publishedTaskCount}条任务` : '已创建打标任务';
    }
    if (task?.publishStatus === 'publish_failed') return task.publishError || '可重新发布';
    if (task?.publishStatus === 'publishing') return '正在创建打标任务';
    return '等待选择';
  }

  function getLocalDateKey(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function getAutomationDueState(settings = {}, nowValue = new Date(), eligibleSinceValue = 0) {
    const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
    if (!settings.enabled || Number.isNaN(now.getTime())) return { due: false, runDate: '' };
    const runDate = getLocalDateKey(now);
    if (normalizeText(settings.lastRunDate) === runDate) return { due: false, runDate };
    const parts = normalizeText(settings.startTime, '02:00').split(':').map(Number);
    const scheduledAt = new Date(now);
    scheduledAt.setHours(parts[0] || 0, parts[1] || 0, 0, 0);
    if (now < scheduledAt) return { due: false, runDate, scheduledAt };
    const activatedAtText = normalizeText(settings.scheduleActivatedAt);
    const activatedAt = activatedAtText ? new Date(activatedAtText) : null;
    const activatedAfterSchedule = activatedAt
      && !Number.isNaN(activatedAt.getTime())
      && activatedAt > scheduledAt;
    if (activatedAfterSchedule) {
      return { due: false, runDate, scheduledAt };
    }
    const eligibleSince = new Date(eligibleSinceValue || 0);
    const startedBeforeSchedule = !Number.isNaN(eligibleSince.getTime()) && eligibleSince <= scheduledAt;
    return {
      due: settings.catchUpMissed !== false || startedBeforeSchedule,
      runDate,
      scheduledAt
    };
  }

  function normalizeShopMatchName(value) {
    return normalizeText(value)
      .replace(/[（(][^）)]*[）)]\s*$/, '')
      .replace(/[\s\-—_]/g, '')
      .toLowerCase();
  }

  function findMatchingShopValue(sourceName, options = []) {
    const normalizedSource = normalizeShopMatchName(sourceName);
    if (!normalizedSource) return '';
    const match = (Array.isArray(options) ? options : []).find(option =>
      normalizeShopMatchName(option?.label) === normalizedSource
    );
    return normalizeText(match?.value);
  }

  function resolveWarehouseValue({ preferredId = '', defaultId = '', options = [] } = {}) {
    const values = (Array.isArray(options) ? options : [])
      .map(option => normalizeText(option?.value))
      .filter(Boolean);
    const preferred = normalizeText(preferredId);
    if (preferred && values.includes(preferred)) return preferred;
    const configuredDefault = normalizeText(defaultId);
    if (configuredDefault && values.includes(configuredDefault)) return configuredDefault;
    return values.length === 1 ? values[0] : '';
  }

  function toJdHighResolutionImageUrl(value) {
    const raw = normalizeText(value);
    if (!raw) return '';
    const absolute = raw.startsWith('//') ? `https:${raw}` : raw;
    try {
      const url = new URL(absolute);
      const hostname = url.hostname.toLowerCase();
      if (hostname !== '360buyimg.com' && !hostname.endsWith('.360buyimg.com')) return absolute;

      const sizedJfsMarker = url.pathname.toLowerCase().indexOf('_jfs/');
      const plainJfsMarker = url.pathname.toLowerCase().indexOf('/jfs/');
      if (sizedJfsMarker >= 0) {
        url.pathname = `/n0/jfs/${url.pathname.slice(sizedJfsMarker + 5)}`;
      } else if (plainJfsMarker >= 0) {
        url.pathname = `/n0${url.pathname.slice(plainJfsMarker)}`;
      }
      return url.toString();
    } catch (error) {
      return absolute;
    }
  }

  function toPersistedTask(task) {
    return normalizeTask(task);
  }

  function mountDefaultWarehouseUi(doc) {
    if (!doc || doc.getElementById('smDefaultWarehouse')) return;
    const autoSendInput = doc.querySelector('input[name="smAutoSend"]');
    const autoSendGroup = autoSendInput && autoSendInput.closest('.form-group-modal');
    if (!autoSendGroup || !autoSendGroup.parentNode) return;

    const group = doc.createElement('div');
    group.className = 'form-group-modal sm-default-warehouse-group';
    group.innerHTML = `
      <label for="smDefaultWarehouse">默认仓库 <span>（发送打标时自动选择）</span></label>
      <select id="smDefaultWarehouse" class="sm-default-warehouse-select">
        <option value="">不设置默认仓库</option>
      </select>`;
    autoSendGroup.parentNode.insertBefore(group, autoSendGroup);
  }

  function mountAutomationUi(doc) {
    if (!doc) return;

    const headerStats = doc.querySelector('#page-shopManage .ao-header-stats');
    if (headerStats && !doc.getElementById('smAutomationEntry')) {
      const entry = doc.createElement('span');
      entry.className = 'sm-automation-entry is-off';
      entry.id = 'smAutomationEntry';
      entry.innerHTML = `
        <span class="sm-automation-dot" aria-hidden="true"></span>
        <span id="smAutomationStatus">自动打标：已关闭</span>
        <button type="button" id="smAutomationSettingsBtn">设置</button>`;
      headerStats.insertBefore(entry, headerStats.firstChild);
    }

    const autoSendInput = doc.querySelector('input[name="smAutoSend"]');
    const autoSendGroup = autoSendInput && autoSendInput.closest('.form-group-modal');
    if (autoSendGroup && autoSendGroup.parentNode && !doc.getElementById('smAutoLabelConfig')) {
      const config = doc.createElement('div');
      config.className = 'sm-auto-label-config';
      config.id = 'smAutoLabelConfig';
      config.hidden = true;
      config.innerHTML = `
        <div class="sm-auto-label-config-title">
          <strong>自动打标配置</strong>
          <span>首次按设定起点采集，之后从该店铺上次成功时间继续</span>
        </div>
        <div class="sm-auto-label-config-grid">
          <label class="sm-auto-config-field">
            <span>首次采集起点</span>
            <input type="datetime-local" id="smAutoFirstRunFrom" step="60" />
          </label>
          <label class="sm-auto-config-field">
            <span>快捷模式</span>
            <select id="smAutoMode"><option value="">请选择模式</option></select>
          </label>
          <label class="sm-auto-config-field">
            <span>最低售价</span>
            <input type="number" id="smAutoPriceMin" min="0" step="0.01" placeholder="不限" />
          </label>
          <label class="sm-auto-config-field">
            <span>最高售价</span>
            <input type="number" id="smAutoPriceMax" min="0" step="0.01" placeholder="不限" />
          </label>
          <label class="sm-auto-config-field">
            <span>商品状态</span>
            <select id="smAutoGoodsStatus">
              <option value="售卖中">售卖中</option>
              <option value="全部商品">全部商品</option>
              <option value="已下架">已下架</option>
            </select>
          </label>
          <label class="sm-auto-config-field sm-auto-qty-field">
            <span>SKU提取方式</span>
            <span class="sm-auto-qty-controls">
              <select id="smAutoQtyMode">
                <option value="全部">全部SKU</option>
                <option value="第1个">SKU第1个</option>
                <option value="最后1个">SKU最后1个</option>
                <option value="最低价">最低价</option>
                <option value="最高价">最高价</option>
                <option value="前N个">SKU前N个</option>
                <option value="N个">随机N个</option>
              </select>
              <input type="number" id="smAutoQtyCount" min="1" value="10" title="SKU数量" />
            </span>
          </label>
          <label class="sm-auto-config-field">
            <span>目标店铺（商家端）</span>
            <select id="smAutoTargetShop"><option value="">登录后按店铺名称自动匹配</option></select>
          </label>
        </div>`;
      autoSendGroup.parentNode.insertBefore(config, autoSendGroup.nextSibling);
    }

    if (!doc.getElementById('smAutomationSettingsModal')) {
      const modal = doc.createElement('div');
      modal.className = 'modal-overlay workspace-centered';
      modal.id = 'smAutomationSettingsModal';
      modal.style.display = 'none';
      modal.innerHTML = `
        <div class="modal modal-sm sm-automation-settings-modal">
          <div class="modal-header">
            <span>自动打标设置</span>
            <button type="button" class="modal-close" id="smAutomationSettingsClose">&times;</button>
          </div>
          <div class="modal-body">
            <label class="sm-global-auto-switch">
              <span><strong>启用自动打标</strong><small>到达全局时间后，启用的店铺按顺序排队</small></span>
              <input type="checkbox" id="smAutomationEnabled" />
              <i aria-hidden="true"></i>
            </label>
            <label class="sm-global-auto-row">
              <span>每日开始时间</span>
              <input type="time" id="smAutomationStartTime" step="60" value="02:00" />
            </label>
            <label class="sm-global-auto-check">
              <input type="checkbox" id="smAutomationCatchUp" checked />
              <span>当天错过执行时间后，软件启动时自动补跑</span>
            </label>
            <div class="sm-global-auto-summary">
              当前参与店铺：<strong id="smAutomationShopCount">0</strong> 家
            </div>
            <div class="sm-global-auto-preview-note">保存启用后，到达开始时间会先逐店采集，再逐店创建任务，最后统一启动执行。</div>
            <div class="modal-actions">
              <button type="button" class="btn" id="smAutomationSettingsCancel">取消</button>
              <button type="button" class="btn btn-primary" id="smAutomationSettingsSave">保存设置</button>
            </div>
          </div>
        </div>`;
      doc.body.appendChild(modal);
    }
  }

  function mountTaskUi(doc) {
    if (!doc) return;
    mountDefaultWarehouseUi(doc);
    mountAutomationUi(doc);
    if (doc.getElementById('smCreateTaskBtn')) return;
    const queryButton = doc.getElementById('smQueryBtn');
    const queryGroup = queryButton && queryButton.closest('.sm-filter-query-action');
    const panel = doc.querySelector('#page-shopManage .sm-product-panel');
    const header = panel && panel.querySelector('.sm-product-panel-header');
    const title = header && header.querySelector('.sm-product-panel-title');
    const summary = header && header.querySelector('.sm-product-panel-summary');
    const goodsPanel = panel && panel.querySelector('.sm-product-table-wrapper');
    if (!queryButton || !queryGroup || !panel || !header || !title || !summary || !goodsPanel) return;

    const createButton = doc.createElement('button');
    createButton.className = 'btn sm-action-btn';
    createButton.id = 'smCreateTaskBtn';
    createButton.disabled = true;
    createButton.textContent = '创建任务';
    queryGroup.appendChild(createButton);

    title.innerHTML = `
      <div class="sm-panel-tabs" role="tablist" aria-label="快速打标内容">
        <button type="button" class="sm-panel-tab is-active" id="smGoodsTab" role="tab"
                aria-selected="true" aria-controls="smGoodsPanel">商品列表</button>
        <button type="button" class="sm-panel-tab" id="smTasksTab" role="tab"
                aria-selected="false" aria-controls="smTasksPanel">
          任务列表 <span id="smTaskCount">0</span>
        </button>
      </div>
      <span class="sm-product-context" id="smProductContext" hidden></span>`;

    summary.id = 'smProductPanelSummary';
    const taskActions = doc.createElement('div');
    taskActions.className = 'sm-task-panel-actions';
    taskActions.id = 'smTaskPanelActions';
    taskActions.hidden = true;
    taskActions.innerHTML = `
      <button type="button" class="btn btn-sm sm-batch-publish-btn" id="smBatchPublishBtn" disabled>批量打标</button>
      <button type="button" class="btn btn-primary btn-sm" id="smStartTasksBtn" disabled>开始采集</button>`;
    header.appendChild(taskActions);

    goodsPanel.id = 'smGoodsPanel';
    goodsPanel.setAttribute('role', 'tabpanel');
    goodsPanel.setAttribute('aria-labelledby', 'smGoodsTab');

    const tasksPanel = doc.createElement('div');
    tasksPanel.className = 'sm-tasks-panel';
    tasksPanel.id = 'smTasksPanel';
    tasksPanel.setAttribute('role', 'tabpanel');
    tasksPanel.setAttribute('aria-labelledby', 'smTasksTab');
    tasksPanel.hidden = true;
    tasksPanel.innerHTML = `
      <div class="ao-table-wrapper sm-task-table-wrapper">
        <table class="ao-table sm-task-table">
          <thead>
            <tr>
              <th><input type="checkbox" id="smTaskSelectAll" aria-label="全选可发布任务" /></th>
              <th>序号</th>
              <th>店铺名称</th>
              <th>时间范围</th>
              <th>任务配置</th>
              <th>进度</th>
              <th>打标发布</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="smTaskTableBody">
            <tr class="wms-empty-row sm-task-empty-row">
              <td colspan="8" class="wms-empty-state sm-task-empty-state">
                <strong>还没有采集任务</strong>
                <span>设置店铺和筛选条件后，点击“创建任务”</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="sm-task-panel-note">任务按创建顺序串行采集</div>`;
    panel.appendChild(tasksPanel);

    const publishModal = doc.createElement('div');
    publishModal.className = 'modal-overlay workspace-centered';
    publishModal.id = 'smBatchPublishModal';
    publishModal.style.display = 'none';
    publishModal.innerHTML = `
      <div class="modal sm-batch-publish-modal">
        <div class="modal-header">
          <span>批量打标</span>
          <button class="modal-close" id="smBatchPublishClose">&times;</button>
        </div>
        <div class="modal-body">
          <div class="sm-batch-publish-info" id="smBatchPublishInfo"></div>
          <div class="sm-batch-publish-table-wrap">
            <table class="sm-batch-publish-table">
              <thead>
                <tr>
                  <th>采集店铺</th>
                  <th>SKU</th>
                  <th>快捷模式</th>
                  <th>目标店铺（商家端）</th>
                  <th>目标仓库</th>
                </tr>
              </thead>
              <tbody id="smBatchPublishRows"></tbody>
            </table>
          </div>
          <div class="modal-actions">
            <button class="btn" id="smBatchPublishCancel">取消</button>
            <button class="btn btn-primary" id="smBatchPublishConfirm">确认逐个发布</button>
          </div>
        </div>
      </div>`;
    doc.body.appendChild(publishModal);

    if (!doc.getElementById('smTaskStyles')) {
      const styleLink = doc.createElement('link');
      styleLink.id = 'smTaskStyles';
      styleLink.rel = 'stylesheet';
      styleLink.href = 'css/shop-goods-tasks.css';
      doc.head.appendChild(styleLink);
    }
  }

  return {
    applyProgress,
    createTask,
    createTaskId,
    formatConfiguration,
    formatQtyRule,
    formatTimeRange,
    findMatchingShopValue,
    getAutomationDueState,
    getLocalDateKey,
    getProgressText,
    getPublishDetail,
    getPublishStatusLabel,
    getStatusLabel,
    mountTaskUi,
    normalizeShopMatchName,
    normalizeTask,
    normalizeTasks,
    resolveWarehouseValue,
    toJdHighResolutionImageUrl,
    toPersistedTask
  };
});
