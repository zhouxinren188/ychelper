'use strict';

const SHOP_OFFICIAL_INFO_API =
  'dsm.shop.center.pageframe.navigation.NavigationFacade.findShopInfo';

/**
 * 监听京麦页面自己发出的店铺资料请求并读取响应。
 * 页面负责生成动态 h5st / dsm-eid；应用不复制签名，也不读取页面 DOM。
 */
function createShopOfficialInfoCapture(webContents, apiName = SHOP_OFFICIAL_INFO_API) {
  const debuggerClient = webContents && webContents.debugger;
  let attachedHere = false;
  let disposed = false;
  let captured = null;
  let lastFailure = null;
  const candidateRequests = new Map();
  const waiters = new Set();

  const settleWaiters = result => {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(result);
    }
    waiters.clear();
  };

  const readResponseBody = async requestId => {
    const candidate = candidateRequests.get(requestId);
    if (!candidate || disposed || captured) return;
    candidateRequests.delete(requestId);
    try {
      const responseBody = await debuggerClient.sendCommand('Network.getResponseBody', { requestId });
      const rawBody = responseBody && responseBody.base64Encoded
        ? Buffer.from(String(responseBody.body || ''), 'base64').toString('utf8')
        : String(responseBody && responseBody.body || '');
      if (!rawBody) {
        lastFailure = { success: false, statusCode: candidate.statusCode, message: '官方店铺资料响应为空' };
        return;
      }
      captured = { success: true, statusCode: candidate.statusCode, body: rawBody };
      settleWaiters(captured);
    } catch (error) {
      lastFailure = {
        success: false,
        statusCode: candidate.statusCode,
        message: error && error.message ? error.message : '无法读取官方店铺资料响应'
      };
    }
  };

  const onMessage = (event, method, params) => {
    if (disposed || !params) return;
    if (method === 'Network.responseReceived') {
      const response = params.response || {};
      const url = String(response.url || '');
      if (!url.includes(String(apiName || ''))) return;
      const statusCode = Number(response.status || 0);
      if (statusCode !== 200) {
        lastFailure = { success: false, statusCode, message: `HTTP ${statusCode || '未知'}` };
        return;
      }
      candidateRequests.set(params.requestId, { statusCode });
      return;
    }
    if (method === 'Network.loadingFinished' && candidateRequests.has(params.requestId)) {
      readResponseBody(params.requestId);
      return;
    }
    if (method === 'Network.loadingFailed') {
      candidateRequests.delete(params.requestId);
    }
  };

  const startPromise = (async () => {
    if (!debuggerClient) throw new Error('店铺后台网络监听不可用');
    if (!debuggerClient.isAttached()) {
      debuggerClient.attach('1.3');
      attachedHere = true;
    }
    debuggerClient.on('message', onMessage);
    await debuggerClient.sendCommand('Network.enable');
  })();
  startPromise.catch(error => {
    lastFailure = {
      success: false,
      statusCode: 0,
      message: error && error.message ? error.message : '店铺后台网络监听启动失败'
    };
    settleWaiters(lastFailure);
  });

  return {
    ready: startPromise,
    async waitForResult(timeoutMs = 15000) {
      if (captured) return captured;
      if (lastFailure) return lastFailure;
      return new Promise(resolve => {
        const waiter = { resolve, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          resolve(lastFailure || {
            success: false,
            statusCode: 0,
            message: '等待京麦官方店铺资料响应超时'
          });
        }, Math.max(1000, Number(timeoutMs) || 15000));
        waiters.add(waiter);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      candidateRequests.clear();
      if (debuggerClient) debuggerClient.removeListener('message', onMessage);
      settleWaiters({ success: false, statusCode: 0, message: '店铺登录窗口已关闭' });
      if (attachedHere && debuggerClient && debuggerClient.isAttached()) {
        try { debuggerClient.detach(); } catch (error) {}
      }
    }
  };
}

module.exports = { SHOP_OFFICIAL_INFO_API, createShopOfficialInfoCapture };
