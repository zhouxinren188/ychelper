/**
 * 店铺后台页面 preload 脚本
 * 反指纹保护 + queryValidProductList XHR 拦截器
 * 数据捕获由主进程 CDP Debugger 完成
 */

(function() {
  'use strict';

  // ===== 1. 清理 Node.js / Electron 痕迹 =====
  try {
    var nodeProps = ['process', 'require', 'exports', 'module', '__filename', '__dirname', 'Buffer', 'global'];
    for (var i = 0; i < nodeProps.length; i++) {
      if (typeof window[nodeProps[i]] !== 'undefined') {
        Object.defineProperty(window, nodeProps[i], {
          value: undefined,
          enumerable: false,
          configurable: true,
          writable: true
        });
      }
    }
  } catch (e) {}

  try {
    var electronProps = ['__electron_webpack', 'electronAPI', '__electronLog'];
    for (var j = 0; j < electronProps.length; j++) {
      if (typeof window[electronProps[j]] !== 'undefined') {
        delete window[electronProps[j]];
      }
    }
  } catch (e) {}

  // ===== 2. 反指纹 =====
  try {
    Object.defineProperty(navigator, 'webdriver', {
      get: function() { return undefined; },
      configurable: true
    });
  } catch (e) {}

  // 覆盖 navigator.userAgentData（移除 Electron 品牌标识）
  try {
    if (navigator.userAgentData) {
      var originalUAData = navigator.userAgentData;
      var filteredBrands = [];
      if (originalUAData.brands) {
        for (var b = 0; b < originalUAData.brands.length; b++) {
          var brand = originalUAData.brands[b].brand.toLowerCase();
          if (brand.indexOf('electron') === -1 && brand.indexOf('cloud-warehouse') === -1 && brand.indexOf('ychelper') === -1) {
            filteredBrands.push(originalUAData.brands[b]);
          }
        }
      }
      var fakeUAData = {
        brands: filteredBrands,
        mobile: false,
        platform: originalUAData.platform || 'Windows',
        getHighEntropyValues: function(hints) {
          return originalUAData.getHighEntropyValues(hints).then(function(values) {
            if (values.brands) {
              values.brands = values.brands.filter(function(b) {
                var name = b.brand.toLowerCase();
                return name.indexOf('electron') === -1 && name.indexOf('cloud-warehouse') === -1 && name.indexOf('ychelper') === -1;
              });
            }
            if (values.fullVersionList) {
              values.fullVersionList = values.fullVersionList.filter(function(b) {
                var name = b.brand.toLowerCase();
                return name.indexOf('electron') === -1 && name.indexOf('cloud-warehouse') === -1 && name.indexOf('ychelper') === -1;
              });
            }
            if (values.uaFullVersion) {
              values.uaFullVersion = values.uaFullVersion.replace(/Electron\/[\d.]+/g, '');
            }
            return values;
          });
        },
        toJSON: function() {
          return { brands: filteredBrands, mobile: false, platform: this.platform };
        }
      };
      Object.defineProperty(navigator, 'userAgentData', {
        get: function() { return fakeUAData; },
        configurable: true
      });
    }
  } catch (e) {}

  try {
    if (!window.chrome) {
      window.chrome = {};
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        connect: function() {
          return { onMessage: { addListener: function() {} }, postMessage: function() {} };
        },
        sendMessage: function() {},
        onMessage: { addListener: function() {}, removeListener: function() {} }
      };
    }
    if (!window.chrome.loadTimes) {
      window.chrome.loadTimes = function() { return {}; };
    }
    if (!window.chrome.csi) {
      window.chrome.csi = function() { return {}; };
    }
    if (!window.chrome.app) {
      window.chrome.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: function() { return null; },
        getIsInstalled: function() { return false; },
        runningState: function() { return 'cannot_run'; }
      };
    }
  } catch (e) {}

  try {
    Object.defineProperty(navigator, 'plugins', {
      get: function() {
        return [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 1 }
        ];
      },
      configurable: true
    });
  } catch (e) {}

  try {
    Object.defineProperty(navigator, 'languages', {
      get: function() { return ['zh-CN', 'zh', 'en-US', 'en']; },
      configurable: true
    });
  } catch (e) {}

  try {
    Object.defineProperty(navigator, 'pdfViewerEnabled', {
      get: function() { return true; },
      configurable: true
    });
  } catch (e) {}

  try {
    if (window.Notification) {
      Object.defineProperty(Notification, 'permission', {
        get: function() { return 'default'; },
        configurable: true
      });
    }
  } catch (e) {}

  // navigator.permissions.query mock（防止 headless 检测）
  try {
    if (navigator.permissions) {
      var origQuery = navigator.permissions.query.bind(navigator.permissions);
      Object.defineProperty(navigator.permissions, 'query', {
        value: function(desc) {
          if (desc && desc.name === 'notifications') {
            return Promise.resolve({ state: 'default', onchange: null });
          }
          return origQuery(desc).catch(function() {
            return { state: 'prompt', onchange: null };
          });
        },
        configurable: true, writable: true
      });
    }
  } catch (e) {}

  // 硬件指纹（合理的默认值）
  try {
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: function() { return 8; }, configurable: true
    });
    Object.defineProperty(navigator, 'deviceMemory', {
      get: function() { return 8; }, configurable: true
    });
  } catch (e) {}

  // ===== 2b. Page Visibility API 覆盖 =====
  // 关键：当 BrowserWindow show:false 或窗口离屏时，Chromium 会将页面标记为 hidden
  // JD 的 h5st SDK 通过 visibilityState 检测后台/自动化环境
  // 必须在任何第三方脚本加载前覆盖这些属性
  try {
    Object.defineProperty(document, 'visibilityState', {
      get: function() { return 'visible'; },
      configurable: true
    });
    Object.defineProperty(document, 'hidden', {
      get: function() { return false; },
      configurable: true
    });
  } catch (e) {}

  // document.hasFocus() — 非焦点窗口返回 false，需覆盖
  try {
    var origHasFocus = document.hasFocus;
    document.hasFocus = function() { return true; };
  } catch (e) {}

  // 拦截 visibilitychange 事件，阻止 JD SDK 感知到页面不可见
  try {
    document.addEventListener('visibilitychange', function(e) {
      e.stopImmediatePropagation();
    }, true);
  } catch (e) {}

  // 自动关闭京东反自动化检测弹窗
  // 京东检测脚本会注入含"未经京东授权"文字的浮层
  try {
    var observer = new MutationObserver(function(mutations) {
      for (var m = 0; m < mutations.length; m++) {
        var nodes = mutations[m].addedNodes;
        for (var n = 0; n < nodes.length; n++) {
          var node = nodes[n];
          if (node.nodeType === 1 && node.textContent) {
            var text = node.textContent;
            if (text.indexOf('未经京东授权') !== -1 ||
                text.indexOf('未经授权') !== -1 ||
                text.indexOf('信息风险') !== -1) {
              node.style.display = 'none';
              try { node.parentNode.removeChild(node); } catch(e2) {}
            }
          }
        }
      }
    });
    // 页面加载后启动观察
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      document.addEventListener('DOMContentLoaded', function() {
        if (document.body) {
          observer.observe(document.body, { childList: true, subtree: true });
        }
      });
    }
  } catch (e) {}

  // ===== 3. queryValidProductList XHR 拦截器 =====
  // 主进程通过 executeJavaScript 设置 window.__ychelper_query_params__
  // 当页面发送 queryValidProductList 请求时，用我们的参数替换请求体中的筛选条件
  // 核心：在 h5st SDK hook send 之后，再包一层，确保 h5st 签名的是修改后的 body
  // 调用链: 页面 → ourSend(patchBody) → h5stSend(签名) → nativeSend
  try {
    var XHR = window.XMLHttpRequest;
    if (XHR) {
      var nativeOpen = XHR.prototype.open;
      var nativeSend = XHR.prototype.send;

      // 修改 queryValidProductList 请求体
      function patchBody(body) {
        if (!body || typeof body !== 'string') return body;
        try {
          var json = JSON.parse(body);
          var params = window.__ychelper_query_params__;
          if (!params) return body;
          // API body 可能有 productListQueryReq 包装层，也可能是扁平结构
          var target = json.productListQueryReq || json;
          if (params.pageNum != null)  target.pageNum = params.pageNum;
          if (params.pageSize != null) target.pageSize = params.pageSize;
          if (params.productState)     target.productState = String(params.productState);
          if (params.dateFrom && params.dateTo) {
            var start = params.dateFrom + ' 00:00:00';
            var end   = params.dateTo   + ' 23:59:59';
            target.startOnlineTime = start;
            target.endOnlineTime = end;
            target.onlineTime = [start, end];
          } else {
            delete target.startOnlineTime;
            delete target.endOnlineTime;
            delete target.onlineTime;
          }
          return JSON.stringify(json);
        } catch(e) { return body; }
      }

      // Hook open: 记录每个 XHR 实例的请求 URL
      var ourOpen = function(method, url) {
        this.__ycUrl__ = url || '';
        return nativeOpen.apply(this, arguments);
      };
      XHR.prototype.open = ourOpen;

      // 持续监测 send 是否被 h5st SDK 替换
      var ourSend = nativeSend;
      var intervalId = setInterval(function() {
        // 检测 open 被第三方重新 hook
        if (XHR.prototype.open !== ourOpen) {
          var hookedOpen = XHR.prototype.open;
          ourOpen = function(method, url) {
            this.__ycUrl__ = url || '';
            return hookedOpen.apply(this, arguments);
          };
          XHR.prototype.open = ourOpen;
        }
        // 检测 send 被 h5st hook（不是我们的 ourSend，也不是原生 nativeSend）
        var currentSend = XHR.prototype.send;
        if (currentSend !== ourSend && currentSend !== nativeSend) {
          var h5stSend = currentSend;
          ourSend = function(body) {
            if (this.__ycUrl__ && this.__ycUrl__.indexOf('queryValidProductList') !== -1) {
              if (window.__ychelper_query_params__) {
                body = patchBody(body);
              }
            }
            return h5stSend.call(this, body);
          };
          XHR.prototype.send = ourSend;
          clearInterval(intervalId);
        }
      }, 100);
      // 30秒安全超时，防止无限轮询
      setTimeout(function() { clearInterval(intervalId); }, 30000);
    }
  } catch (e) {}

})();
