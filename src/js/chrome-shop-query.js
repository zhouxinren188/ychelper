/**
 * Chrome 外部浏览器查询京东商品模块
 * 使用 puppeteer-core 控制用户安装的真实 Chrome 浏览器
 * 绕过 JD h5st 对 Electron 指纹的检测 (code:601)
 */

const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

// ===== Chrome 路径查找 =====

function findChromeExecutable() {
  const candidates = [];

  const programFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || '';

  candidates.push(path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  candidates.push(path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  if (localAppData) {
    candidates.push(path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  try {
    const regResult = execSync(
      'reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve',
      { encoding: 'utf-8', windowsHide: true, timeout: 5000 }
    );
    const match = regResult.match(/REG_SZ\s+(.+)/);
    if (match) {
      const regPath = match[1].trim();
      if (fs.existsSync(regPath)) return regPath;
    }
  } catch (e) { /* 注册表查询失败，忽略 */ }

  return null;
}

// ===== XHR 拦截器脚本 =====

const XHR_INTERCEPTOR_SCRIPT = `(function() {
  'use strict';
  try {
    var XHR = window.XMLHttpRequest;
    if (!XHR) return;
    var nativeOpen = XHR.prototype.open;
    var nativeSend = XHR.prototype.send;

    function patchBody(body) {
      if (!body || typeof body !== 'string') return body;
      try {
        var json = JSON.parse(body);
        var params = window.__ychelper_query_params__;
        if (!params) return body;
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

    var ourOpen = function(method, url) {
      this.__ycUrl__ = url || '';
      return nativeOpen.apply(this, arguments);
    };
    XHR.prototype.open = ourOpen;

    var ourSend = nativeSend;
    var intervalId = setInterval(function() {
      if (XHR.prototype.open !== ourOpen) {
        var hookedOpen = XHR.prototype.open;
        ourOpen = function(method, url) {
          this.__ycUrl__ = url || '';
          return hookedOpen.apply(this, arguments);
        };
        XHR.prototype.open = ourOpen;
      }
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
    setTimeout(function() { clearInterval(intervalId); }, 30000);
  } catch (e) {}
})();`;

// ===== Cookie 格式转换 =====

function convertCookies(electronCookies) {
  return electronCookies.map(c => {
    let sameSite;
    switch (c.sameSite) {
      case 'no_restriction': sameSite = 'None'; break;
      case 'strict': sameSite = 'Strict'; break;
      case 'lax': sameSite = 'Lax'; break;
      default: sameSite = 'Lax'; break;
    }

    const cookie = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: sameSite,
      url: `http${c.secure ? 's' : ''}://${c.domain.replace(/^\./, '')}${c.path || '/'}`
    };

    if (c.expirationDate) {
      cookie.expires = c.expirationDate;
    }

    return cookie;
  });
}

// ===== 响应等待 =====

function waitForProductListResponse(page, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let settled = false;

    const handler = async (response) => {
      if (settled) return;
      try {
        const url = response.url();
        if (!url.includes('queryValidProductList')) return;

        settled = true;
        page.off('response', handler);
        clearTimeout(timer);

        const text = await response.text();
        let totalCount = 0;
        try {
          const j = JSON.parse(text);
          totalCount = (j.data && j.data.totalCount) || 0;
        } catch (e) {}

        console.log(`[Chrome模式] 捕获响应 ${text.length} 字符, totalCount=${totalCount}`);
        console.log(`[Chrome模式] 响应前500字: ${text.substring(0, 500)}`);
        resolve({ body: text, totalCount });
      } catch (e) {
        if (!settled) {
          settled = true;
          page.off('response', handler);
          clearTimeout(timer);
          console.warn('[Chrome模式] 读取响应体失败:', e.message);
          resolve(null);
        }
      }
    };

    page.on('response', handler);

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        page.off('response', handler);
        console.warn('[Chrome模式] 响应捕获超时 (' + timeoutMs + 'ms)');
        resolve(null);
      }
    }, timeoutMs);
  });
}

// ===== 强杀 Chrome 进程 (Windows 兼容) =====

