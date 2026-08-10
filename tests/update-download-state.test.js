'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DIFFERENTIAL_FALLBACK_MESSAGE,
  DIFFERENTIAL_UPDATE_MODE,
  FULL_UPDATE_MODE,
  createUpdateDownloadState,
  hasUsableDifferentialBase
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

// 下载前预检：缓存缺失或空文件时直接使用完整包，只有非空 installer.exe 才尝试差分。
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ychelper-update-state-'));
try {
  assert.strictEqual(hasUsableDifferentialBase(cacheDir), false);
  fs.writeFileSync(path.join(cacheDir, 'installer.exe'), Buffer.alloc(0));
  assert.strictEqual(hasUsableDifferentialBase(cacheDir), false);
  fs.writeFileSync(path.join(cacheDir, 'installer.exe'), Buffer.from('MZ-test-installer'));
  assert.strictEqual(hasUsableDifferentialBase(cacheDir), true);
} finally {
  fs.rmSync(cacheDir, { recursive: true, force: true });
}

console.log('更新下载状态测试通过：已覆盖内部差分回退、进度重置兜底及单次通知');
