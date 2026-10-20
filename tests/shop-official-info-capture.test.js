'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const {
  SHOP_OFFICIAL_INFO_API,
  createShopOfficialInfoCapture
} = require('../src/js/shopOfficialInfoCapture');

async function run() {
  class MockDebugger extends EventEmitter {
    constructor() {
      super();
      this.attached = false;
      this.commands = [];
    }

    isAttached() { return this.attached; }
    attach() { this.attached = true; }
    detach() { this.attached = false; }

    async sendCommand(command, params) {
      this.commands.push({ command, params });
      if (command === 'Network.getResponseBody') {
        return { body: '{"data":{"shopName":"测试店铺"}}', base64Encoded: false };
      }
      return {};
    }
  }

  const debuggerClient = new MockDebugger();
  const capture = createShopOfficialInfoCapture({ debugger: debuggerClient });
  await capture.ready;
  assert(debuggerClient.commands.some(item => item.command === 'Network.enable'),
    '必须在页面导航前开启网络监听');

  // 响应可能早于登录完成事件，监听器必须先缓存，再供完成逻辑读取。
  debuggerClient.emit('message', {}, 'Network.responseReceived', {
    requestId: 'request-1',
    response: {
      status: 200,
      url: `https://sff.jd.com/api?v=1.0&api=${SHOP_OFFICIAL_INFO_API}`
    }
  });
  debuggerClient.emit('message', {}, 'Network.loadingFinished', { requestId: 'request-1' });
  await new Promise(resolve => setImmediate(resolve));

  const result = await capture.waitForResult(1000);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.statusCode, 200);
  assert.match(result.body, /测试店铺/);
  assert(debuggerClient.commands.some(item =>
    item.command === 'Network.getResponseBody' && item.params.requestId === 'request-1'),
  '必须读取京麦官方请求的真实响应体');

  capture.dispose();
  assert.strictEqual(debuggerClient.isAttached(), false, '监听完成后必须释放调试连接');
  console.log('京麦官方店铺资料响应捕获测试通过');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
