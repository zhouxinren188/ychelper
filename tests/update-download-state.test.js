'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const {
  DIFFERENTIAL_FALLBACK_MESSAGE,
  DIFFERENTIAL_UPDATE_MODE,
  FULL_UPDATE_MODE,
  createUpdateDownloadState,
  getBlockmapInstallerSize,
  hasUsableDifferentialBase,
  repairDifferentialBaseFromPendingUpdate
} = require('../src/js/updateDownloadState');

const fallbackEvents = [];
const state = createUpdateDownloadState({
  onFallback: event => fallbackEvents.push(event)
});

assert.strictEqual(state.getMode(), DIFFERENTIAL_UPDATE_MODE);
assert.strictEqual(state.handleProgress({ percent: 43 }).mode, DIFFERENTIAL_UPDATE_MODE);
assert.strictEqual(
  state.inspectUpdaterLog(
    'Cannot download differentially, fallback to full download:',
    new Error('ENOENT: installer.exe')
  ),
  true
);
assert.strictEqual(state.getMode(), FULL_UPDATE_MODE);
assert.strictEqual(state.handleProgress({ percent: 14 }).mode, FULL_UPDATE_MODE);
assert.strictEqual(fallbackEvents.length, 1);
assert.strictEqual(fallbackEvents[0].source, 'updater-log');
assert.strictEqual(fallbackEvents[0].message, DIFFERENTIAL_FALLBACK_MESSAGE);

// 同一轮下载重复出现内部日志时，不应重复弹提示或重置状态。
state.inspectUpdaterLog('Cannot download differentially, fallback to full download: repeated');
assert.strictEqual(fallbackEvents.length, 1);

// 普通错误不能误判为差分回退。
state.reset();
assert.strictEqual(state.inspectUpdaterLog('net::ERR_CONNECTION_RESET'), false);
assert.strictEqual(state.getMode(), DIFFERENTIAL_UPDATE_MODE);

// 少量进度抖动不应切换模式。
state.handleProgress({ percent: 43 });
assert.strictEqual(state.handleProgress({ percent: 40 }).mode, DIFFERENTIAL_UPDATE_MODE);

// 即使未来更新器日志文本变化，明显的百分比重置也能识别全量回退。
state.reset();
state.handleProgress({ percent: 55 });
const resetProgress = state.handleProgress({ percent: 8 });
assert.strictEqual(resetProgress.mode, FULL_UPDATE_MODE);
assert.strictEqual(fallbackEvents.length, 2);
assert.strictEqual(fallbackEvents[1].source, 'progress-reset');

// 新一轮更新必须重新从差分模式开始。
state.reset();
assert.strictEqual(state.getMode(), DIFFERENTIAL_UPDATE_MODE);
assert.strictEqual(state.handleProgress({ percent: 2 }).mode, DIFFERENTIAL_UPDATE_MODE);

// UI 通知自身异常时，不能破坏更新器内部的全量回退。
const callbackFailureState = createUpdateDownloadState({
  onFallback: () => { throw new Error('renderer destroyed'); }
});
assert.doesNotThrow(() => {
  callbackFailureState.inspectUpdaterLog('Cannot download differentially, fallback to full download');
});
assert.strictEqual(callbackFailureState.getMode(), FULL_UPDATE_MODE);

// 下载前预检：installer.exe 必须和 current.blockmap 对应同一安装包。
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ychelper-update-state-'));
try {
  assert.strictEqual(hasUsableDifferentialBase(cacheDir), false);
  fs.writeFileSync(path.join(cacheDir, 'installer.exe'), Buffer.alloc(0));
  assert.strictEqual(hasUsableDifferentialBase(cacheDir), false);
  const installer = Buffer.from('MZ-test-installer');
  fs.writeFileSync(path.join(cacheDir, 'installer.exe'), installer);
  fs.writeFileSync(path.join(cacheDir, 'current.blockmap'), zlib.gzipSync(JSON.stringify({
    version: '2',
    files: [{ name: 'file', offset: 0, sizes: [installer.length], checksums: ['test'] }]
  })));
  assert.strictEqual(hasUsableDifferentialBase(cacheDir), true);
  assert.strictEqual(getBlockmapInstallerSize(path.join(cacheDir, 'current.blockmap')), installer.length);
  fs.writeFileSync(path.join(cacheDir, 'installer.exe'), Buffer.from('MZ-wrong-size'));
  assert.strictEqual(hasUsableDifferentialBase(cacheDir), false);
} finally {
  fs.rmSync(cacheDir, { recursive: true, force: true });
}

async function testDifferentialBaseRepair() {
  const repairCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ychelper-update-repair-'));
  const pendingDir = path.join(repairCacheDir, 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  const version = '1.0.76';
  const fileName = `ychelper-setup-${version}.exe`;
  const pendingInstaller = Buffer.from('MZ-current-version-installer');
  const pendingBlockmap = zlib.gzipSync(JSON.stringify({
    version: '2',
    files: [{ name: 'file', offset: 0, sizes: [pendingInstaller.length], checksums: ['test'] }]
  }));
  const sha512 = crypto.createHash('sha512').update(pendingInstaller).digest('base64');

  try {
    fs.writeFileSync(path.join(pendingDir, fileName), pendingInstaller);
    fs.writeFileSync(path.join(pendingDir, 'current.blockmap'), pendingBlockmap);
    fs.writeFileSync(path.join(pendingDir, 'update-info.json'), JSON.stringify({ fileName, sha512 }));
    const sameSizeStaleInstaller = Buffer.alloc(pendingInstaller.length, 0x61);
    sameSizeStaleInstaller.write('MZ');
    fs.writeFileSync(path.join(repairCacheDir, 'installer.exe'), sameSizeStaleInstaller);
    fs.writeFileSync(path.join(repairCacheDir, 'current.blockmap'), pendingBlockmap);

    assert.strictEqual(hasUsableDifferentialBase(repairCacheDir), true,
      '没有运行时版本时只能确认尺寸配对，模拟旧客户端现状');
    assert.strictEqual(hasUsableDifferentialBase(repairCacheDir, '1.0.75'), true,
      'pending 属于其他版本时不能破坏现有尺寸配对缓存');
    assert.strictEqual(hasUsableDifferentialBase(repairCacheDir, version), true);

    // The asynchronous entry point used by newer clients must repair the same real-world mismatch.
    fs.writeFileSync(path.join(repairCacheDir, 'installer.exe'), Buffer.from('MZ-stale-installer'));
    fs.writeFileSync(path.join(repairCacheDir, 'current.blockmap'), pendingBlockmap);
    const repaired = await repairDifferentialBaseFromPendingUpdate(repairCacheDir, version);
    assert.strictEqual(repaired.repaired, true);
    assert.deepStrictEqual(fs.readFileSync(path.join(repairCacheDir, 'installer.exe')), pendingInstaller);
    assert.strictEqual(hasUsableDifferentialBase(repairCacheDir), true);

    const unchanged = await repairDifferentialBaseFromPendingUpdate(repairCacheDir, version);
    assert.strictEqual(unchanged.repaired, false);
    assert.strictEqual(unchanged.reason, 'base-already-current');
  } finally {
    fs.rmSync(repairCacheDir, { recursive: true, force: true });
  }
}

testDifferentialBaseRepair()
  .then(() => console.log('更新下载状态测试通过：已覆盖差分回退、进度重置、缓存配对校验及自动修复'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
