'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { getMachineCodePendingStatus, OrderCommandRuntime } = require('../order-command-runtime');

const rootDir = path.join(__dirname, '..');
let state = null;
const runtime = new OrderCommandRuntime({
  machineCode: 'YC-7F3K-92MX',
  loadState: () => state,
  saveState: next => { state = JSON.parse(JSON.stringify(next)); }
});

const status = runtime.getStatus();
assert.strictEqual(status.protocol_version, '1.0');
assert.strictEqual(status.generated, true);
assert.strictEqual(status.machine_code, 'YC-7F3K-92MX');
assert.strictEqual(status.online, false);
assert.deepStrictEqual(status.transport, {
  enabled: false,
  state: 'disabled',
  reason: 'central_service_not_configured'
});
assert.strictEqual(Object.prototype.hasOwnProperty.call(status.transport, 'url'), false);
assert.strictEqual(status.capabilities.length, 6);
assert.strictEqual(status.capabilities.every(item => item.enabled === false), true);

const pendingStatus = getMachineCodePendingStatus();
assert.strictEqual(pendingStatus.generated, false);
assert.strictEqual(pendingStatus.machine_code, '');
assert.strictEqual(pendingStatus.transport.reason, 'machine_code_not_generated');
assert.strictEqual(pendingStatus.capabilities.length, 6);
assert.strictEqual(pendingStatus.capabilities.every(item => item.enabled === false), true);

const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
for (const runtimeFile of [
  'machine-code.js',
  'order-command-protocol.js',
  'order-command-executor.js',
  'order-exception-adapters.js',
  'order-exception-snapshot-store.js',
  'warehouse-order-adapter.js',
  'warehouse-order-command-adapters.js',
  'order-control-plane-protocol.js',
  'order-control-plane-client.js',
  'order-control-plane-runner.js',
  'order-control-plane-worker.js',
  'order-command-runtime.js'
]) {
  assert.strictEqual(packageJson.build.files.includes(runtimeFile), true, `构建文件清单缺少 ${runtimeFile}`);
}

