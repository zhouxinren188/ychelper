'use strict';

const assert = require('assert');
const { createRuntimeUpdatePolicy } = require('../src/js/runtimeUpdatePolicy');

function isNewerVersion(remote, local) {
  const left = String(remote).split('.').map(Number);
  const right = String(local).split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

const policy = createRuntimeUpdatePolicy(isNewerVersion);
assert.strictEqual(policy.shouldDownload('1.0.93'), true);
assert.strictEqual(policy.register({
  version: '1.0.93',
  action: 'localPath',
  installerPath: 'update-1.0.93.exe'
}).accepted, true);
assert.strictEqual(policy.defer(), true);
assert.strictEqual(policy.getPending().deferred, true);
assert.strictEqual(policy.shouldDownload('1.0.93'), false, '稍后安装后不得重复下载同一版本');
assert.strictEqual(policy.shouldDownload('1.0.92'), false, '不得用旧版本覆盖待安装版本');
assert.strictEqual(policy.register({ version: '1.0.93', action: 'autoUpdater' }).accepted, false,
  '同一版本不得再次注册并重复提示');
assert.strictEqual(policy.getPending().deferred, true, '忽略同版本时必须保留稍后安装状态');

assert.strictEqual(policy.shouldDownload('1.0.94'), true, '待安装期间必须允许下载更高版本');
assert.strictEqual(policy.register({ version: '1.0.94', action: 'autoUpdater' }).accepted, true);
assert.strictEqual(policy.getPending().version, '1.0.94');
assert.strictEqual(policy.getPending().deferred, false, '更高版本下载完成后必须重新提示');

policy.clear();
assert.strictEqual(policy.getPending(), null);

console.log('运行中更新稍后安装策略测试通过');
