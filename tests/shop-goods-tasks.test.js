'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const {
  applyProgress,
  createTask,
  findMatchingShopValue,
  formatConfiguration,
  formatTimeRange,
  getAutomationDueState,
  getProgressText,
  getPublishDetail,
  getPublishStatusLabel,
  getStatusLabel,
  mountTaskUi,
  normalizeTask,
  normalizeTasks,
  resolveWarehouseValue,
  toJdHighResolutionImageUrl
} = require('../src/js/shopGoodsTaskState');

const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src', 'js', 'renderer.js'), 'utf8');
const taskUiSource = fs.readFileSync(path.join(root, 'src', 'js', 'shopGoodsTaskState.js'), 'utf8');
const taskStyles = fs.readFileSync(path.join(root, 'src', 'css', 'shop-goods-tasks.css'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

const task = createTask({
  accountId: 'shop-1',
  shopName: '测试店铺',
  params: {
    accountId: 'shop-1',
    dateFrom: '2026-09-01T00:00',
    dateTo: '2026-09-10T23:59',
    priceMin: '50',
    priceMax: '999',
    goodsStatus: '售卖中'
  },
  qtyMode: 'N个',
  qtyCount: 10
}, {
  now: Date.UTC(2026, 8, 10, 0, 0, 0),
  random: () => 0.5
});

assert.strictEqual(task.status, 'queued');
assert.strictEqual(task.accountId, 'shop-1');
assert.strictEqual(formatTimeRange(task), '2026-09-01 00:00 至 2026-09-10 23:59');
assert.strictEqual(
  formatConfiguration(task),
  '¥50 至 ¥999 · 售卖中 · 每个SPU随机10个SKU'
);
assert.strictEqual(getStatusLabel(task.status), '排队中');
assert.strictEqual(getProgressText(task), '等待开始采集');
assert.strictEqual(task.publishStatus, 'unpublished');
assert.strictEqual(getPublishStatusLabel(task), '未发布');
assert.strictEqual(getPublishDetail(task), '等待选择');
const autoTask = createTask({
  accountId: 'shop-auto',
  shopName: '自动店铺',
  source: 'auto',
  automationRunDate: '2026-09-10',
  params: { accountId: 'shop-auto' }
});
assert.strictEqual(autoTask.source, 'auto');
assert.strictEqual(autoTask.automationRunDate, '2026-09-10');
assert.strictEqual(getAutomationDueState({
  enabled: true,
  startTime: '02:00',
  catchUpMissed: true,
  scheduleActivatedAt: new Date(2026, 8, 9, 18, 0).toISOString()
}, new Date(2026, 8, 10, 2, 1), new Date(2026, 8, 10, 2, 1)).due, true,
'允许补跑时，超过每日时间必须触发当天批次');
assert.strictEqual(getAutomationDueState({
  enabled: true,
  startTime: '02:00',
  catchUpMissed: true,
  scheduleActivatedAt: new Date(2026, 8, 10, 3, 0).toISOString()
}, new Date(2026, 8, 10, 3, 1), new Date(2026, 8, 10, 1, 0)).due, false,
'当天设定时间已过后才开启，不得把当天误判为漏跑');
assert.strictEqual(getAutomationDueState({
  enabled: true,
  startTime: '02:00',
  catchUpMissed: true,
  scheduleActivatedAt: new Date(2026, 8, 10, 3, 0).toISOString()
}, new Date(2026, 8, 11, 2, 1), new Date(2026, 8, 10, 1, 0)).due, true,
'设定时间已过后开启的计划，应从下一天的设定时间开始执行');
assert.strictEqual(getAutomationDueState({
  enabled: true,
  startTime: '02:00',
  catchUpMissed: false
}, new Date(2026, 8, 10, 3, 0), new Date(2026, 8, 10, 2, 30)).due, false,
'关闭补跑且软件在执行时间后才启动时，当天不得补跑');
assert.strictEqual(getAutomationDueState({
  enabled: true,
  startTime: '02:00',
  catchUpMissed: false,
  lastRunDate: '2026-09-10'
}, new Date(2026, 8, 10, 3, 0), new Date(2026, 8, 10, 1, 0)).due, false,
'同一天已经建立批次后不得重复触发');
assert.strictEqual(findMatchingShopValue('测试店铺', [
  { value: 'target-1', label: '测试店铺（商家编号1）' },
  { value: 'target-2', label: '测试店铺旗舰店（商家编号2）' }
]), 'target-1', '源店铺名称必须精确匹配同名商家端店铺');
assert.strictEqual(findMatchingShopValue('测试店', [
  { value: 'target-1', label: '测试店铺（商家编号1）' }
]), '', '相似店名不得被自动误匹配');
const warehouseOptions = [
  { value: 'warehouse-1', label: '一号仓' },
  { value: 'warehouse-2', label: '二号仓' }
];
assert.strictEqual(resolveWarehouseValue({
  preferredId: 'warehouse-2',
  defaultId: 'warehouse-1',
  options: warehouseOptions
}), 'warehouse-2', '已确认过的发布配置优先于店铺默认仓库');
assert.strictEqual(resolveWarehouseValue({
  defaultId: 'warehouse-1',
  options: warehouseOptions
}), 'warehouse-1', '没有发布配置时必须采用源店铺默认仓库');
assert.strictEqual(resolveWarehouseValue({
  defaultId: 'missing',
  options: [{ value: 'warehouse-only', label: '唯一仓库' }]
}), 'warehouse-only', '默认仓库不可用但只有一个仓库时应安全选择唯一仓库');
assert.strictEqual(resolveWarehouseValue({ defaultId: 'missing', options: warehouseOptions }), '',
  '默认仓库不可用且有多个仓库时必须留给用户选择');
assert.strictEqual(
  toJdHighResolutionImageUrl('https://img10.360buyimg.com/n5/s54x54_jfs/t1/example.jpg'),
  'https://img10.360buyimg.com/n0/jfs/t1/example.jpg',
  '京东低清尺寸图片必须转换为高清预览地址'
);
assert.strictEqual(
  toJdHighResolutionImageUrl('//img10.360buyimg.com/n2/jfs/t1/example.jpg'),
  'https://img10.360buyimg.com/n0/jfs/t1/example.jpg',
  '京东协议相对图片必须转换为 HTTPS 高清预览地址'
);
assert.strictEqual(
  toJdHighResolutionImageUrl('https://example.com/image.jpg'),
  'https://example.com/image.jpg',
  '非京东图片地址不得被改写'
);

task.status = 'collecting';
applyProgress(task, {
  stage: 'page-complete',
  pageNum: 6,
  totalPages: 14,
  completed: 600,
  total: 1393,
  loadedSkuTotal: 3412
});
assert.strictEqual(getProgressText(task), '6/14 页 · 600/1393 SPU');

const restored = normalizeTasks([{ ...task, status: 'collecting' }]);
assert.strictEqual(restored[0].status, 'queued',
  '软件重启后未完成任务必须回到排队中，不能永久卡在采集中');

const interruptedPublish = normalizeTask({
  ...task,
  status: 'complete',
  publishStatus: 'publishing',
  publishConfig: {
    modeName: '入仓打标',
    targetShopId: 'target-shop-1',
    targetWarehouseId: 'warehouse-1'
  }
});
assert.strictEqual(interruptedPublish.publishStatus, 'publish_failed',
  '软件重启后中断的发布必须变为可重试的发布失败状态');
assert.strictEqual(interruptedPublish.publishConfig.targetShopId, 'target-shop-1');
assert.strictEqual(getPublishStatusLabel(interruptedPublish), '发布失败');

const dom = new JSDOM(`<!doctype html><html><head></head><body>
  <div id="smEditShopModal">
    <div class="modal-body">
      <div class="form-group-modal"><input type="radio" name="smAutoSend" value="0" /></div>
    </div>
  </div>
  <div id="page-shopManage">
    <div class="page-header"><div class="ao-header-stats"></div></div>
    <div class="sm-filter-query-action"><button id="smQueryBtn">查询商品</button></div>
    <div class="sm-product-panel">
      <div class="sm-product-panel-header">
        <div class="sm-product-panel-title"><span><strong>商品列表</strong></span></div>
        <div class="sm-product-panel-summary"></div>
      </div>
      <div class="sm-product-table-wrapper"></div>
    </div>
  </div>
</body></html>`);
mountTaskUi(dom.window.document);
assert(dom.window.document.getElementById('smCreateTaskBtn'),
  '任务界面挂载后必须出现创建任务按钮');
assert(dom.window.document.getElementById('smTaskTableBody'),
  '任务界面挂载后必须出现任务表格');
assert(dom.window.document.getElementById('smTaskSelectAll'),
  '任务列表必须提供可发布任务全选框');
assert(dom.window.document.getElementById('smBatchPublishBtn'),
  '任务列表必须提供批量打标按钮');
assert.strictEqual(dom.window.document.getElementById('smBatchPublishBtn').textContent, '批量打标',
  '批量操作按钮名称必须保持简洁');
assert(dom.window.document.querySelector('#smTasksPanel .sm-task-panel-note'),
  '串行采集说明必须放在任务列表下方');
assert(!dom.window.document.querySelector('#smTaskPanelActions > span'),
  '串行采集说明不得继续占用顶部操作区');
assert(dom.window.document.getElementById('smBatchPublishModal'),
  '批量发布必须提供逐店配置弹窗');
assert(dom.window.document.getElementById('smBatchPublishRows'),
  '批量发布弹窗必须提供逐店配置表格');
assert(dom.window.document.getElementById('smBatchPublishConfirm'),
  '批量发布弹窗必须提供确认入口');
assert(dom.window.document.getElementById('smDefaultWarehouse'),
  '编辑店铺弹窗必须提供默认仓库下拉框');
assert.match(indexHtml, /id="smShopUsername"[\s\S]*id="smShopPassword"[\s\S]*id="smShopName"/,
  '编辑店铺基础信息必须按登录账号、登录密码、店铺名称的顺序排列');
assert(dom.window.document.getElementById('smAutomationEntry'),
  '快速打标页头必须提供全局自动打标状态和设置入口');
assert(!dom.window.document.getElementById('smAutomationNext'),
  '快速打标页头不应展示下次执行时间');
assert(dom.window.document.getElementById('smAutomationSettingsModal'),
  '全局自动打标必须提供开关和每日开始时间设置弹窗');
assert(dom.window.document.getElementById('smAutomationStartTime'),
  '全局自动打标设置必须提供每日开始时间');
assert(dom.window.document.getElementById('smAutoLabelConfig'),
  '启用店铺自动打标时必须提供店铺独立任务配置');
assert(dom.window.document.getElementById('smAutoFirstRunFrom'),
  '店铺自动打标配置必须提供首次采集起点');
assert(dom.window.document.getElementById('smAutoTargetShop'),
  '店铺自动打标配置必须提供目标商家端店铺');
assert(!dom.window.document.getElementById('smAutoTargetShop').closest('label')
  .classList.contains('sm-auto-config-field-wide'),
  '目标店铺下拉框不得无必要地横跨整个配置区');
assert.strictEqual(
  dom.window.document.querySelector('.sm-default-warehouse-group').nextElementSibling
    .querySelector('input[name="smAutoSend"]').value,
  '0',
  '默认仓库设置必须放在自动发送设置之前'
);
assert(dom.window.document.getElementById('smTaskStyles'),
  '任务界面挂载后必须加载独立样式');
assert(!dom.window.document.querySelector('.sm-product-panel-copy'),
  '页签旁不得重复显示“商品列表”标题和说明');
assert(dom.window.document.getElementById('smProductContext'),
  '查看任务结果时必须保留精简的店铺来源提示');

assert.match(taskUiSource, /getElementById\('smQueryBtn'\)[\s\S]*createButton\.id = 'smCreateTaskBtn'/,
  '创建任务按钮必须紧跟查询商品按钮');
assert.match(taskUiSource, /id="smGoodsTab"[\s\S]*id="smTasksTab"/,
  '快速打标结果区必须提供商品列表和任务列表页签');
assert.match(taskUiSource, /id="smTaskTableBody"/,
  '任务列表必须有独立表格');
assert.match(taskUiSource, /店铺名称[\s\S]*时间范围[\s\S]*任务配置[\s\S]*进度[\s\S]*操作/,
  '任务列表必须展示确认过的五类信息');
assert.match(indexHtml, /src="js\/shopGoodsTaskState\.js"[\s\S]*src="js\/renderer\.js"/,
  '任务状态模块必须先于页面逻辑加载');

assert.match(renderer, /async function runSmTaskQueue\(taskIds\)/,
  '必须提供任务队列执行入口');
assert.match(renderer, /for \(const task of queue\) \{\s*await executeSmTask\(task\);\s*\}/,
  '多个店铺任务必须逐个串行执行');
assert.doesNotMatch(renderer, /Promise\.all\([^)]*executeSmTask/,
  '店铺任务不得并发执行');
assert.match(renderer, /async function publishSmLabelTasksSequentially\(configuredTasks\)/,
  '必须提供批量发布入口');
assert.match(renderer, /for \(const \{ task, targetMode \} of configuredTasks\) \{[\s\S]*enqueueLabelTasks\(/,
  '多个店铺的打标任务必须逐店串行创建并复用原有任务入口');
assert.doesNotMatch(renderer, /Promise\.all\([^)]*enqueueLabelTasks/,
  '多个店铺的打标任务不得并发创建');
assert.match(renderer, /mode\?\.config\?\.jdLabel && !mode\?\.config\?\.cancelJdLabel/,
  '批量发布只能选择实际执行入仓打标的快捷模式');
assert.match(renderer, /task\.publishStatus = 'publish_failed'/,
  '单店发布失败后必须保留可重试状态');
assert.match(renderer, /task\.publishStatus = 'published'[\s\S]*smSelectedTaskIds\.delete\(task\.id\)/,
  '成功发布的店铺必须标记完成并防止被默认重复发布');
assert.match(renderer, /smSendShop\.value = findSmMatchingTargetShop\(sourceShopName\)/,
  '单次发送必须按商品所属源店铺自动匹配目标店铺');
assert.match(renderer, /smSendWarehouse\.value = findSmDefaultWarehouse\(sourceAccount, warehouseOptions\)/,
  '单次发送必须采用源店铺预设的默认仓库');
assert.match(renderer, /sourceAccountMap\.get\(String\(task\.accountId\)\)[\s\S]*task\.publishConfig\?\.targetWarehouseId/,
  '批量发布必须按每条采集任务的源店铺采用默认仓库');
assert.match(renderer, /saveShopAccount\(\{[\s\S]*defaultWarehouseId[\s\S]*\}\)/,
  '编辑店铺保存时必须提交默认仓库');
assert.match(renderer, /async function saveSmAutomationSettings\(\)[\s\S]*saveAutoLabelSettings\(settings\)/,
  '全局自动打标开关和每日开始时间必须真实保存');
assert.match(renderer, /saveShopAccount\(\{[\s\S]*autoLabelConfig[\s\S]*\}\)/,
  '编辑店铺保存时必须提交独立的自动打标配置');
assert.doesNotMatch(renderer, /当前预览版不会自动执行/,
  '真实自动流程接通后不得继续显示预览提示');
assert.match(renderer, /async function runSmAutomaticLabelBatch\(runDate, options = \{\}\)/,
  '必须提供自动打标批次编排入口');
assert.match(renderer, /createSmAutomaticCollectionTasks[\s\S]*runSmTaskQueue\(queuedIds\)[\s\S]*publishSmAutomaticTasks[\s\S]*requestSmAutomaticExecution/,
  '自动批次必须先完成全部采集，再逐店创建任务，最后统一执行');
assert.match(renderer, /setInterval\(checkSmAutomationSchedule, SM_AUTOMATION_CHECK_INTERVAL_MS\)/,
  '自动打标必须按固定间隔检查每日触发条件');
assert.match(renderer, /!smAutomationSettings\.liveConfirmed/,
  '历史预览开关升级后必须由用户重新保存确认，不能直接执行真实任务');
assert.match(renderer, /task\.publishStatus = 'skipped'[\s\S]*saveSmAutomaticAccountCursor/,
  '零商品店铺不得创建打标任务，但必须推进成功采集游标');
assert.match(renderer, /await confirmEnqueuedLabelTasksPersisted\(result\);[\s\S]*task\.publishStatus = 'published'/,
  '打标任务安全保存完成后才能标记为已发布');
assert.match(renderer, /async function reconcileSmPersistedLabelTaskSources\(\)[\s\S]*sourceTask\.publishStatus = 'published'/,
  '启动时必须对账已落盘的打标任务，避免异常退出后重复发布');
assert.match(renderer, /executionWasStopped[\s\S]*lastRunStatus: 'paused'/,
  '用户主动停止后必须暂停自动批次，不能被定时检查立即重启');
assert.match(renderer, /data-preview-src="\$\{escapeHtml\(previewImageUrl\)\}"/,
  '商品悬浮预览必须使用独立的高清图片地址');
assert.match(renderer, /mouseenter[\s\S]*!zoom\.getAttribute\('src'\)[\s\S]*zoom\.dataset\.previewSrc/,
  '高清预览图必须在悬停时才加载，不能随商品列表批量请求');
assert.match(renderer, /zoom\.addEventListener\('error'[\s\S]*zoom\.dataset\.fallbackSrc/,
  '高清图片加载失败时必须回退原缩略图');
assert.match(renderer, /smActiveTaskId[\s\S]*api\.applyProgress\(task, progress\)/,
  '分页进度必须写入当前任务');
assert.match(renderer, /data-task-action="view"/,
  '采集完成任务必须提供查看商品操作');
assert.match(renderer, /data-task-action="retry"/,
  '采集失败任务必须提供重试操作');
assert.match(renderer, /smTaskResultCache\.set\(task\.id, \{ rawGoods, filteredGoods \}\)/,
  '每条任务的商品结果必须独立缓存');
assert.match(taskStyles, /\.sm-task-status\.is-collecting/,
  '采集中状态必须有明确视觉样式');
assert.match(taskStyles, /\.sm-tasks-panel\[hidden\]/,
  '商品列表和任务列表切换时不得同时占用页面空间');
assert.match(taskStyles, /\.sm-task-table:has\(\.sm-task-empty-row\)\s*\{[\s\S]*height:\s*100%/,
  '任务空状态必须填满列表剩余区域，不能与下方留白分成两块');
assert.match(taskStyles, /\.sm-task-panel-note\s*\{[\s\S]*text-align:\s*right/,
  '串行采集说明必须显示在任务列表底部');
assert.match(taskStyles, /\.modal-overlay\.workspace-centered\s*\{[\s\S]*padding-left:\s*130px/,
  '业务弹窗必须使用统一规则排除左侧栏后按右侧工作区居中');
for (const modalId of [
  'modeModal',
  'saveModal',
  'wmsConfirmModal',
  'stopTaskModal',
  'smShopModal',
  'smEditShopModal',
  'smSendModal',
  'deleteTaskModal'
]) {
  assert.match(indexHtml, new RegExp(`class="modal-overlay workspace-centered" id="${modalId}"`),
    `${modalId} 必须按右侧工作区居中`);
}
assert.strictEqual(
  (taskUiSource.match(/className = 'modal-overlay workspace-centered'/g) || []).length,
  2,
  '自动打标设置和批量发布弹窗必须按右侧工作区居中'
);
assert.match(taskStyles, /\.sm-product-table:has\(\.sm-empty-row\)[\s\S]*height:\s*100%/,
  '商品空状态必须填满列表剩余区域，不能与下方留白分成两块');
assert.doesNotMatch(renderer, /class="sm-empty-icon"/,
  '商品空状态应保持纯净，不显示孤立的装饰图标');
assert.doesNotMatch(indexHtml, /id="smQueryProgress"/,
  '查询进度不得再使用商品列表上方的独立进度条');
assert.match(renderer, /smInlineQueryState[\s\S]*商品会按批次直接显示在列表中/,
  '查询状态必须直接显示在商品列表内部');
assert.doesNotMatch(renderer, /smQueryProgressFill/,
  '渲染进程不得再依赖晃眼的进度条动画');
assert.match(taskStyles, /#smEditShopModal \.modal-sm\s*\{[\s\S]*width:\s*min\(520px/,
  '店铺编辑弹窗必须采用统一的中等宽度');
assert.doesNotMatch(taskStyles, /#smEditShopModal\.has-auto-label-config \.modal-sm/,
  '开启自动打标时不得突然改变店铺编辑弹窗宽度');
assert(taskStyles.includes('#page-shopManage .ao-header-stats'),
  '自动打标状态必须与右侧今日处理统计使用同一居中对齐容器');

[
  'getShopGoodsTasks',
  'saveShopGoodsTasks',
  'getLabelTasks',
  'saveLabelTasks',
  'saveShopGoodsTaskResult',
  'getShopGoodsTaskResult',
  'deleteShopGoodsTaskResult',
  'getAutoLabelSettings',
  'saveAutoLabelSettings',
  'saveAutoLabelRuntime',
  'saveShopAutoLabelRuntime'
].forEach(apiName => assert.match(preload, new RegExp(apiName + ':'),
  '预加载层必须暴露 ' + apiName));
assert.match(main, /SHOP_GOODS_TASK_RESULT_PREFIX = 'YCH-SM-TASK-V1:'/,
  '任务商品结果必须使用独立的加密文件格式');
assert.match(main, /safeStorage\.encryptString\(json\)/,
  '任务商品结果不得明文落盘');
assert.match(main, /ipcMain\.handle\('save-shop-goods-tasks'/,
  '主进程必须持久化任务元数据');
assert.match(main, /publishStatus:[\s\S]*publishConfig:[\s\S]*publishedTaskCount:/,
  '主进程必须持久化逐店发布状态和目标配置');
assert.match(main, /const defaultWarehouseId =[\s\S]*defaultWarehouseId[\s\S]*\};/,
  '主进程必须持久化店铺默认仓库且兼容旧记录');
assert.match(main, /ipcMain\.handle\('save-auto-label-settings'[\s\S]*storeSet\('autoLabelSettings'/,
  '主进程必须持久化全局自动打标设置');
assert.match(main, /ipcMain\.handle\('save-auto-label-runtime'/,
  '主进程必须独立保存自动批次运行状态');
assert.match(main, /ipcMain\.handle\('save-shop-auto-label-runtime'/,
  '主进程必须保存每个店铺的增量采集游标');
assert.match(main, /ipcMain\.handle\('save-label-tasks'/,
  '主进程必须持久化待执行的打标任务');
assert.match(main, /const autoLabelConfig =[\s\S]*autoLabelConfig[\s\S]*\};/,
  '主进程必须持久化每个店铺的自动打标配置且兼容旧记录');

console.log('店铺商品任务队列测试通过');