function forceKillBrowser(browser) {
  try {
    const proc = browser.process();
    if (proc && proc.pid) {
      if (process.platform === 'win32') {
        try {
          execSync(`taskkill /F /T /PID ${proc.pid}`, { windowsHide: true, timeout: 5000 });
        } catch (e) { /* 进程可能已退出 */ }
      } else {
        try { proc.kill('SIGKILL'); } catch (e) {}
      }
    }
  } catch (e) {}
}

// ===== 核心查询函数 =====

async function queryShopGoodsWithChrome(params, shopCookies, parseProductListResponse) {
  const chromePath = findChromeExecutable();
  if (!chromePath) {
    throw new Error('未检测到 Chrome 浏览器');
  }

  const GLOBAL_TIMEOUT = 55000; // 55秒全局超时，确保在 IPC 超时前返回

  // 用 Promise.race 包裹全局超时
  return Promise.race([
    _doQueryWithChrome(params, shopCookies, parseProductListResponse, chromePath),
    new Promise((resolve) => {
      setTimeout(() => {
        console.error('[Chrome模式] 全局超时 (' + GLOBAL_TIMEOUT + 'ms)，强制返回');
        resolve({ success: false, error: 'Chrome查询超时(55秒)，请检查网络连接后重试' });
      }, GLOBAL_TIMEOUT);
    })
  ]);
}

