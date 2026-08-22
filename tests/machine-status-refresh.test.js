'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_REFRESH_INTERVAL_MS,
  createMachineStatusRefreshController
} = require('../src/js/machineStatusRefresh');

async function flushPromises() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

(async () => {
  let active = false;
  let status = { success: true, online: false };
  let getStatusCalls = 0;
  let nextTimerId = 1;
  const timers = new Map();
  const clearedTimers = [];
  const rendered = [];

  const controller = createMachineStatusRefreshController({
    getStatus: async () => {
      getStatusCalls++;
      return status;
    },
    renderStatus: value => rendered.push(value),
    isActive: () => active,
    setIntervalFn: (callback, intervalMs) => {
      assert.strictEqual(intervalMs, DEFAULT_REFRESH_INTERVAL_MS);
      const timerId = nextTimerId++;
      timers.set(timerId, callback);
      return timerId;
    },
    clearIntervalFn: timerId => {
      clearedTimers.push(timerId);
      timers.delete(timerId);
    }
  });

  await controller.sync();
  assert.strictEqual(getStatusCalls, 0, '页面未激活时不应查询连接状态');
  assert.strictEqual(timers.size, 0, '页面未激活时不应创建刷新定时器');

  active = true;
  await controller.sync();
  assert.strictEqual(getStatusCalls, 1, '进入机器码页时应立即刷新');
  assert.strictEqual(timers.size, 1, '进入机器码页时只创建一个定时器');
  assert.strictEqual(rendered.at(-1).online, false);

  status = { success: true, online: true };
  const intervalCallback = [...timers.values()][0];
  intervalCallback();
  await flushPromises();
  assert.strictEqual(getStatusCalls, 2, '定时器应读取最新状态');
  assert.strictEqual(rendered.at(-1).online, true, '连接状态应从连接中更新为在线');

  await controller.sync();
  assert.strictEqual(timers.size, 1, '重复进入机器码页不得重复创建定时器');
  assert.strictEqual(getStatusCalls, 3, '重新点击机器码页应立即刷新一次');

  active = false;
  await controller.sync();
  assert.strictEqual(timers.size, 0, '离开机器码页时应停止刷新');
  assert.deepStrictEqual(clearedTimers, [1]);

  active = true;
  await controller.sync();
  assert.strictEqual(timers.size, 1, '返回机器码页时应恢复刷新');
  controller.dispose();
  assert.strictEqual(timers.size, 0, '页面卸载时应清理定时器');
  assert.strictEqual(controller.getState().disposed, true);

  let resolvePending;
  let pendingCalls = 0;
  const pendingController = createMachineStatusRefreshController({
    getStatus: () => {
      pendingCalls++;
      return new Promise(resolve => { resolvePending = resolve; });
    },
    renderStatus: () => {},
    isActive: () => true,
    setIntervalFn: () => 99,
    clearIntervalFn: () => {}
  });
  const firstRefresh = pendingController.sync();
  const duplicateRefresh = pendingController.refreshNow();
  await flushPromises();
  assert.strictEqual(pendingCalls, 1, '上一次状态读取未结束时不得并发重复请求');
  resolvePending({ success: true, online: true });
  await Promise.all([firstRefresh, duplicateRefresh]);
  pendingController.dispose();

  const rootDir = path.join(__dirname, '..');
  const htmlSource = fs.readFileSync(path.join(rootDir, 'src', 'index.html'), 'utf8');
  const rendererSource = fs.readFileSync(path.join(rootDir, 'src', 'js', 'renderer.js'), 'utf8');
  assert.match(htmlSource, /<script src="js\/machineStatusRefresh\.js"><\/script>\s*<script src="js\/renderer\.js"><\/script>/);
  assert.match(rendererSource, /createMachineStatusRefreshController\(/);
  assert.match(rendererSource, /document\.addEventListener\('visibilitychange', syncStatusRefresh\)/);
  assert.match(rendererSource, /window\.addEventListener\('beforeunload', \(\) => statusRefresh\.dispose\(\)/);

  console.log('机器码连接状态刷新测试通过：页面可见时自动刷新，离开后停止且无并发重复请求');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