const preloadSource = fs.readFileSync(path.join(rootDir, 'preload.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(rootDir, 'main.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(rootDir, 'src', 'index.html'), 'utf8');
const rendererSource = fs.readFileSync(path.join(rootDir, 'src', 'js', 'renderer.js'), 'utf8');
const contractSource = fs.readFileSync(path.join(rootDir, 'docs', 'dianxiaoer-order-command-contract.md'), 'utf8');
assert.match(preloadSource, /getMachineCode:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('get-machine-code'\)/);
assert.match(preloadSource, /generateMachineCode:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('generate-machine-code'\)/);
assert.match(preloadSource, /getOrderCommandStatus:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('get-order-command-status'\)/);
assert.doesNotMatch(preloadSource, /enrollOrderExecutor/);
assert.match(mainSource, /ipcMain\.handle\('get-machine-code'/);
assert.match(mainSource, /ipcMain\.handle\('generate-machine-code'/);
assert.match(mainSource, /ipcMain\.handle\('get-order-command-status'/);
assert.doesNotMatch(mainSource, /ipcMain\.handle\('enroll-order-executor'/);
assert.match(
  mainSource,
  /const CLOUD_ORDER_SERVICE_BASE_URL = 'https:\/\/150\.158\.54\.108:3443'/,
  '订单执行端必须固定连接受信任 HTTPS 服务，不得保持禁用或使用动态地址'
);
assert.match(mainSource, /new OrderControlPlaneClient\(/);
assert.match(mainSource, /new OrderControlPlaneRunner\(/);
assert.match(mainSource, /new OrderControlPlaneWorker\(/);
assert.doesNotMatch(mainSource, /data\.orderExecutorCredentials/);
assert.match(mainSource, /function initializeOrderCommandRuntime\(accountIdentity/);
assert.match(mainSource, /getMachineCodeAccountKey\(accountIdentity\)/);
assert.match(mainSource, /data\.machineCodeRecords/);
assert.match(mainSource, /data\.orderCommandStates/);
assert.match(mainSource, /activateOrderCommandRuntime\(jdUsername\)/);
assert.match(mainSource, /initializeOrderCommandRuntime\(orderCommandAccountIdentity, \{ generate: true \}\)/);
assert.match(mainSource, /registerExceptionOrderAdapters\(orderCommandRuntime\.executor/);
assert.match(mainSource, /registerWarehouseOrderCheckAdapter\(orderCommandRuntime\.executor/);
assert.doesNotMatch(mainSource, /exceptionOrderReferenceResolver/);
assert.match(mainSource, /new ExceptionSnapshotStore\(/);
assert.match(mainSource, /data\.exceptionOrderSnapshotStates/);
assert.doesNotMatch(mainSource, /initializeOrderCommandRuntime\(\);/);
assert.match(htmlSource, /data-page="machineCode">机器码</);
assert.match(htmlSource, /id="page-machineCode"/);
assert.match(htmlSource, /id="machineCodeGenerateBtn">生成机器码/);
assert.match(htmlSource, /id="machineCodeGeneratedState" hidden/);
assert.match(htmlSource, /机器码仅在您点击“生成机器码”后创建/);
assert.match(htmlSource, /本机主板信息、Windows 稳定设备信息与当前云仓助手账号/);
assert.match(htmlSource, /相同设备的不同账号、相同账号的不同设备都会得到不同机器码/);
assert.match(htmlSource, /主账号及其已授权子账号的云仓订单任务都可定向到这里/);
assert.match(rendererSource, /navigator\.clipboard\.writeText\(currentMachineCode\)/);
assert.match(rendererSource, /window\.electronAPI\.generateMachineCode\(\)/);
assert.match(
  htmlSource,
  /<script src="js\/machineStatusRefresh\.js"><\/script>\s*<script src="js\/renderer\.js"><\/script>/,
  '机器码状态刷新模块必须先于 renderer.js 加载'
);
assert.match(rendererSource, /createMachineStatusRefreshController\(/);
assert.match(rendererSource, /document\.addEventListener\('visibilitychange', syncStatusRefresh\)/);
assert.doesNotMatch(rendererSource, /machineEnrollmentCode|enrollOrderExecutor/);
assert.match(contractSource, /绑定单位是“店小二网店管家主账号体系”/);
assert.match(contractSource, /同一主账号及其已授权子账号可以共同使用/);
assert.match(contractSource, /店小二不部署任务中转服务/);
assert.match(contractSource, /不使用一次性登记码、短期 Token、独立心跳、任务租约/);

const htmlIds = [...htmlSource.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
const duplicateHtmlIds = [...new Set(htmlIds.filter((id, index) => htmlIds.indexOf(id) !== index))];
assert.deepStrictEqual(duplicateHtmlIds, [], `index.html 存在重复 id: ${duplicateHtmlIds.join(', ')}`);
for (const match of htmlSource.matchAll(/class="[^"]*nav-item[^"]*"[^>]*data-page="([^"]+)"/g)) {
  assert.match(htmlSource, new RegExp(`id="page-${match[1]}"`), `导航 ${match[1]} 缺少目标页面`);
}

const migratedSources = [
  'order-command-protocol.js',
  'order-command-executor.js',
  'order-command-runtime.js'
].map(file => fs.readFileSync(path.join(rootDir, file), 'utf8')).join('\n');
for (const forbiddenLegacyField of [
  'requester_device_id',
  'executor_instance_id',
  'sameDeviceVerified',
  'same_device_session_id',
  'same_device_verified'
]) {
  assert.strictEqual(migratedSources.includes(forbiddenLegacyField), false, `迁移模块仍包含旧同机字段 ${forbiddenLegacyField}`);
}

console.log('订单执行端运行时测试通过：服务连接显式受控、运行时文件和机器码页面接入完整');