async function _doQueryWithChrome(params, shopCookies, parseProductListResponse, chromePath) {
  const statusMap = { '在售': '4', '下架': '5', '待售': '2' };
  const queryParams = {
    pageNum: 1,
    pageSize: 100,
    productState: statusMap[params.goodsStatus] || '4',
    dateFrom: params.dateFrom || '',
    dateTo: params.dateTo || ''
  };
  console.log('[Chrome模式] 开始查询, params:', JSON.stringify(queryParams));

  const tmpDir = path.join(os.tmpdir(), `ychelper-chrome-${Date.now()}`);
  let browser = null;

  try {
    // --- 启动 Chrome ---
    // 使用 headless: false（真实窗口）而非 headless: 'new'
    // 原因：JD 的反自动化系统能检测 headless 模式（即使是 new headless），返回 code:601
    // 窗口放在屏幕外 (--window-position) 用户不可见
    const t0 = Date.now();
    console.log('[Chrome模式] [' + new Date().toLocaleTimeString() + '] 启动 Chrome (非headless):', chromePath);
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: false,
      userDataDir: tmpDir,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-popup-blocking',
        '--disable-translate',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',   // 去除 navigator.webdriver 标记
        '--window-position=-32000,-32000',                  // 窗口放在屏幕外
        '--window-size=1366,768'
      ]
    });
    console.log('[Chrome模式] Chrome 已启动 (' + (Date.now() - t0) + 'ms)');

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });
    console.log('[Chrome模式] 新标签页已创建');

    // --- 批量注入 Cookie（一次 CDP 调用） ---
    const t1 = Date.now();
    const puppeteerCookies = convertCookies(shopCookies);
    let cookieOk = 0;
    let cookieFail = 0;
    // 分批注入：每批50个，避免单次 CDP 调用过大
    for (let i = 0; i < puppeteerCookies.length; i += 50) {
      const batch = puppeteerCookies.slice(i, i + 50);
      try {
        await page.setCookie(...batch);
        cookieOk += batch.length;
      } catch (e) {
        // 批量失败时逐个重试
        for (const c of batch) {
          try { await page.setCookie(c); cookieOk++; } catch (e2) { cookieFail++; }
        }
      }
    }
    console.log(`[Chrome模式] Cookie注入完成: 成功${cookieOk} 失败${cookieFail} (${Date.now() - t1}ms)`);

    // --- CDP 注入脚本 ---
    const client = await page.createCDPSession();

    // 去除 puppeteer 自动化痕迹：navigator.webdriver = false
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `Object.defineProperty(navigator, 'webdriver', { get: () => false });`
    });

    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: XHR_INTERCEPTOR_SCRIPT
    });
    let paramsResult = await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__ychelper_query_params__ = ${JSON.stringify(queryParams)};`
    });
    let paramsIdentifier = paramsResult.identifier;
    console.log('[Chrome模式] CDP脚本已注入');

    // --- 监控页面控制台输出（调试用） ---
    page.on('console', msg => {
      const text = msg.text();
      if (text.includes('ychelper') || text.includes('error') || text.includes('Error')) {
        console.log('[Chrome页面console]', msg.type(), text.substring(0, 200));
      }
    });
    page.on('pageerror', err => {
      console.warn('[Chrome页面JS错误]', err.message.substring(0, 200));
    });

    // --- 第一步：先导航到 shop.jd.com 建立会话 ---
    // JD 的 wares-jdm.jd.com SPA 依赖 shop.jd.com 初始化的会话状态
    // 跳过此步会导致页面 JS 不发起 API 调用
    console.log('[Chrome模式] [' + new Date().toLocaleTimeString() + '] 第1步: 导航到 shop.jd.com 建立会话...');
    try {
      await page.goto('https://shop.jd.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      console.log('[Chrome模式] shop.jd.com 加载完成, URL:', page.url());
    } catch (e) {
      console.warn('[Chrome模式] shop.jd.com 导航异常:', e.message, 'URL:', page.url());
    }

    // 检测登录状态
    let shopUrl = page.url();
    if (shopUrl.includes('passport.jd.com') || shopUrl.includes('/login')) {
      console.log('[Chrome模式] shop.jd.com 跳转到登录页:', shopUrl);
      return { success: false, error: '店铺登录已过期，请重新登录店铺后台' };
    }

    // 等待 shop.jd.com 的 JS 初始化（会话建立、token 设置等）
    console.log('[Chrome模式] 等待 shop.jd.com JS 初始化 (2s)...');
    await new Promise(r => setTimeout(r, 2000));

    // --- 第二步：设置响应监听 BEFORE 导航到商品列表页 ---
    const captureP = waitForProductListResponse(page, 25000);

    // --- 第三步：导航到商品列表页 ---
    const targetUrl = 'https://wares-jdm.jd.com/ware/wareList?activeTab=OnsaleWare&businessModel=0';
    console.log('[Chrome模式] [' + new Date().toLocaleTimeString() + '] 第2步: 导航到商品列表页...');

    let navOk = false;
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      navOk = true;
      console.log('[Chrome模式] [' + new Date().toLocaleTimeString() + '] 商品列表页加载完成, URL:', page.url());
    } catch (navErr) {
      console.error('[Chrome模式] 商品列表页导航异常:', navErr.message);
      console.log('[Chrome模式] 导航异常后 URL:', page.url());
    }

    // --- 登录检测 ---
    const currentUrl = page.url();
    if (currentUrl.includes('passport.jd.com') || currentUrl.includes('/login')) {
      console.log('[Chrome模式] 检测到登录页跳转:', currentUrl);
      return { success: false, error: '店铺登录已过期，请重新登录店铺后台' };
    }

    // --- 等待 API 响应 ---
    console.log('[Chrome模式] [' + new Date().toLocaleTimeString() + '] 等待 queryValidProductList API 响应...');
    const firstResp = await captureP;
    console.log('[Chrome模式] [' + new Date().toLocaleTimeString() + '] API等待结束, 结果:', firstResp ? '有响应' : '无响应(超时)');

    if (!firstResp) {
      if (!navOk) {
        return { success: false, error: '页面导航超时，请检查网络连接' };
      }
      // 尝试获取页面内容诊断问题
      let pageTitle = '';
      try { pageTitle = await page.title(); } catch(e) {}
      return { success: false, error: '获取商品列表超时(API无响应)。页面URL: ' + page.url() + ' 标题: ' + pageTitle };
    }

    // --- 检测错误码 ---
    try {
      const raw = JSON.parse(firstResp.body);
      if (raw.code === 601) {
        return { success: false, error: '触发京东反自动化检测(code:601)，建议稍等几分钟后重试' };
      }
      if (raw.code === 312) {
        return { success: false, error: '触发京东安全验证(code:312)，请稍后重试' };
      }
      if (raw.code !== 200) {
        return { success: false, error: raw.msg || `API返回错误 code=${raw.code}` };
      }
    } catch (e) {}

    // --- 解析首页 ---
    let parsed = parseProductListResponse(firstResp.body, new Map());
    if (!parsed.success) {
      return { success: false, error: parsed.error || '商品列表解析失败' };
    }

    const allGoods = [...parsed.goods];
    const totalCount = firstResp.totalCount || allGoods.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / queryParams.pageSize));
    console.log(`[Chrome模式] 第1/${totalPages}页, 本页${parsed.goods.length}条, 总计${totalCount}条`);

    // --- 分页处理 ---
    for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
      queryParams.pageNum = pageNum;

      await new Promise(r => setTimeout(r, 800 + Math.random() * 700));

      try {
        await client.send('Page.removeScriptToEvaluateOnNewDocument', {
          identifier: paramsIdentifier
        });
      } catch (e) {}
      paramsResult = await client.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `window.__ychelper_query_params__ = ${JSON.stringify(queryParams)};`
      });
      paramsIdentifier = paramsResult.identifier;

      const pgCapture = waitForProductListResponse(page, 25000);

      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
      } catch (e) {
        console.warn(`[Chrome模式] 第${pageNum}页reload异常:`, e.message);
      }

      const pgUrl = page.url();
      if (pgUrl.includes('passport.jd.com') || pgUrl.includes('/login')) {
        console.warn('[Chrome模式] 分页过程中登录过期');
        break;
      }

      const pgResp = await pgCapture;
      if (!pgResp) {
        console.warn(`[Chrome模式] 第${pageNum}页响应超时，终止分页`);
        break;
      }

      try {
        const raw = JSON.parse(pgResp.body);
        if (raw.code !== 200) {
          console.warn(`[Chrome模式] 第${pageNum}页 code=${raw.code}，终止分页`);
          break;
        }
      } catch (e) {}

      parsed = parseProductListResponse(pgResp.body, new Map());
      if (!parsed.success) {
        console.warn(`[Chrome模式] 第${pageNum}页解析失败: ${parsed.error}`);
        break;
      }

      allGoods.push(...parsed.goods);
      console.log(`[Chrome模式] 第${pageNum}/${totalPages}页, 本页${parsed.goods.length}条, 累计${allGoods.length}条`);
    }

    // --- 客户端价格过滤 ---
    let result = allGoods;
    const pMin = params.priceMin ? parseFloat(params.priceMin) : 0;
    const pMax = params.priceMax ? parseFloat(params.priceMax) : Infinity;
    if (pMin > 0 || pMax < Infinity) {
      result = allGoods.filter(g => g.price == null || (g.price >= pMin && g.price <= pMax));
    }

    const msg = totalPages > 1
      ? `共${totalPages}页, API返回${totalCount}条, 获取${allGoods.length}条`
      : undefined;

    console.log(`[Chrome模式] 查询完成: ${result.length}条商品`);
    return { success: true, goods: result, total: result.length, message: msg };

  } catch (err) {
    console.error('[Chrome模式] 查询异常:', err.message, err.stack);
    return { success: false, error: `Chrome模式异常: ${err.message}` };

  } finally {
    // --- 清理 ---
    console.log('[Chrome模式] [' + new Date().toLocaleTimeString() + '] 开始清理...');
    if (browser) {
      try {
        await Promise.race([
          browser.close(),
          new Promise(r => setTimeout(r, 3000))
        ]);
        console.log('[Chrome模式] browser.close() 完成');
      } catch (e) {
        console.warn('[Chrome模式] browser.close() 失败:', e.message);
      }
      // Windows 兼容：用 taskkill 强杀进程树
      forceKillBrowser(browser);
    }
    // 延迟删除临时目录
    const dirToClean = tmpDir;
    setTimeout(() => {
      try {
        if (fs.existsSync(dirToClean)) {
          fs.rmSync(dirToClean, { recursive: true, force: true });
        }
      } catch (e) {}
    }, 3000);
    console.log('[Chrome模式] [' + new Date().toLocaleTimeString() + '] 清理完成');
  }
}

module.exports = {
  findChromeExecutable,
  queryShopGoodsWithChrome
};
