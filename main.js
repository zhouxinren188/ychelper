const logger = require('./logger');
const { app, BrowserWindow, ipcMain, dialog, shell, session, net, safeStorage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const QRCode = require('qrcode');
const AdmZip = require('adm-zip');
const excelGen = require('./src/js/excelGenerator');
const { buildShopSkuExportFileName } = require('./src/js/shopExportFile');
const { canUseAutomation } = require('./src/js/subscriptionAccess');
const {
  WMS_WAREHOUSE_MULTI_LABEL_SELECTOR,
  WMS_WAREHOUSE_SECTION_SELECTOR,
  WMS_WAREHOUSE_SINGLE_LABEL_SELECTOR,
  classifyWmsPageUrl,
  normalizeWmsWarehouseInfo
} = require('./src/js/wmsPageState');
const {
  classifyWmsApiResponse,
  getWmsResponseMessage
} = require('./src/js/wmsSessionState');
const {
  PRODUCT_LIST_API,
  SHOP_H5ST_APP_ID,
  SHOP_REQUEST_RESPONSE_DELAY_MS,
  SHOP_SFF_APP_ID,
  SKU_LIST_API,
  SKU_REQUEST_TIMEOUT_MS,
  buildProductListRequest,
  buildShopSffRequestHeaders,
  buildSkuListRequest,
  extractProductPage,
  extractSkuList,
  getProductState,
  queryProductPagesPageMajor
} = require('./src/js/shopGoodsQuery');
const {
  classifyShopIdentityResponse,
  findDuplicateShopAccount,
  isShopLoginUrl,
  isTrustedShopLoginFrameUrl
} = require('./src/js/shopSessionState');
let cookieManager = null;
try { cookieManager = require('./src/js/cookieManager'); } catch(e) { console.warn('[启动] cookieManager 模块缺失，热更新后将恢复'); }

// 防止 stdout/stderr 管道断开时崩溃
process.stdout.on('error', (err) => { if (err.code === 'EPIPE') return; throw err; });
process.stderr.on('error', (err) => { if (err.code === 'EPIPE') return; throw err; });

// ========== 订阅系统配置 ==========
const API_BASE_URL = 'http://150.158.54.108:3000';
const APP_KEY = 'ychelper-client';
const APP_SECRET = 'ychelper_s3cret_k3y_2024_change_this'; // 需与服务端一致
const MAX_UPDATE_METADATA_SIZE = 1024 * 1024;
const MAX_HOT_UPDATE_SIZE = 50 * 1024 * 1024;
const MAX_FULL_UPDATE_SIZE = 250 * 1024 * 1024;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:\.\d+)?$/;
const SHA512_BASE64_PATTERN = /^[A-Za-z0-9+/]{86}==$/;

function getAllowedUpdateUrl(candidate, base = API_BASE_URL) {
  const parsed = new URL(String(candidate || ''), base);
  const apiOrigin = new URL(API_BASE_URL).origin;
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== apiOrigin) {
    throw new Error('更新地址不在受信任的服务器范围内');
  }
  return parsed;
}

function verifySHA512(data, expectedBase64) {
  if (!SHA512_BASE64_PATTERN.test(String(expectedBase64 || ''))) return false;
  const actual = crypto.createHash('sha512').update(data).digest();
  const expected = Buffer.from(expectedBase64, 'base64');
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

function verifyFileSHA512(filePath, expectedBase64) {
  if (!SHA512_BASE64_PATTERN.test(String(expectedBase64 || ''))) return false;
  return verifySHA512(fs.readFileSync(filePath), expectedBase64);
}

let currentSessionToken = null;
let heartbeatTimer = null;
let subscriptionWindow = null;
let departmentSelectWindow = null;
let deptSelectResolve = null; // 事业部选择的 Promise resolver

// 生成设备ID
function getDeviceId() {
  let deviceId = storeGet('deviceId', null);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    storeSet('deviceId', deviceId);
  }
  return deviceId;
}

// 生成请求签名
function signRequest(method, urlPath, body) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodyStr = body ? JSON.stringify(body) : '';
  const pathForSign = urlPath.split('?')[0];
  const signStr = `${method}|${pathForSign}|${timestamp}|${nonce}|${bodyStr}`;
  const signature = crypto.createHmac('sha256', APP_SECRET).update(signStr).digest('hex');
  return { timestamp, nonce, signature };
}

// 调用后端 API
function callApi(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const { timestamp, nonce, signature } = signRequest(method, urlPath, body);
    const fullUrl = `${API_BASE_URL}${urlPath}`;

    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-App-Key': APP_KEY,
        'X-Timestamp': timestamp,
        'X-Nonce': nonce,
        'X-Signature': signature
      }
    };

    const req = net.request({ url: fullUrl, method });
    if (body) {
      req.setHeader('Content-Type', 'application/json');
    }
    req.setHeader('X-App-Key', APP_KEY);
    req.setHeader('X-Timestamp', timestamp);
    req.setHeader('X-Nonce', nonce);
    req.setHeader('X-Signature', signature);

    req.on('response', (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('解析服务器响应失败'));
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// 检查订阅状态
async function checkSubscription(jdUsername, departmentId, merchantName, departmentName) {
  const deviceId = getDeviceId();
  return callApi('POST', '/api/auth/check-subscription', {
    jd_username: jdUsername,
    device_id: deviceId,
    department_id: departmentId || '',
    department_name: departmentName || '',
    merchant_name: merchantName || '',
    app_version: app.getVersion()
  });
}

function assertAutomationAccess() {
  const subscription = storeGet('subscriptionInfo', {});
  if (canUseAutomation(subscription)) return;
  const error = new Error('自动化处理功能仅限有效试用用户和高级版使用');
  error.code = 'AUTOMATION_ACCESS_DENIED';
  throw error;
}

// 启动心跳
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(async () => {
    if (!currentSessionToken) return;
    try {
      const result = await callApi('POST', '/api/auth/heartbeat', {
        session_token: currentSessionToken
      });
      if (result.valid) {
        // 同步最新订阅信息（管理后台可能已修改 tier）
        const subInfo = storeGet('subscriptionInfo', {});
        const updatedSubInfo = {
          ...subInfo,
          status: result.status,
          tier: result.tier || subInfo.tier || 'basic',
          days_remaining: result.days_remaining,
          subscription_end: result.subscription_end
        };
        storeSet('subscriptionInfo', updatedSubInfo);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('subscription-info', updatedSubInfo);
        }
        return;
      }

      if (result.reason === 'session_kicked') {
        // 被踢下线：说明有新设备登录了同一事业部
        // 不自动重连，否则会与新设备互相踢，形成死循环
        }
        stopHeartbeat();
        currentSessionToken = null;
        if (mainWindow) {
          mainWindow.webContents.send(
            result.reason === 'session_kicked' ? 'session-kicked' : 'subscription-expired'
          );
        }
    } catch (err) {
      console.error('心跳失败:', err.message);
    }
  }, 60 * 1000);
}

// 停止心跳
function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// 创建订阅/付费窗口
function createSubscriptionWindow(subInfo) {
  if (subscriptionWindow) {
    subscriptionWindow.focus();
    return;
  }

  subscriptionWindow = new BrowserWindow({
    width: 520,
    height: 920,
    resizable: false,
    icon: path.join(__dirname, 'src', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  subscriptionWindow.setMenu(null);
  subscriptionWindow.loadFile(path.join(__dirname, 'src', 'subscription.html'));
  subscriptionWindow.webContents.on('did-finish-load', () => {
    subscriptionWindow.webContents.send('subscription-info', subInfo);
  });

  subscriptionWindow.on('closed', () => {
    subscriptionWindow = null;
  });
}

// 事业部选择：多事业部弹出选择窗口，单事业部自动跳过
async function selectDepartment(deptPairs) {
  // 0 或 1 个事业部，自动跳过
  if (!deptPairs || deptPairs.length <= 1) {
    if (deptPairs && deptPairs.length === 1) {
      return deptPairs[0]; // 返回唯一的事业部
    }
    return { deptNo: '', deptName: '' }; // 无事业部信息
  }

  // 多个事业部：弹出选择窗口
  return new Promise((resolve) => {
    deptSelectResolve = resolve;

    departmentSelectWindow = new BrowserWindow({
      width: 440,
      height: 520,
      resizable: false,
      frame: false,
      center: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    });

    departmentSelectWindow.setMenu(null);
    departmentSelectWindow.loadFile(path.join(__dirname, 'src', 'department-select.html'));

    departmentSelectWindow.once('ready-to-show', () => {
      departmentSelectWindow.show();
      // 发送事业部列表给渲染进程
      departmentSelectWindow.webContents.send('dept-list', deptPairs);
    });

    departmentSelectWindow.on('closed', () => {
      departmentSelectWindow = null;
      // 如果窗口被关闭但未选择（如用户按了 Alt+F4），返回默认值
      if (deptSelectResolve) {
        deptSelectResolve({ deptNo: '', deptName: '' });
        deptSelectResolve = null;
      }
    });
  });
}

// 简易本地存储（JSON 文件）
const storePath = path.join(app.getPath('userData'), 'config.json');
const ENCRYPTED_STORE_PREFIX = 'YCH-ENC-V1:';

function loadStore() {
  let raw = '';
  try {
    if (fs.existsSync(storePath)) {
      raw = fs.readFileSync(storePath, 'utf-8');
      if (raw.startsWith(ENCRYPTED_STORE_PREFIX)) {
        if (!safeStorage.isEncryptionAvailable()) {
          console.error('[存储] 系统安全存储当前不可用，暂不读取加密配置');
          return {};
        }
        try {
          const encrypted = Buffer.from(raw.slice(ENCRYPTED_STORE_PREFIX.length), 'base64');
          return JSON.parse(safeStorage.decryptString(encrypted));
        } catch (decryptError) {
          // 加密文件可能属于另一 Windows 用户或系统安全存储暂时异常，保留原文件以便恢复。
          console.error('[存储] 无法解密本地配置，已保留原文件:', decryptError.message);
          return {};
        }
      }
      return JSON.parse(raw);
    }
  } catch (e) {
    // 配置文件损坏时备份而非返回空对象覆盖
    console.error('[存储] config.json 解析失败，备份损坏文件:', e.message);
    try {
      const backupPath = storePath + '.corrupt.' + Date.now();
      fs.renameSync(storePath, backupPath);
      console.error('[存储] 损坏文件已备份至:', backupPath);
    } catch (backupErr) {
      console.error('[存储] 备份损坏文件失败:', backupErr.message);
    }
  }
  return {};
}

function saveStore(data) {
  try {
    const json = JSON.stringify(data, null, 2);
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(json).toString('base64');
      fs.writeFileSync(storePath, ENCRYPTED_STORE_PREFIX + encrypted, 'utf-8');
    } else {
      console.warn('[存储] 系统安全存储不可用，本地配置暂以明文保存');
      fs.writeFileSync(storePath, json, 'utf-8');
    }
  } catch (e) {
    console.error('[存储] 写入 config.json 失败:', e.message);
  }
}

function storeGet(key, defaultVal) {
  const data = loadStore();
  return data[key] !== undefined ? data[key] : defaultVal;
}

function storeSet(key, value) {
  const data = loadStore();
  data[key] = value;
  saveStore(data);
}

let currentUsername = ''; // 当前登录的用户名，用于按账号存储数据

// 按用户名保存数据到独立档案
function saveUserProfile(username, profileData) {
  if (!username) return;
  const profiles = storeGet('userProfiles', {});
  profiles[username] = { ...(profiles[username] || {}), ...profileData, lastLogin: Date.now() };
  storeSet('userProfiles', profiles);
}

// 加载指定用户名的缓存档案到根键
function loadUserProfile(username) {
  if (!username) return false;
  const profiles = storeGet('userProfiles', {});
  const profile = profiles[username];
  if (profile) {
    if (profile.userData) storeSet('userData', profile.userData);
    if (profile.csrfToken) storeSet('csrfToken', profile.csrfToken);
    if (profile.sellerId) storeSet('sellerId', profile.sellerId);
    if (profile.cookies) storeSet('cookies', profile.cookies);
    console.log(`已加载用户 [${username}] 的缓存数据`);
    return true;
  }
  console.log(`用户 [${username}] 无缓存数据，将从API获取`);
  return false;
}

let loginWindow = null;
let webLoginWindow = null;
let mainWindow = null;
let jdPageWindow = null; // 登录后保留的隐藏窗口，用于h5st签名的API调用
let isLoggingIn = false; // 防止重复处理登录
let activeMerchantAccountId = ''; // 当前活跃的商家端账号ID
let wmsLoginWindow = null;
let wmsLoggedIn = false; // 仅内存状态，不持久化
let wmsIsQuitting = false; // 标记应用正在退出
let isCheckingSubscription = false; // 标记正在检查订阅（防止窗口全关后退出）
let pendingUpdateAction = null; // 'autoUpdater' | 'localPath' | null — 标记待执行的更新安装方式
let pendingCredentials = null; // 待自动填充的凭据（商家端）
let pendingWmsCredentials = null; // 待自动填充的凭据（WMS端）

// 获取当前商家端的 session 分区名
function getMerchantPartition() {
  if (activeMerchantAccountId) {
    return cookieManager.getPartitionName('merchant', activeMerchantAccountId);
  }
  return null; // 返回 null 表示使用 session.defaultSession
}

// 获取当前商家端的 session 实例
function getMerchantSession() {
  const partition = getMerchantPartition();
  if (partition) {
    return session.fromPartition(partition);
  }
  return session.defaultSession;
}

function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 620,
    height: 400,
    resizable: false,
    frame: false,
    center: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  loginWindow.loadFile(path.join(__dirname, 'src', 'login.html'));

  loginWindow.on('closed', () => {
    loginWindow = null;
    if (!mainWindow && !webLoginWindow && !isCheckingSubscription) {
      app.quit();
    }
  });
}

async function createWebLoginWindow() {
  // 设置当前登录用户名
  currentUsername = (pendingCredentials && pendingCredentials.username) || '';
  const lastLoginUser = storeGet('lastLoginUser', '');

  // 确定商家端账号ID（从 credentialList 匹配或创建新ID）
  if (currentUsername) {
    const merchantAccounts = storeGet('merchantAccounts', []);
    const existing = merchantAccounts.find(a => a.username === currentUsername);
    if (existing) {
      activeMerchantAccountId = existing.id;
    } else {
      // 新账号，先创建 merchantAccount 条目
      const newId = crypto.randomUUID();
      activeMerchantAccountId = newId;
      merchantAccounts.push({
        id: newId,
        username: currentUsername,
        password: (pendingCredentials && pendingCredentials.password) || '',
        lastLogin: Date.now()
      });
      storeSet('merchantAccounts', merchantAccounts);
    }
    storeSet('lastMerchantAccountId', activeMerchantAccountId);
  }

  const merchantPartition = getMerchantPartition();

  // 从 cookie 文件恢复 session（免登录）
  // 注意：session cookie 在 Electron 重启后会丢失，即使 persist: 分区也不保留
  // 因此每次都需要从 cookie 文件导入，确保 session cookie 被恢复
  if (activeMerchantAccountId && cookieManager.validateCookieFile('merchant', activeMerchantAccountId)) {
    console.log(`商家端: 从 cookie 文件恢复 session（免登录）, 账号: [${currentUsername}], ID: [${activeMerchantAccountId}]`);
    const ses = getMerchantSession();
    const imported = await cookieManager.importCookies(ses, 'merchant', activeMerchantAccountId);
    console.log(`商家端: cookie 导入结果: ${imported ? '成功' : '失败'}`);
    // 诊断日志：导入后验证 session 中的 cookie
    try {
      const allCookies = await ses.cookies.get({ domain: '.jdl.com' });
      const jdCookies = await ses.cookies.get({ domain: '.jd.com' });
      console.log(`商家端: session 中恢复了 ${allCookies.length} 条 .jdl.com + ${jdCookies.length} 条 .jd.com cookie`);
    } catch (e) {}
  } else {
    console.log(`商家端: 无有效 cookie 文件, accountId=[${activeMerchantAccountId}], validate=${activeMerchantAccountId ? cookieManager.validateCookieFile('merchant', activeMerchantAccountId) : 'N/A'}`);
    if (currentUsername && currentUsername !== lastLoginUser) {
      // 切换到新账号但无有效 cookie 文件，清除 session
      console.log(`账号切换: [${lastLoginUser}] → [${currentUsername}]，无有效 cookie 文件，清除 session`);
      const ses = getMerchantSession();
      await ses.clearStorageData({ storages: ['cookies'] });
    }
  }

  // 记录本次登录的用户名
  if (currentUsername) {
    storeSet('lastLoginUser', currentUsername);
  }

  // 使用商家端分区创建窗口（如有分区则使用独立分区，否则 defaultSession）
  const webPrefs = {
    contextIsolation: true,
    nodeIntegration: false
  };
  if (merchantPartition) {
    webPrefs.partition = merchantPartition;
  }

  webLoginWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    center: true,
    title: '京东物流 - 登录',
    webPreferences: webPrefs
  });

  isLoggingIn = false;
  webLoginWindow.loadURL('https://o.jdl.com');

  // 监听页面跳转，检测登录状态
  webLoginWindow.webContents.on('did-navigate', async (event, url) => {
    console.log(`商家端导航: ${url}`);
    await checkLoginStatus(url);
  });
  webLoginWindow.webContents.on('did-navigate-in-page', async (event, url) => {
    console.log(`商家端页内导航: ${url}`);
    await checkLoginStatus(url);
  });

  // 页面加载完成后自动填充账号密码
  webLoginWindow.webContents.on('did-finish-load', async () => {
    if (!webLoginWindow) return; // 窗口已转为jdPageWindow
    if (!pendingCredentials || !pendingCredentials.username) return;
    const currentUrl = webLoginWindow.webContents.getURL();
    if (!currentUrl.includes('passport') && !currentUrl.includes('login')) return;

    const { username, password } = pendingCredentials;
    const fillScript = `
      (function() {
        // 京东登录页账号密码填充
        var tryFill = function() {
          var nameInput = document.getElementById('loginname') || document.querySelector('input[name="loginname"]') || document.querySelector('input[name="nloginname"]');
          var pwdInput = document.getElementById('nloginpwd') || document.querySelector('input[name="loginpwd"]') || document.querySelector('input[name="nloginpwd"]');
          if (nameInput && pwdInput) {
            var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(nameInput, ${JSON.stringify(username)});
            nameInput.dispatchEvent(new Event('input', { bubbles: true }));
            nameInput.dispatchEvent(new Event('change', { bubbles: true }));
            nativeInputValueSetter.call(pwdInput, ${JSON.stringify(password)});
            pwdInput.dispatchEvent(new Event('input', { bubbles: true }));
            pwdInput.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
          return false;
        };
        if (!tryFill()) { setTimeout(tryFill, 500); }
        if (!tryFill()) { setTimeout(tryFill, 1500); }
      })();
    `;
    try {
      await webLoginWindow.webContents.executeJavaScript(fillScript);
      console.log('自动填充账号密码完成');
    } catch (e) {
      console.log('自动填充失败:', e.message);
    }
  });

  webLoginWindow.on('closed', () => {
    // 如果窗口已转为jdPageWindow，清理jdPageWindow引用
    if (jdPageWindow === webLoginWindow || !webLoginWindow) {
      jdPageWindow = null;
    }
    webLoginWindow = null;
    if (!mainWindow && !loginWindow && !isCheckingSubscription && !jdPageWindow) {
      app.quit();
    }
  });
}

async function checkLoginStatus(url) {
  if (!webLoginWindow) return;
  if (isLoggingIn) return;

  // 登录/SSO 页面，跳过
  if (url.includes('passport') || url.includes('login') || url.includes('sso')) {
    return;
  }

  // 检测 o.jdl.com 登录成功
  if (!url.includes('o.jdl.com')) return;

  isLoggingIn = true;
  console.log('商家端登录成功，开始获取业务数据...');

  try {
    // 获取 Cookie
    const cookies = await webLoginWindow.webContents.session.cookies.get({ domain: '.jdl.com' });
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    storeSet('cookies', cookieStr);

    // 等待页面加载稳定
    await new Promise(resolve => setTimeout(resolve, 500));

    // 从 API 获取真实用户数据（sellerId 从事业部数据中动态获取）
    let userData = {
      departmentName: '已登录用户',
      departmentId: '',
      shops: [],
      suppliers: [],
      warehouses: []
    };

    const apiData = await fetchUserDataFromApi();

    if (apiData && !apiData.error) {
      console.log('动态获取的 sellerId:', apiData.sellerId || '(空)');

      // 诊断：打印 shopData 原始返回结构
      if (apiData.shopData) {
        const shopKeys = Object.keys(apiData.shopData);
        console.log('[诊断] shopData keys:', shopKeys.join(','));
        console.log('[诊断] shopData.aaData:', apiData.shopData.aaData ? `Array(${apiData.shopData.aaData.length})` : typeof apiData.shopData.aaData);
        console.log('[诊断] shopData.data:', apiData.shopData.data ? `Array(${apiData.shopData.data.length})` : typeof apiData.shopData.data);
        console.log('[诊断] shopData.error:', apiData.shopData.error || '(none)');
        if (apiData.shopData.error) {
          console.log('[诊断] shopData.raw:', apiData.shopData.raw || '(none)');
        }
        console.log('[诊断] shopData (first 300):', JSON.stringify(apiData.shopData).substring(0, 300));
      } else {
        console.log('[诊断] shopData is null/undefined');
      }

      // 解析店铺数据
      let shopList = [];
      if (apiData.shopData) {
        shopList = apiData.shopData.aaData || apiData.shopData.data || (Array.isArray(apiData.shopData) ? apiData.shopData : []);
        const iTotalRecords = apiData.shopData.iTotalRecords || apiData.shopData.iTotalDisplayRecords || '?';
        console.log(`[API] 店铺原始数据条数: ${Array.isArray(shopList) ? shopList.length : '非数组'}, iTotalRecords: ${iTotalRecords}`);
        // 统计每个 deptId 的店铺数量
        if (Array.isArray(shopList) && shopList.length > 0) {
          const deptCount = {};
          shopList.forEach(s => { const k = String(s.deptId || '(空)'); deptCount[k] = (deptCount[k] || 0) + 1; });
          console.log('[API] 店铺按deptId分布:', JSON.stringify(deptCount));
          // 调试：打印第1条店铺的完整原始数据（查看所有字段名）
          console.log(`[API] 店铺[0] 完整原始数据:`, JSON.stringify(shopList[0]));
          // 打印前3条的预设字段值（对比用）
          shopList.slice(0, 3).forEach((s, i) => {
            console.log(`[API] 店铺[${i}] shopNo=${s.shopNo} shopName=${s.shopName} deptId=${s.deptId} deptNo=${s.deptNo} deptName=${s.deptName} sellerId=${s.sellerId}`);
          });
          userData.shops = shopList.map(s => ({
            shopId: s.shopNo || s.shopId || s.id || '',
            spShopNo: s.spShopNo || '',
            shopName: s.shopName || s.name || '',
            deptId: s.deptId || '',
            deptNo: s.deptNo || '',
            deptName: s.deptName || '',
            sellerId: String(s.sellerId || '')
          }));

          const firstShop = shopList[0];
          if (firstShop.deptName) {
            userData.departmentName = firstShop.deptName;
          }
          if (firstShop.deptId) {
            userData.departmentId = 'CBU' + firstShop.deptId;
          }
        }
        console.log(`获取到 ${userData.shops.length} 个店铺`);
      }

      // 事业部信息
      if (!userData.departmentId && apiData.deptData && !apiData.deptData.error) {
        let deptList = apiData.deptData.data
          || apiData.deptData.aaData
          || apiData.deptData.deptList
          || apiData.deptData.result
          || (Array.isArray(apiData.deptData) ? apiData.deptData : null);
        if (!deptList) {
          for (const val of Object.values(apiData.deptData)) {
            if (Array.isArray(val) && val.length > 0) { deptList = val; break; }
          }
        }
        if (Array.isArray(deptList) && deptList.length > 0) {
          userData.departmentName = deptList[0].deptName || deptList[0].name || userData.departmentName;
          userData.departmentId = deptList[0].deptNo || deptList[0].deptId || userData.departmentId;
          userData.merchantName = deptList[0].sellerName || '';
        }
      }

      // 商家名称和事业部列表（从 deptData 提取，支持多条记录）
      if (apiData.deptData && !apiData.deptData.error) {
        let deptList = apiData.deptData.data
          || apiData.deptData.aaData
          || apiData.deptData.deptList
          || apiData.deptData.result
          || (Array.isArray(apiData.deptData) ? apiData.deptData : null);
        if (!deptList) {
          for (const val of Object.values(apiData.deptData)) {
            if (Array.isArray(val) && val.length > 0) { deptList = val; break; }
          }
        }
        if (Array.isArray(deptList) && deptList.length > 0) {
          if (!userData.merchantName) {
            userData.merchantName = deptList[0].sellerName || '';
          }
          // 调试：打印事业部完整原始数据
          console.log(`[API] 事业部[0] 完整原始数据:`, JSON.stringify(deptList[0]));
          deptList.forEach((d, i) => {
            console.log(`[API] 事业部[${i}] deptNo=${d.deptNo} deptName=${d.deptName} sellerId=${d.sellerId} sellerName=${d.sellerName}`);
          });
          // 收集全部不重复的商家名称和事业部名称
          const merchantSet = new Set();
          const deptSet = new Set();
          const deptPairs = [];
          deptList.forEach(d => {
            if (d.sellerName) merchantSet.add(d.sellerName);
            const displayName = d.deptName || d.sellerName || '';
            if (displayName) {
              deptSet.add(displayName);
              if (!deptPairs.find(p => p.deptNo === (d.deptNo || ''))) {
                deptPairs.push({ id: String(d.id || d.deptId || ''), deptNo: d.deptNo || '', deptName: displayName, sellerId: String(d.sellerId || ''), sellerName: d.sellerName || '' });
              }
            }
          });
          userData.merchantList = [...merchantSet];
          userData.deptList = [...deptSet];
          userData.deptPairs = deptPairs;

          // 用事业部列表匹配店铺的 deptNo（shop API 返回的 deptNo 始终为 null，需从 deptList 补全）
          // 关系：shop.deptId === dept.id → shop.deptNo = dept.deptNo
          const deptIdMap = {};
          deptList.forEach(d => {
            if (d.id) deptIdMap[String(d.id)] = d.deptNo || '';
          });
          let matched = 0;
          userData.shops.forEach(shop => {
            if (!shop.deptNo && shop.deptId) {
              const matchedDeptNo = deptIdMap[String(shop.deptId)];
              if (matchedDeptNo) {
                shop.deptNo = matchedDeptNo;
                matched++;
              }
            }
          });
          if (matched > 0) {
            console.log(`[店铺-事业部匹配] 成功匹配 ${matched}/${userData.shops.length} 个店铺的 deptNo`);
          } else if (userData.shops.length > 0) {
            console.warn(`[店铺-事业部匹配] 未匹配任何店铺！deptIdMap:`, JSON.stringify(deptIdMap), '店铺deptId列表:', userData.shops.map(s => String(s.deptId)));
          }
        }
      }

      // 解析供应商数据
      if (apiData.supplierData) {
        const supplierList = apiData.supplierData.aaData || apiData.supplierData.data || [];
        if (Array.isArray(supplierList)) {
          userData.suppliers = supplierList.map(s => ({
            supplierId: s.supplierNo || '',
            supplierName: s.supplierName || '',
            deptName: s.deptName || ''
          }));
        }
        console.log(`获取到 ${userData.suppliers.length} 个供应商`);
      }

      // 解析仓库数据
      if (apiData.warehouseData) {
        const whList = apiData.warehouseData.aaData || apiData.warehouseData.data || [];
        if (Array.isArray(whList)) {
          userData.warehouses = whList.map(w => ({
            warehouseId: w.warehouseNo || '',
            warehouseName: w.warehouseName || ''
          }));
        }
        console.log(`获取到 ${userData.warehouses.length} 个仓库`);
      }

      // 保存 csrfToken
      if (apiData.csrfToken) {
        storeSet('csrfToken', apiData.csrfToken);
      }

      // 保存动态获取的 sellerId
      if (apiData.sellerId) {
        storeSet('sellerId', apiData.sellerId);
      }

      console.log('用户数据获取完成:', JSON.stringify({
        department: userData.departmentName,
        departmentId: userData.departmentId,
        merchantName: userData.merchantName || '(未获取)',
        shopCount: userData.shops.length,
        supplierCount: userData.suppliers.length,
        warehouseCount: userData.warehouses.length,
        sellerId: apiData.sellerId || '(未获取)'
      }));
    } else {
      console.error('API数据获取失败:', apiData?.error || '未知错误');
    }

    storeSet('userData', userData);

    // 保存到按用户名隔离的档案（包含 session cookie）
    if (currentUsername) {
      saveUserProfile(currentUsername, {
        userData,
        csrfToken: storeGet('csrfToken', ''),
        sellerId: storeGet('sellerId', ''),
        cookies: storeGet('cookies', '')
      });
      console.log(`用户档案已保存: [${currentUsername}]`);
    }

    // 导出商家端 cookie 到文件
    if (activeMerchantAccountId) {
      const ses = getMerchantSession();
      const exported = await cookieManager.exportCookies(ses, 'merchant', activeMerchantAccountId);
      // 诊断日志：列出 cookie 文件内容摘要
      try {
        const cookieFilePath = cookieManager.getCookieFilePath('merchant', activeMerchantAccountId);
        const raw = fs.readFileSync(cookieFilePath, 'utf-8');
        const data = JSON.parse(raw);
        const names = data.cookies.map(c => c.name).join(', ');
        const sessionCount = data.cookies.filter(c => !c.expirationDate).length;
        console.log(`商家端 cookie 导出完成: 总计 ${data.cookies.length} 条, 其中 session cookie ${sessionCount} 条`);
        console.log(`商家端 cookie 名称: ${names}`);
      } catch (e) {}

      // 更新 merchantAccounts 中的 lastLogin
      const merchantAccounts = storeGet('merchantAccounts', []);
      const idx = merchantAccounts.findIndex(a => a.id === activeMerchantAccountId);
      if (idx >= 0) {
        merchantAccounts[idx].lastLogin = Date.now();
        merchantAccounts[idx].departmentName = userData.departmentName || '';
        storeSet('merchantAccounts', merchantAccounts);
      }
    }

    // ====== 订阅检查 ======
    isCheckingSubscription = true; // 防止关窗后 app.quit

    // 登录窗口转为隐藏的JD页面窗口（保留session用于h5st签名API调用）
    if (webLoginWindow) {
      jdPageWindow = webLoginWindow;
      webLoginWindow = null;
      jdPageWindow.hide();
      console.log('京配打标: 登录窗口已保留为隐藏窗口（不跳转，使用当前页面）');
    }
    if (loginWindow) {
      loginWindow.close();
      loginWindow = null;
    }

    const jdUsername = storeGet('credentials', {}).username || '';
    const merchantName = userData.merchantName || '';

    // 事业部选择：多事业部时弹出选择窗口，单事业部自动跳过
    const deptPairs = userData.deptPairs || [];
    const selectedDept = await selectDepartment(deptPairs);
    const departmentId = selectedDept.deptNo || userData.departmentId || '';
    const departmentName = selectedDept.deptName || selectedDept.sellerName || userData.departmentName || merchantName || '';

    // 存储选中的事业部信息
    userData.selectedDeptId = departmentId;
    userData.selectedDeptName = departmentName;
    storeSet('userData', userData);

    console.log('事业部选择:', departmentId, departmentName || '(自动)');

    try {
      const subResult = await checkSubscription(jdUsername, departmentId, merchantName, departmentName);
      console.log('订阅状态:', subResult.status, '剩余天数:', subResult.days_remaining);

      if (subResult.status === 'active' || subResult.status === 'trial') {
        // 订阅有效，进入主窗口
        currentSessionToken = subResult.session_token;
        storeSet('subscriptionInfo', {
          status: subResult.status,
          tier: subResult.tier || 'basic',
          invite_code: subResult.invite_code,
          days_remaining: subResult.days_remaining,
          subscription_end: subResult.subscription_end,
          trial_end: subResult.trial_end,
          is_first_payment: subResult.is_first_payment,
          department_id: departmentId,
          department_name: departmentName
        });
        isCheckingSubscription = false;
        isLoggingIn = false;
        createMainWindow();
        startHeartbeat();
      } else {
        // 订阅过期，进入付费窗口
        isCheckingSubscription = false;
        // 也存储 subscriptionInfo，确保后续 open-subscription 能拿到 department_id
        storeSet('subscriptionInfo', {
          status: subResult.status,
          tier: subResult.tier || 'basic',
          invite_code: subResult.invite_code,
          days_remaining: subResult.days_remaining,
          subscription_end: subResult.subscription_end,
          trial_end: subResult.trial_end,
          is_first_payment: subResult.is_first_payment,
          department_id: subResult.department_id || departmentId,
          department_name: subResult.department_name || departmentName
        });
        createSubscriptionWindow({
          jd_username: jdUsername,
          status: subResult.status,
          tier: subResult.tier || 'basic',
          invite_code: subResult.invite_code,
          is_first_payment: subResult.is_first_payment,
          department_id: subResult.department_id || departmentId,
          department_name: subResult.department_name || departmentName
        });
      }
    } catch (subErr) {
      console.error('订阅检查失败:', subErr.message);
      isCheckingSubscription = false;
      // 服务器不可达时提示
      dialog.showMessageBox({
        type: 'error',
        title: '连接失败',
        message: '无法连接到授权服务器，请检查网络连接后重试。',
        buttons: ['重试', '退出']
      }).then(({ response }) => {
        if (response === 0) {
          createLoginWindow();
        } else {
          app.quit();
        }
      });
    }
  } catch (err) {
    console.error('登录处理失败:', err);
    isCheckingSubscription = false;
    isLoggingIn = false;
  }
}

// ========== 从API获取用户数据 ==========
async function fetchUserDataFromApi() {
  if (!webLoginWindow) return null;

  try {
    const result = await webLoginWindow.webContents.executeJavaScript(`
      (async () => {
        try {
          // 尝试多种方式获取 csrfToken
          let csrfToken = '';
          // 1. 从 meta 标签获取
          const metaEl = document.querySelector('meta[name="csrfToken"]') || document.querySelector('meta[name="csrf-token"]');
          if (metaEl) csrfToken = metaEl.getAttribute('content') || '';
          // 2. 从 cookie 获取
          if (!csrfToken) {
            const m = document.cookie.match(/csrfToken=([^;]+)/);
            if (m) csrfToken = m[1];
          }
          // 3. 从全局变量获取
          if (!csrfToken && window.csrfToken) csrfToken = window.csrfToken;

          // 第一步：获取事业部列表，从中提取 sellerId
          let deptData = null;
          let sellerId = '';
          try {
            const dParams = new URLSearchParams();
            dParams.set('csrfToken', csrfToken);
            dParams.set('deptNo', '');
            dParams.set('sellerNo', '');
            dParams.set('status', '');
            dParams.set('aoData', JSON.stringify([
              {"name":"sEcho","value":1},
              {"name":"iColumns","value":7},
              {"name":"sColumns","value":",,,,,,"},
              {"name":"iDisplayStart","value":0},
              {"name":"iDisplayLength","value":10},
              {"name":"mDataProp_0","value":0},
              {"name":"bSortable_0","value":false},
              {"name":"mDataProp_1","value":1},
              {"name":"bSortable_1","value":false},
              {"name":"mDataProp_2","value":"deptNo"},
              {"name":"bSortable_2","value":true},
              {"name":"mDataProp_3","value":"deptName"},
              {"name":"bSortable_3","value":true},
              {"name":"mDataProp_4","value":"sellerNo"},
              {"name":"bSortable_4","value":true},
              {"name":"mDataProp_5","value":"sellerName"},
              {"name":"bSortable_5","value":true},
              {"name":"mDataProp_6","value":"statusStr"},
              {"name":"bSortable_6","value":true},
              {"name":"iSortCol_0","value":4},
              {"name":"sSortDir_0","value":"desc"},
              {"name":"iSortingCols","value":1}
            ]));

            const deptResp = await fetch('https://o.jdl.com/dept/queryDeptList.do?rand=' + Math.random(), {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest'
              },
              body: dParams.toString()
            });
            deptData = await deptResp.json();

            // aaData[0].sellerId 就是我们需要的值
            const deptList = deptData.aaData || deptData.data || [];
            if (Array.isArray(deptList) && deptList.length > 0) {
              sellerId = String(deptList[0].sellerId || '');
            }
          } catch (e) {
            deptData = { error: e.message };
          }

          // 获取全部店铺列表（设置 iDisplayLength=1000 拉取全部）
          let shopData = null;
          try {
            const params = new URLSearchParams();
            params.set('csrfToken', csrfToken);
            params.set('shopNo', '');
            params.set('deptId', '');
            params.set('type', '');
            params.set('spSource', '');
            params.set('bizType', '');
            params.set('isvShopNo', '');
            params.set('sourceChannel', '');
            params.set('status', '7');
            params.set('iDisplayStart', '0');
            params.set('iDisplayLength', '2000');
            params.set('aoData', '0,2000');

            const shopResp = await fetch('https://o.jdl.com/shop/queryShopList.do', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest'
              },
              body: params.toString()
            });
            console.log('[API] shopResp status:', shopResp.status, shopResp.statusText);
            const shopText = await shopResp.text();
            console.log('[API] shopResp body (first 500):', shopText.substring(0, 500));
            try { shopData = JSON.parse(shopText); } catch(pe) { shopData = { error: 'JSON parse error: ' + pe.message, raw: shopText.substring(0, 200) }; }
          } catch (e) {
            console.error('[API] shop fetch error:', e.message);
            shopData = { error: e.message };
          }

          // 获取供应商列表
          let supplierData = null;
          try {
            const sParams = new URLSearchParams();
            sParams.set('csrfToken', csrfToken);
            sParams.set('sellerId', '');
            sParams.set('deptId', '');
            sParams.set('status', '');
            sParams.set('supplierNo', '');
            sParams.set('supplierName', '');
            sParams.set('aoData', JSON.stringify([
              {"name":"sEcho","value":1},
              {"name":"iColumns","value":6},
              {"name":"sColumns","value":",,,,,"},
              {"name":"iDisplayStart","value":0},
              {"name":"iDisplayLength","value":1000},
              {"name":"mDataProp_0","value":0},
              {"name":"bSortable_0","value":false},
              {"name":"mDataProp_1","value":1},
              {"name":"bSortable_1","value":false},
              {"name":"mDataProp_2","value":"supplierNo"},
              {"name":"bSortable_2","value":true},
              {"name":"mDataProp_3","value":"supplierName"},
              {"name":"bSortable_3","value":true},
              {"name":"mDataProp_4","value":"deptName"},
              {"name":"bSortable_4","value":true},
              {"name":"mDataProp_5","value":"statusStr"},
              {"name":"bSortable_5","value":true},
              {"name":"iSortCol_0","value":2},
              {"name":"sSortDir_0","value":"desc"},
              {"name":"iSortingCols","value":1}
            ]));

            const supplierResp = await fetch('https://o.jdl.com/supplier/querySupplierList.do?rand=' + Math.random(), {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest'
              },
              body: sParams.toString()
            });
            supplierData = await supplierResp.json();
          } catch (e) {
            supplierData = { error: e.message };
          }

          // 获取仓库列表
          let warehouseData = null;
          try {
            const wParams = new URLSearchParams();
            wParams.set('csrfToken', csrfToken);
            wParams.set('sellerId', sellerId);
            wParams.set('deptId', '');
            wParams.set('warehouseNo', '');
            wParams.set('warehouseName', '');
            wParams.set('warehouseType', '');
            wParams.set('isSalesReturn', '');
            wParams.set('effectTimeStart', '');
            wParams.set('effectTimeEnd', '');
            wParams.set('aoData', JSON.stringify([
              {"name":"sEcho","value":1},
              {"name":"iColumns","value":10},
              {"name":"sColumns","value":",,,,,,,,,"},
              {"name":"iDisplayStart","value":0},
              {"name":"iDisplayLength","value":1000},
              {"name":"mDataProp_0","value":0},
              {"name":"bSortable_0","value":false},
              {"name":"mDataProp_1","value":"deptName"},
              {"name":"bSortable_1","value":true},
              {"name":"mDataProp_2","value":"warehouseNo"},
              {"name":"bSortable_2","value":true},
              {"name":"mDataProp_3","value":"warehouseName"},
              {"name":"bSortable_3","value":true},
              {"name":"mDataProp_4","value":"warehouseTypeStr"},
              {"name":"bSortable_4","value":true},
              {"name":"mDataProp_5","value":"isSalesReturn"},
              {"name":"bSortable_5","value":true},
              {"name":"mDataProp_6","value":"effectTime"},
              {"name":"bSortable_6","value":true},
              {"name":"mDataProp_7","value":"effectOperateUser"},
              {"name":"bSortable_7","value":true},
              {"name":"mDataProp_8","value":"updateTime"},
              {"name":"bSortable_8","value":true},
              {"name":"mDataProp_9","value":"updateUser"},
              {"name":"bSortable_9","value":true},
              {"name":"iSortCol_0","value":6},
              {"name":"sSortDir_0","value":"desc"},
              {"name":"iSortingCols","value":1}
            ]));

            const whResp = await fetch('https://o.jdl.com/warehouseOpen/queryWarehouseOpenList.do?rand=' + Math.random(), {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest'
              },
              body: wParams.toString()
            });
            warehouseData = await whResp.json();
          } catch (e) {
            warehouseData = { error: e.message };
          }

          return JSON.stringify({ deptData, shopData, supplierData, warehouseData, csrfToken, sellerId });
        } catch (e) {
          return JSON.stringify({ error: e.message });
        }
      })()
    `);

    return JSON.parse(result);
  } catch (err) {
    console.error('获取API数据失败:', err);
    return null;
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1340,
    height: 780,
    minWidth: 1200,
    minHeight: 700,
    frame: false,
    center: true,
    icon: path.join(__dirname, 'src', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // 去掉京东图片CDN的Referer头，防止防盗链导致图片加载失败
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ['*://*.jd.com/*', '*://*.jdcloud.com/*', '*://*.360buyimg.com/*'] },
    (details, callback) => {
      delete details.requestHeaders['Referer'];
      delete details.requestHeaders['referer'];
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  // F12 打开/关闭开发者工具
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  let isAppQuitting = false;
  app.on('before-quit', () => { isAppQuitting = true; });

  mainWindow.on('close', (event) => {
    if (!isAppQuitting && !isCheckingSubscription) {
      event.preventDefault();
      // 用户手动关闭窗口时，清除待执行的更新安装动作
      pendingUpdateAction = null;
      // 通知渲染进程显示自定义退出确认弹窗
      mainWindow.webContents.send('show-close-confirm');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // 主窗口关闭时销毁所有隐藏窗口，确保进程退出
    wmsIsQuitting = true;
    if (wmsLoginWindow && !wmsLoginWindow.isDestroyed()) {
      wmsLoginWindow.destroy();
      wmsLoginWindow = null;
    }
    if (jdPageWindow && !jdPageWindow.isDestroyed()) {
      jdPageWindow.destroy();
      jdPageWindow = null;
    }
    if (shopPageWindow && !shopPageWindow.isDestroyed()) {
      shopPageWindow.destroy();
      shopPageWindow = null;
    }
    if (webLoginWindow && !webLoginWindow.isDestroyed()) {
      webLoginWindow.destroy();
      webLoginWindow = null;
    }
    // 停止心跳
    stopHeartbeat();
    currentSessionToken = null;
  });
}

// ========== 自动更新 ==========
// 完整安装包由本流程显式触发下载，以便准确控制启动窗口、差分失败兜底和安装时机。
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.disableDifferentialDownload = false;
autoUpdater.disableWebInstaller = true;

let autoUpdaterActive = false;
let automaticUpdateFlow = null;
let automaticInstallScheduled = false;
let activeUpdateContext = 'startup';
let activeUpdateMetadata = null;
let periodicUpdateTimer = null;

function getActiveUpdateWindow(context = activeUpdateContext) {
  if (context === 'startup' && loginWindow && !loginWindow.isDestroyed()) return loginWindow;
  const candidates = [mainWindow, subscriptionWindow, loginWindow];
  return candidates.find(win => win && !win.isDestroyed()) || null;
}

function sendUpdateWindowEvent(channel, payload = {}, context = activeUpdateContext) {
  const win = getActiveUpdateWindow(context);
  if (win && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
  return win;
}

function normalizeUpdateNotes(notes) {
  if (!notes) return '';
  if (typeof notes === 'string') return notes.trim();
  if (Array.isArray(notes)) {
    return notes.map(item => normalizeUpdateNotes(item && (item.note || item))).filter(Boolean).join('\n');
  }
  if (typeof notes === 'object' && notes.note) return normalizeUpdateNotes(notes.note);
  return '';
}

function showAutomaticUpdate(metadata, context = activeUpdateContext) {
  const payload = {
    version: metadata.version,
    changelog: normalizeUpdateNotes(metadata.changelog || metadata.releaseNotes)
      || '本次更新包含稳定性与体验优化。'
  };
  const win = sendUpdateWindowEvent('show-update-downloading', payload, context);
  if (context === 'startup' && win && !win.isVisible()) win.show();
}

function scheduleAutomaticInstall(action, installerPath = null) {
  if (automaticInstallScheduled) return;
  automaticInstallScheduled = true;
  pendingUpdateAction = action;
  if (installerPath) global._pendingUpdateInstaller = installerPath;

  sendUpdateProgress('installing', {
    version: activeUpdateMetadata && activeUpdateMetadata.version,
    changelog: activeUpdateMetadata && activeUpdateMetadata.changelog
  });

  setTimeout(async () => {
    try {
      if (action === 'localPath') {
        const openError = await shell.openPath(installerPath);
        if (openError) throw new Error(openError);
        app.quit();
      } else {
        autoUpdater.quitAndInstall(false, true);
      }
    } catch (err) {
      automaticInstallScheduled = false;
      console.error('自动安装更新失败:', err.message);
      sendUpdateWindowEvent('show-update-download-failed', {
        message: '更新安装启动失败，请重新启动软件后再试'
      });
    }
  }, 1200);
}

autoUpdater.on('checking-for-update', () => {
  console.log('正在检查更新...');
});

autoUpdater.on('update-available', (info) => {
  console.log('发现新版本:', info.version);
});

autoUpdater.on('update-not-available', () => {
  console.log('当前已是最新版本');
});

autoUpdater.on('download-progress', (progress) => {
  const payload = {
    percent: Math.max(0, Math.min(100, Math.round(progress.percent || 0))),
    bytesPerSecond: Number(progress.bytesPerSecond) || 0,
    transferred: Number(progress.transferred) || 0,
    total: Number(progress.total) || 0
  };
  payload.etaSeconds = payload.bytesPerSecond > 0 && payload.total > payload.transferred
    ? Math.ceil((payload.total - payload.transferred) / payload.bytesPerSecond)
    : 0;
  console.log(`更新下载进度: ${payload.percent}%`);
  sendUpdateWindowEvent('update-download-progress', payload);
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('更新下载完成:', info.version);
  autoUpdaterActive = false;
  global._pendingUpdateInstaller = null;
  scheduleAutomaticInstall('autoUpdater');
});

autoUpdater.on('error', (err) => {
  console.error('Electron 自动更新错误:', err.message);
  autoUpdaterActive = false;
});

// ========== 服务器端全量更新检测（不依赖GitHub） ==========
// 快速检查全量更新是否可用（仅 HTTP 查版本，不下载）
async function checkFullUpdateAvailable() {
  try {
    const currentVersion = app.getVersion();
    const checkUrl = `${API_BASE_URL}/api/update/full-check?version=${currentVersion}`;
    const checkData = await new Promise((resolve, reject) => {
      const req = net.request(checkUrl);
      req.on('response', (response) => {
        let data = '';
        let received = 0;
        response.on('data', chunk => {
          received += chunk.length;
          if (received > MAX_UPDATE_METADATA_SIZE) {
            response.destroy();
            reject(new Error('更新元数据响应过大'));
            return;
          }
          data += chunk;
        });
        response.on('end', () => {
          if (response.statusCode !== 200) return reject(new Error(`HTTP ${response.statusCode}`));
          try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('解析响应失败')); }
        });
      });
      req.on('error', reject);
      req.end();
    });

    if (checkData.needUpdate && checkData.downloadUrl) {
      if (!VERSION_PATTERN.test(String(checkData.version || '')) || !isNewerVersion(checkData.version, currentVersion)) {
        throw new Error('服务器返回了无效的更新版本号');
      }
      getAllowedUpdateUrl(checkData.downloadUrl);
      if (!SHA512_BASE64_PATTERN.test(String(checkData.sha512 || ''))) {
        throw new Error('完整安装包缺少有效的 SHA-512 校验值');
      }
      const expectedSize = Number(checkData.size);
      if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > MAX_FULL_UPDATE_SIZE) {
        throw new Error('服务器返回了无效的完整安装包大小');
      }
      console.log('全量更新检测: 发现新版本', checkData.version);
      return checkData;
    }
    console.log('全量更新检测: 当前已是最新版本');
  } catch (e) {
    console.log('全量更新检测失败:', e.message);
  }
  return null;
}

// 下载并安装全量更新包
async function downloadAndInstallFullUpdate(checkData, context = activeUpdateContext) {
  const downloadUrl = getAllowedUpdateUrl(checkData.downloadUrl).toString();
  const tempDir = app.getPath('temp');
  if (!VERSION_PATTERN.test(String(checkData.version || ''))) {
    throw new Error('无效的完整更新版本号');
  }
  const filename = `ychelper-setup-${checkData.version}.exe`;
  const savePath = path.join(tempDir, filename);
  const expectedSize = Number(checkData.size);
  activeUpdateMetadata = checkData;
  activeUpdateContext = context;

  showAutomaticUpdate(checkData, context);

  try {
    if (fs.existsSync(savePath)) {
      const existingSize = fs.statSync(savePath).size;
      if (existingSize === expectedSize && verifyFileSHA512(savePath, checkData.sha512)) {
        console.log('完整更新: 复用已校验的本地安装包');
        scheduleAutomaticInstall('localPath', savePath);
        return true;
      }
      if (existingSize > expectedSize || existingSize === expectedSize) {
        fs.unlinkSync(savePath);
      }
    }

    await new Promise((resolve, reject) => {
      const https = require('https');
      const http = require('http');
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      function requestFile(currentUrl, redirectCount = 0, allowResume = true) {
        let parsed;
        try {
          parsed = getAllowedUpdateUrl(currentUrl, downloadUrl);
        } catch (err) {
          fail(err);
          return;
        }
        const mod = parsed.protocol === 'https:' ? https : http;
        const resumeOffset = allowResume && fs.existsSync(savePath) ? fs.statSync(savePath).size : 0;
        const headers = resumeOffset > 0 ? { Range: `bytes=${resumeOffset}-` } : {};
        const req = mod.get(parsed, { headers }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            if (redirectCount >= 3) return fail(new Error('更新下载重定向次数过多'));
            requestFile(new URL(res.headers.location, parsed).toString(), redirectCount + 1, allowResume);
            return;
          }
          if (res.statusCode === 416 && resumeOffset > 0) {
            res.resume();
            try { fs.unlinkSync(savePath); } catch (_) {}
            requestFile(downloadUrl, 0, false);
            return;
          }
          downloadFile(res, resumeOffset);
        });
        req.setTimeout(30000, () => req.destroy(new Error('更新下载连接超时')));
        req.on('error', fail);
      }

      function downloadFile(res, requestedOffset) {
        if (![200, 206].includes(res.statusCode)) {
          res.resume();
          fail(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        let baseBytes = res.statusCode === 206 ? requestedOffset : 0;
        if (res.statusCode === 206) {
          const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(String(res.headers['content-range'] || ''));
          if (!match || Number(match[1]) !== requestedOffset || Number(match[3]) !== expectedSize) {
            res.destroy();
            fail(new Error('服务器返回了无效的断点续传范围'));
            return;
          }
        }

        const responseBytes = Number.parseInt(res.headers['content-length'] || '0', 10);
        if (responseBytes > MAX_FULL_UPDATE_SIZE || baseBytes + responseBytes > expectedSize) {
          res.destroy();
          fail(new Error('完整安装包超过大小限制'));
          return;
        }
        let receivedBytes = baseBytes;
        const startedAt = Date.now();
        const fileStream = fs.createWriteStream(savePath, { flags: baseBytes > 0 ? 'a' : 'w' });

        res.on('aborted', () => {
          fileStream.destroy();
          fail(new Error('更新下载连接意外中断'));
        });
        res.on('error', (err) => {
          fileStream.destroy();
          fail(err);
        });

        res.on('data', (chunk) => {
          receivedBytes += chunk.length;
          if (receivedBytes > expectedSize || receivedBytes > MAX_FULL_UPDATE_SIZE) {
            res.destroy();
            fileStream.destroy();
            fail(new Error('完整安装包超过大小限制'));
            return;
          }
          const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.1);
          const bytesPerSecond = Math.round((receivedBytes - baseBytes) / elapsedSeconds);
          const percent = Math.max(0, Math.min(100, Math.round(receivedBytes / expectedSize * 100)));
          sendUpdateWindowEvent('update-download-progress', {
            percent,
            bytesPerSecond,
            transferred: receivedBytes,
            total: expectedSize,
            etaSeconds: bytesPerSecond > 0 ? Math.ceil((expectedSize - receivedBytes) / bytesPerSecond) : 0
          }, context);
        });

        res.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close(() => {
            if (settled) return;
            const finalSize = fs.existsSync(savePath) ? fs.statSync(savePath).size : 0;
            if (finalSize !== expectedSize) {
              return fail(new Error('完整安装包大小与服务器记录不一致'));
            }
            if (!verifyFileSHA512(savePath, checkData.sha512)) {
              try { fs.unlinkSync(savePath); } catch (_) {}
              return fail(new Error('完整安装包 SHA-512 校验失败'));
            }
            settled = true;
            resolve();
          });
        });
        fileStream.on('error', fail);
      }

      requestFile(downloadUrl);
    });

    global._pendingUpdateInstaller = savePath;
    scheduleAutomaticInstall('localPath', savePath);
    return true;

  } catch (dlErr) {
    console.error('下载安装包失败:', dlErr.message);
    sendUpdateWindowEvent('show-update-download-failed', {
      url: downloadUrl,
      message: '更新下载失败，已保留进度，下次启动将继续下载'
    }, context);
    return 'failed';
  }
}

// 自动更新单飞流程：优先差分下载，失败时立即切换到可续传的完整包。
async function checkAndApplyAutomaticUpdate(context = 'startup') {
  if (automaticUpdateFlow) return automaticUpdateFlow;

  automaticUpdateFlow = (async () => {
    activeUpdateContext = context;
    if (!app.isPackaged) {
      console.log('开发模式: 跳过安装包自动更新');
      return false;
    }

    const metadataPromise = checkFullUpdateAvailable();
    let updateResult = null;

    try {
      updateResult = await autoUpdater.checkForUpdates();
    } catch (err) {
      console.error('差分更新检查失败，将尝试完整包检测:', err.message);
    }

    const fullMetadata = await metadataPromise;
    const updateInfo = updateResult && updateResult.updateInfo;
    const hasDifferentialUpdate = updateInfo
      && VERSION_PATTERN.test(String(updateInfo.version || ''))
      && isNewerVersion(updateInfo.version, app.getVersion());

    if (hasDifferentialUpdate) {
      activeUpdateMetadata = {
        ...updateInfo,
        changelog: fullMetadata && fullMetadata.version === updateInfo.version
          ? fullMetadata.changelog
          : updateInfo.releaseNotes
      };
      activeUpdateContext = context;
      autoUpdaterActive = true;
      showAutomaticUpdate(activeUpdateMetadata, context);
      try {
        await autoUpdater.downloadUpdate();
        return true;
      } catch (err) {
        autoUpdaterActive = false;
        console.error('差分更新下载失败，立即切换完整包续传:', err.message);
      }
    }

    if (fullMetadata) {
      return downloadAndInstallFullUpdate(fullMetadata, context);
    }

    if (hasDifferentialUpdate) return 'failed';
    return false;
  })();

  try {
    return await automaticUpdateFlow;
  } finally {
    automaticUpdateFlow = null;
  }
}

function startPeriodicUpdateChecks() {
  if (!app.isPackaged || periodicUpdateTimer) return;
  periodicUpdateTimer = setInterval(() => {
    if (automaticInstallScheduled || autoUpdaterActive) return;
    checkAndApplyAutomaticUpdate('runtime').catch(err => {
      console.error('运行中更新检查失败:', err.message);
    });
  }, 30 * 60 * 1000);
  if (typeof periodicUpdateTimer.unref === 'function') periodicUpdateTimer.unref();
}

// ========== 热更新（轻量级源文件更新） ==========

function sendUpdateProgress(stage, extra) {
  sendUpdateWindowEvent('update-progress', { stage, ...(extra || {}) });
}

// 读取热更新版本号（ASAR 启用时 app.getVersion() 不会随热更新变化，需用独立文件跟踪）
function getHotUpdateVersion() {
  try {
    const appDir = app.isPackaged
      ? path.join(path.dirname(app.getPath('exe')), 'resources', 'app.asar.unpacked')
      : __dirname;
    const versionFile = path.join(appDir, '.hot-update-version');
    if (fs.existsSync(versionFile)) {
      return fs.readFileSync(versionFile, 'utf-8').trim();
    }
  } catch (e) { /* ignore */ }
  return null;
}

function isNewerVersion(remote, local) {
  const r = remote.split('.').map(Number);
  const l = local.split('.').map(Number);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rv = r[i] || 0;
    const lv = l[i] || 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

async function checkForHotUpdate() {
  // ASAR 启用时 app.getVersion() 不随热更新变化，用独立文件跟踪热更新版本
  const hotVer = getHotUpdateVersion();
  // 全量更新后 app.getVersion() 会比热更新版本新，清除残留的热更新版本文件
  if (hotVer && isNewerVersion(app.getVersion(), hotVer)) {
    try {
      const appDir = app.isPackaged
        ? path.join(path.dirname(app.getPath('exe')), 'resources', 'app.asar.unpacked')
        : __dirname;
      fs.unlinkSync(path.join(appDir, '.hot-update-version'));
    } catch (e) { /* ignore */ }
  }
  const currentVersion = getHotUpdateVersion() || app.getVersion();
  console.log('热更新: 开始检查, 当前版本', currentVersion, hotVer ? '(热更新)' : '(基础版本)');

  // 循环防护：如果上次更新后版本未变更，说明更新未生效，跳过
  const lastUpdate = storeGet('_hotUpdateAttempt', null);
  if (lastUpdate && lastUpdate.targetVersion) {
    const elapsed = Date.now() - (lastUpdate.timestamp || 0);
    if (elapsed < 600000 && !isNewerVersion(currentVersion, lastUpdate.targetVersion) && currentVersion !== lastUpdate.targetVersion) {
      // 上次尝试更新到 targetVersion，但当前版本仍然更低，说明更新未生效
      console.log(`热更新: 上次更新到 ${lastUpdate.targetVersion} 未生效(当前${currentVersion})，跳过本次检查`);
      sendUpdateProgress('none');
      return false;
    }
    // 版本已变更或超时，清除标记
    storeSet('_hotUpdateAttempt', null);
  }

  sendUpdateProgress('checking');

  try {
    // 检查是否有更新
    const checkUrl = `${API_BASE_URL}/api/update/check?version=${currentVersion}`;
    const checkData = await new Promise((resolve, reject) => {
      const req = net.request(checkUrl);
      req.on('response', (response) => {
        let data = '';
        let received = 0;
        response.on('data', chunk => {
          received += chunk.length;
          if (received > MAX_UPDATE_METADATA_SIZE) {
            response.destroy();
            reject(new Error('更新元数据响应过大'));
            return;
          }
          data += chunk;
        });
        response.on('end', () => {
          if (response.statusCode !== 200) return reject(new Error(`HTTP ${response.statusCode}`));
          try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('解析响应失败')); }
        });
      });
      req.on('error', reject);
      req.end();
    });

    if (!checkData.needUpdate) {
      console.log('热更新: 已是最新版本');
      sendUpdateProgress('none');
      return false;
    }

    const newVersion = checkData.version;
    if (!VERSION_PATTERN.test(String(newVersion || '')) || !isNewerVersion(newVersion, currentVersion)) {
      throw new Error('服务器返回了无效的热更新版本号');
    }
    if (!SHA512_BASE64_PATTERN.test(String(checkData.sha512 || ''))) {
      throw new Error('热更新包缺少有效的 SHA-512 校验值');
    }
    console.log('热更新: 发现新版本', newVersion);

    // 先显示窗口让用户看到更新进度
    if (loginWindow && !loginWindow.isDestroyed() && !loginWindow.isVisible()) {
      loginWindow.show();
    }
    const hotUpdateChangelog = normalizeUpdateNotes(checkData.changelog || checkData.releaseNotes);
    sendUpdateProgress('downloading', { version: newVersion, percent: 0, changelog: hotUpdateChangelog });

    // 下载更新包
    const downloadUrl = `${API_BASE_URL}/api/update/download`;
    const tempDir = path.join(app.getPath('temp'), 'ychelper-update');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const zipPath = path.join(tempDir, `update-${newVersion}.zip`);

    await new Promise((resolve, reject) => {
      const req = net.request(downloadUrl);
      req.on('response', (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        const totalSize = parseInt(response.headers['content-length'] || '0', 10);
        if (totalSize > MAX_HOT_UPDATE_SIZE) {
          response.destroy();
          reject(new Error('热更新包超过大小限制'));
          return;
        }
        let receivedSize = 0;
        const chunks = [];

        response.on('data', (chunk) => {
          chunks.push(chunk);
          receivedSize += chunk.length;
          if (receivedSize > MAX_HOT_UPDATE_SIZE) {
            response.destroy();
            reject(new Error('热更新包超过大小限制'));
            return;
          }
          if (totalSize > 0) {
            const percent = Math.round((receivedSize / totalSize) * 100);
            sendUpdateProgress('downloading', { version: newVersion, percent, changelog: hotUpdateChangelog });
          }
        });

        response.on('end', () => {
          try {
            const buffer = Buffer.concat(chunks);
            const expectedSize = Number(checkData.size) || 0;
            if (expectedSize > 0 && buffer.length !== expectedSize) {
              throw new Error('热更新包大小与服务器记录不一致');
            }
            if (!verifySHA512(buffer, checkData.sha512)) {
              throw new Error('热更新包 SHA-512 校验失败');
            }
            fs.writeFileSync(zipPath, buffer);
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.end();
    });

    console.log('热更新: 下载完成, 开始安装...');
    sendUpdateProgress('installing', { version: newVersion, changelog: hotUpdateChangelog });

    // 提前记录更新尝试（循环防护：即使复制失败也不会无限重试）
    storeSet('_hotUpdateAttempt', { targetVersion: newVersion, timestamp: Date.now() });

    // 确定应用目录
    // 打包后: resources/app.asar.unpacked/  开发模式: __dirname
    // asar:true 后 src/ 在 app.asar.unpacked 中，热更新仅覆盖 src/
    const appDir = app.isPackaged
      ? path.join(path.dirname(app.getPath('exe')), 'resources', 'app.asar.unpacked')
      : __dirname;

    // 先解压到临时目录
    const stagingDir = path.join(tempDir, 'staging');
    if (fs.existsSync(stagingDir)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }

    const zip = new AdmZip(zipPath);
    const zipEntries = zip.getEntries();
    for (const entry of zipEntries) {
      const normalized = entry.entryName.replace(/\\/g, '/');
      const parts = normalized.split('/').filter(Boolean);
      if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || parts.includes('..')) {
        throw new Error(`热更新包包含危险路径: ${entry.entryName}`);
      }
      if (normalized !== 'src/' && !normalized.startsWith('src/')) {
        throw new Error(`热更新包包含 src/ 之外的文件: ${entry.entryName}`);
      }
    }
    zip.extractAllTo(stagingDir, true);

    // 复制文件到应用目录（处理 Program Files 等需要管理员权限的目录）
    try {
      copyDirSync(stagingDir, appDir);
    } catch (copyErr) {
      if (copyErr.code === 'EPERM' || copyErr.code === 'EACCES') {
        console.log('热更新: 权限不足，尝试提升权限复制...');
        const { execSync } = require('child_process');
        const batPath = path.join(tempDir, 'elevate-copy.bat');
        const srcNorm = stagingDir.replace(/\//g, '\\');
        const dstNorm = appDir.replace(/\//g, '\\');
        fs.writeFileSync(batPath, `@echo off\r\nxcopy "${srcNorm}" "${dstNorm}" /E /Y /I /Q\r\n`, 'utf-8');
        try {
          execSync(`powershell -Command "Start-Process cmd.exe -ArgumentList '/c \\\"${batPath}\\\"' -Verb RunAs -Wait"`, { windowsHide: true, timeout: 60000 });
        } catch (elevateErr) {
          console.error('热更新: 提升权限复制失败:', elevateErr.message);
          sendUpdateProgress('error');
          return false;
        }
      } else {
        throw copyErr;
      }
    }

    // 写入热更新版本号文件并验证（ASAR 启用时 app.getVersion() 不变，用此文件跟踪）
    try {
      const versionFile = path.join(appDir, '.hot-update-version');
      fs.writeFileSync(versionFile, newVersion, 'utf-8');
      const written = fs.readFileSync(versionFile, 'utf-8').trim();
      if (written !== newVersion) {
        console.error(`热更新: 版本文件验证失败！期望 ${newVersion}，实际 ${written}`);
        sendUpdateProgress('error');
        return false;
      }
      console.log('热更新: 版本文件验证通过:', newVersion);
    } catch (e) {
      console.error('热更新: 写入版本文件失败:', e.message);
      sendUpdateProgress('error');
      return false;
    }

    // 清理临时文件
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      console.log('热更新: 清理临时文件失败（不影响使用）:', e.message);
    }

    console.log('热更新: 安装完成, 版本已更新到', newVersion);

    sendUpdateProgress('done', { version: newVersion, changelog: hotUpdateChangelog });

    // 延迟重启应用
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 1000);

    return true;
  } catch (err) {
    console.error('热更新失败:', err.message);
    sendUpdateProgress('error');
    return false;
  }
}

// 递归复制目录
function copyDirSync(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ========== 单实例锁：防止多实例运行导致互相踢人 ==========
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // 已有实例在运行，弹窗提示后退出
  app.quit();
} else {
  app.on('second-instance', () => {
    // 有人尝试打开第二个实例，聚焦到已有窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// 禁用 Chromium 自动化标记（防止京东检测 navigator.webdriver）
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

app.whenReady().then(async () => {
  // 将历史明文 config.json 迁移为系统安全存储加密格式。
  if (fs.existsSync(storePath) && safeStorage.isEncryptionAvailable()) {
    try {
      const rawStore = fs.readFileSync(storePath, 'utf-8');
      if (!rawStore.startsWith(ENCRYPTED_STORE_PREFIX)) {
        saveStore(JSON.parse(rawStore));
        console.log('[存储] 已将历史明文配置迁移为加密格式');
      }
    } catch (err) {
      console.error('[存储] 历史配置加密迁移失败:', err.message);
    }
  }

  // 初始化 cookie 存储目录
  cookieManager.ensureCookieDir();
  cookieManager.migrateLegacyCookieFiles();

  // ====== 旧版数据迁移 ======
  const migrated = storeGet('_cookieMigrated', false);
  if (!migrated) {
    console.log('Cookie 系统: 开始旧版数据迁移...');

    // 迁移商家端：credentialList → merchantAccounts
    const merchantAccounts = storeGet('merchantAccounts', []);
    if (merchantAccounts.length === 0) {
      const credList = storeGet('credentialList', []);
      const cred = storeGet('credentials', null);
      // 合并 credentials 和 credentialList
      const allCreds = [];
      if (cred && cred.username) allCreds.push(cred);
      credList.forEach(c => {
        if (c.username && !allCreds.find(a => a.username === c.username)) {
          allCreds.push(c);
        }
      });
      if (allCreds.length > 0) {
        const newMerchantAccounts = allCreds.map(c => ({
          id: crypto.randomUUID(),
          username: c.username,
          password: c.password || '',
          lastLogin: Date.now()
        }));
        storeSet('merchantAccounts', newMerchantAccounts);
        // 设置最后登录的账号为活跃账号
        storeSet('lastMerchantAccountId', newMerchantAccounts[0].id);
        console.log(`Cookie 系统: 迁移了 ${newMerchantAccounts.length} 个商家端账号`);
      }
    }

    // 迁移仓库端：wmsCredentials → wmsAccounts
    const wmsAccounts = storeGet('wmsAccounts', []);
    if (wmsAccounts.length === 0) {
      const wmsCred = storeGet('wmsCredentials', null);
      if (wmsCred && wmsCred.username) {
        const newWmsAccount = {
          id: crypto.randomUUID(),
          username: wmsCred.username,
          password: wmsCred.password || '',
          warehouseName: '',
          lastLogin: Date.now()
        };
        storeSet('wmsAccounts', [newWmsAccount]);
        storeSet('lastWmsAccountId', newWmsAccount.id);
        console.log('Cookie 系统: 迁移了 1 个仓库端账号');
      }
    }

    // 导出当前 session 中已有的 cookies 到文件
    try {
      // 商家端：从 defaultSession 导出
      const lastMerchantId = storeGet('lastMerchantAccountId', '');
      if (lastMerchantId) {
        const defaultCookies = await session.defaultSession.cookies.get({ domain: '.jdl.com' });
        if (defaultCookies.length > 0) {
          await cookieManager.exportCookies(session.defaultSession, 'merchant', lastMerchantId);
          console.log('Cookie 系统: 导出了现有商家端 cookies');
        }
      }

      // 仓库端：从 persist:wms 导出
      const lastWmsId = storeGet('lastWmsAccountId', '');
      if (lastWmsId) {
        const wmsSession = session.fromPartition('persist:wms');
        const wmsCookies = await wmsSession.cookies.get({ domain: '.jdl.com' });
        if (wmsCookies.length > 0) {
          await cookieManager.exportCookies(wmsSession, 'wms', lastWmsId);
          console.log('Cookie 系统: 导出了现有仓库端 cookies');
        }
      }

      // 店铺：从 persist:shop 导出到最后活跃的店铺账号
      const shopAccounts = storeGet('shopAccounts', []);
      if (shopAccounts.length > 0) {
        const shopSession = session.fromPartition('persist:shop');
        const shopCookies = await shopSession.cookies.get({ domain: 'jd.com' });
        if (shopCookies.length > 0) {
          // 导出到第一个店铺账号
          await cookieManager.exportCookies(shopSession, 'shop', shopAccounts[0].id);
          storeSet('lastShopAccountId', shopAccounts[0].id);
          console.log('Cookie 系统: 导出了现有店铺 cookies');
        }
      }
    } catch (migErr) {
      console.error('Cookie 系统: cookie 导出迁移失败:', migErr.message);
    }

    storeSet('_cookieMigrated', true);
    console.log('Cookie 系统: 旧版数据迁移完成');
  }

  // 恢复上次活跃的账号ID
  activeMerchantAccountId = storeGet('lastMerchantAccountId', '');
  activeWmsAccountId = storeGet('lastWmsAccountId', '');
  activeShopAccountId = storeGet('lastShopAccountId', '');

  // 清除旧的持久化 wmsLoggedIn（已改为内存管理）
  const store = loadStore();
  if (store.wmsLoggedIn !== undefined) {
    delete store.wmsLoggedIn;
    saveStore(store);
  }
  createLoginWindow();

  // 登录页加载后先显示“正在检查更新”的启动状态；检查完成且无更新才展示账号表单。
  // 完整安装包必须优先：热更新构建在特定 base 上，base 太旧会不兼容。
  loginWindow.webContents.once('did-finish-load', async () => {
    activeUpdateContext = 'startup';
    sendUpdateProgress('checking', { message: '正在检查完整版本和更新文件...' });
    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.show();

    const fullUpdated = await checkAndApplyAutomaticUpdate('startup');
    if (fullUpdated === true) return;
    if (fullUpdated === 'failed') {
      // 已确认存在完整新版时不再尝试热更新，避免不同基础版本互相覆盖。
      await new Promise(resolve => setTimeout(resolve, 2500));
      sendUpdateProgress('none');
      startPeriodicUpdateChecks();
      return;
    }

    // 开发版只运行本机代码，不自动下载安装线上更新。
    if (app.isPackaged) {
      try {
        const hotUpdated = await checkForHotUpdate();
        if (hotUpdated) return;
      } catch (e) {
        console.log('热更新检查异常:', e.message);
      }
    }

    sendUpdateProgress('none');
    if (loginWindow && !loginWindow.isDestroyed() && !loginWindow.isVisible()) loginWindow.show();
    startPeriodicUpdateChecks();
  });
});

app.on('before-quit', () => {
  wmsIsQuitting = true;
  if (periodicUpdateTimer) {
    clearInterval(periodicUpdateTimer);
    periodicUpdateTimer = null;
  }
  stopHeartbeat();
  shopSffHttpsAgent.destroy();
  // 清理隐藏的JD页面窗口
  if (jdPageWindow && !jdPageWindow.isDestroyed()) {
    jdPageWindow.close();
    jdPageWindow = null;
  }
});

app.on('window-all-closed', () => {
  // 所有窗口关闭时退出应用（包括隐藏窗口被销毁后）
  app.quit();
});

// ========== IPC: 窗口控制 ==========

ipcMain.on('window-minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.minimize();
});

ipcMain.on('window-close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});

// 渲染进程确认退出
ipcMain.on('confirm-close', () => {
  if (pendingUpdateAction === 'autoUpdater') {
    // 非静默安装，显示 NSIS 安装进度界面，安装后自动重启
    autoUpdater.quitAndInstall(false, true);
  } else if (pendingUpdateAction === 'localPath') {
    shell.openPath(global._pendingUpdateInstaller);
    app.quit();
  } else {
    app.quit();
  }
});

// 渲染进程确认安装更新（兼容旧版 preload 的 fallback）
ipcMain.on('confirm-update-install', () => {
  if (global._pendingUpdateInstaller) {
    pendingUpdateAction = 'localPath';
  } else {
    pendingUpdateAction = 'autoUpdater';
  }
  // 只有主窗口有退出确认弹窗UI；登录窗口/订阅窗口直接安装
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('show-close-confirm');
  } else {
    if (pendingUpdateAction === 'localPath') {
      shell.openPath(global._pendingUpdateInstaller);
      app.quit();
    } else {
      autoUpdater.quitAndInstall(false, true);
    }
  }
});

// 渲染进程确认安装更新（服务器下载的安装包）
ipcMain.on('confirm-update-install-by-path', () => {
  if (global._pendingUpdateInstaller) {
    pendingUpdateAction = 'localPath';
  } else {
    // autoUpdater 下载的更新没有 _pendingUpdateInstaller，走 autoUpdater 路径
    pendingUpdateAction = 'autoUpdater';
  }
  // 只有主窗口有退出确认弹窗UI；登录窗口/订阅窗口直接安装
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('show-close-confirm');
  } else {
    if (pendingUpdateAction === 'localPath') {
      shell.openPath(global._pendingUpdateInstaller);
      app.quit();
    } else {
      autoUpdater.quitAndInstall(false, true);
    }
  }
});

// 渲染进程点击浏览器下载
ipcMain.on('open-external-download', (event, url) => {
  try {
    const parsed = new URL(String(url || ''));
    if (!['https:', 'http:'].includes(parsed.protocol)) {
      console.warn('拒绝打开非 HTTP(S) 外部链接:', parsed.protocol);
      return;
    }
    shell.openExternal(parsed.toString());
  } catch (err) {
    console.warn('拒绝打开无效外部链接:', err.message);
  }
});

// ========== IPC: 登录 ==========

ipcMain.handle('open-web-login', async (event, cred) => {
  pendingCredentials = cred || null;
  await createWebLoginWindow();
});

ipcMain.handle('get-credentials', async () => {
  return storeGet('credentials', null);
});

ipcMain.handle('get-credential-list', async () => {
  return storeGet('credentialList', []);
});

ipcMain.handle('save-credentials', async (event, cred) => {
  storeSet('credentials', cred);
  // 维护多账号列表，最近登录排最前，最多10个
  let list = storeGet('credentialList', []);
  list = list.filter(item => item.username !== cred.username);
  list.unshift(cred);
  if (list.length > 10) list = list.slice(0, 10);
  storeSet('credentialList', list);
});

// 商家端多账号管理
ipcMain.handle('get-merchant-accounts', async () => {
  return storeGet('merchantAccounts', []);
});

ipcMain.handle('save-merchant-account', async (event, account) => {
  let list = storeGet('merchantAccounts', []);
  if (account.id) {
    const idx = list.findIndex(a => a.id === account.id);
    if (idx >= 0) {
      list[idx] = { ...list[idx], username: account.username, password: account.password, departmentName: account.departmentName || list[idx].departmentName };
    }
  } else {
    if (list.length >= 20) {
      return { success: false, error: '最多保存20个商家端账号' };
    }
    account.id = crypto.randomUUID();
    list.push(account);
  }
  storeSet('merchantAccounts', list);
  return { success: true, list };
});

ipcMain.handle('delete-merchant-account', async (event, id) => {
  let list = storeGet('merchantAccounts', []);
  list = list.filter(a => a.id !== id);
  storeSet('merchantAccounts', list);

  // 删除 cookie 文件和 session 分区
  cookieManager.deleteCookieFile('merchant', id);
  await cookieManager.clearPartition(cookieManager.getPartitionName('merchant', id));

  if (activeMerchantAccountId === id) {
    activeMerchantAccountId = '';
  }

  return { success: true, list };
});

ipcMain.handle('switch-merchant-account', async (event, account) => {
  if (!account || !account.id) {
    return { success: false, error: '无效的商家端账号' };
  }

  activeMerchantAccountId = account.id;
  storeSet('lastMerchantAccountId', account.id);

  // 尝试从 cookie 文件恢复
  if (cookieManager.validateCookieFile('merchant', account.id)) {
    const ses = getMerchantSession();
    const imported = await cookieManager.importCookies(ses, 'merchant', account.id);
    if (imported) {
      // 加载该用户的 profile 数据
      if (account.username) {
        loadUserProfile(account.username);
        currentUsername = account.username;
        storeSet('lastLoginUser', account.username);
      }
      return { success: true, loggedIn: true };
    }
  }

  return { success: true, loggedIn: false, needLogin: true };
});

ipcMain.handle('get-user-data', async () => {
  return storeGet('userData', null);
});

ipcMain.handle('get-cookies', async () => {
  return storeGet('cookies', null);
});

ipcMain.handle('get-csrf-token', async () => {
  return storeGet('csrfToken', '');
});

// ========== IPC: 快捷模式 ==========

const DEFAULT_MODES = [
  {
    name: '入仓打标',
    config: {
      importShopProduct: true, enableShopProduct: true, enableMasterData: true,
      disableMasterData: false, inventoryRatio: true, inventoryRatioValue: '100',
      jdLabel: true, enablePurchase: true, disableShopProduct: false,
      logistics: true, cancelJdLabel: false,
      logLength: '210', logWidth: '150', logHeight: '100',
      stepDelay: 10, purchaseQty: 10, autoAccept: true
    }
  },
  {
    name: '添加库存',
    config: {
      importShopProduct: false, enableShopProduct: false, enableMasterData: false,
      disableMasterData: false, inventoryRatio: false, inventoryRatioValue: '100',
      jdLabel: false, enablePurchase: true, disableShopProduct: false,
      logistics: false, cancelJdLabel: false,
      logLength: '210', logWidth: '150', logHeight: '100',
      stepDelay: 60, purchaseQty: 10, autoAccept: true
    }
  },
  {
    name: '打标（仅勾标）',
    config: {
      importShopProduct: false, enableShopProduct: false, enableMasterData: false,
      disableMasterData: false, inventoryRatio: false, inventoryRatioValue: '100',
      jdLabel: true, enablePurchase: false, disableShopProduct: false,
      logistics: false, cancelJdLabel: false,
      logLength: '210', logWidth: '150', logHeight: '100',
      stepDelay: 60, purchaseQty: 10, autoAccept: true
    }
  },
  {
    name: '下标（取消京配）',
    config: {
      importShopProduct: false, enableShopProduct: false, enableMasterData: false,
      disableMasterData: false, inventoryRatio: false, inventoryRatioValue: '100',
      jdLabel: false, enablePurchase: false, disableShopProduct: false,
      logistics: false, cancelJdLabel: true,
      logLength: '210', logWidth: '150', logHeight: '100',
      stepDelay: 10, purchaseQty: 10, autoAccept: true
    }
  },
  {
    name: '标准下标（含清库+停用）',
    config: {
      importShopProduct: false, enableShopProduct: false, enableMasterData: false,
      disableMasterData: true, inventoryRatio: true, inventoryRatioValue: '0',
      jdLabel: true, enablePurchase: false, disableShopProduct: true,
      logistics: false, cancelJdLabel: false,
      logLength: '210', logWidth: '150', logHeight: '100',
      stepDelay: 60, purchaseQty: 10, autoAccept: true
    }
  }
];

ipcMain.handle('get-modes', async () => {
  return storeGet('modes', DEFAULT_MODES);
});

ipcMain.handle('save-mode', async (event, mode) => {
  const modes = storeGet('modes', DEFAULT_MODES);
  const existIndex = modes.findIndex(m => m.name === mode.name);
  if (existIndex >= 0) {
    modes[existIndex] = mode;
  } else {
    modes.push(mode);
  }
  storeSet('modes', modes);
  return modes;
});

ipcMain.handle('delete-mode', async (event, modeName) => {
  const modes = storeGet('modes', DEFAULT_MODES);
  const filtered = modes.filter(m => m.name !== modeName);
  storeSet('modes', filtered);
  return filtered;
});

// ========== IPC: 文件选择 ==========

ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择SKU文本文件',
    filters: [
      { name: '文本文件', extensions: ['txt'] },
      { name: '所有文件', extensions: ['*'] }
    ],
    properties: ['openFile']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const filePath = result.filePaths[0];
  const content = fs.readFileSync(filePath, 'utf-8');
  const fileName = require('path').basename(filePath, require('path').extname(filePath));
  return { content, fileName };
});

// ========== IPC: Excel 生成 ==========

// 初始化输出目录（使用"我的文档"下的"云仓助手输出"文件夹，避免 Program Files 写入权限问题）
app.whenReady().then(() => {
  const appDir = app.isPackaged ? app.getPath('documents') : __dirname;
  const outputDir = path.join(appDir, '云仓助手输出');
  excelGen.setOutputDir(outputDir);
});

ipcMain.handle('generate-excel', async (event, { type, data }) => {
  try {
    let filePath;

    switch (type) {
      case 'popGoodsImport':
        filePath = excelGen.generatePopGoodsImport(data.skus);
        break;

      case 'goodsLogistics':
        filePath = excelGen.generateGoodsLogistics(data.skus, {
          departmentId: data.departmentId,
          length: data.length,
          width: data.width,
          height: data.height,
          weight: data.weight
        });
        break;

      case 'updateShopGoods':
        filePath = excelGen.generateUpdateShopGoods(data.items);
        break;

      case 'purchaseImport':
        filePath = excelGen.generatePurchaseImport(data.skus, {
          departmentId: data.departmentId,
          supplierId: data.supplierId,
          warehouseId: data.warehouseId,
          purchaseQty: data.purchaseQty
        });
        break;

      default:
        throw new Error(`未知的模板类型: ${type}`);
    }

    return { success: true, filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 打开文件所在目录
ipcMain.handle('open-output-dir', async () => {
  const appDir = app.isPackaged ? app.getPath('documents') : __dirname;
  const outputDir = path.join(appDir, '云仓助手输出');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  shell.openPath(outputDir);
});

// 保存失败的打标SKU到输出目录的文本文件
ipcMain.handle('save-failed-label-skus', async (event, { skus, label, shopName }) => {
  try {
    const appDir = app.isPackaged ? app.getPath('documents') : __dirname;
    const outputDir = path.join(appDir, '云仓助手输出');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const safeShopName = (shopName || '未知店铺').replace(/[\\/:*?"<>|]/g, '_');
    const baseName = `京配${label || '打标'}失败SKU_${safeShopName}_${dateStr}`;
    // 同一天同店铺可能多次失败，用序号避免覆盖
    let seq = 1;
    let fileName = `${baseName}.txt`;
    while (fs.existsSync(path.join(outputDir, fileName))) {
      fileName = `${baseName}_${seq}.txt`;
      seq++;
    }
    const filePath = path.join(outputDir, fileName);
    fs.writeFileSync(filePath, skus.join('\n'), 'utf-8');
    return { success: true, filePath, fileName };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ========== IPC: 店铺管理 ==========

// 店铺账号 CRUD - 存储在 config.json 的 shopAccounts key
ipcMain.handle('get-shop-accounts', async () => {
  return storeGet('shopAccounts', []);
});

ipcMain.handle('save-shop-account', async (event, account) => {
  assertAutomationAccess();
  let list = storeGet('shopAccounts', []);
  if (!account || typeof account !== 'object') {
    return { success: false, error: '店铺账号信息无效' };
  }

  const accountId = String(account.id || '');
  const username = String(account.username || '').trim();
  if (!username) {
    return { success: false, error: '请输入登录账号' };
  }

  const duplicate = findDuplicateShopAccount(list, { id: accountId, username });
  if (accountId && duplicate) {
    return {
      success: false,
      duplicate: true,
      error: `登录账号“${username}”已被另一个店铺记录使用`
    };
  }

  const savedAccount = {
    id: accountId || (duplicate ? duplicate.id : crypto.randomUUID()),
    name: String(account.name || '').trim(),
    username,
    password: String(account.password || ''),
    autoSend: !!account.autoSend
  };

  if (accountId) {
    // 编辑：更新现有
    const idx = list.findIndex(a => a.id === accountId);
    if (idx < 0) return { success: false, error: '要编辑的店铺账号不存在' };
    list[idx] = { ...list[idx], ...savedAccount };
  } else if (duplicate) {
    // 新增时命中相同登录账号：复用原 ID 和 Cookie 文件，更新原记录，不再创建重复项。
    const idx = list.findIndex(item => item.id === duplicate.id);
    list[idx] = { ...list[idx], ...savedAccount };
  } else {
    // 新增
    if (list.length >= 20) {
      return { success: false, error: '最多保存20个店铺账号' };
    }
    list.push(savedAccount);
  }
  storeSet('shopAccounts', list);
  return { success: true, account: savedAccount, merged: !accountId && !!duplicate, list };
});

ipcMain.handle('delete-shop-account', async (event, id) => {
  assertAutomationAccess();
  let list = storeGet('shopAccounts', []);
  list = list.filter(a => a.id !== id);
  storeSet('shopAccounts', list);

  // 删除该账号的 cookie 文件和 session 分区
  cookieManager.deleteCookieFile('shop', id);
  await cookieManager.clearPartition(cookieManager.getPartitionName('shop', id));

  // 如果删除的是当前活跃账号，重置状态
  if (activeShopAccountId === id) {
    activeShopAccountId = '';
    shopLoggedIn = false;
    shopLoginName = '';
  }

  return { success: true, list };
});

// 店铺登录 - shop.jd.com
let shopLoginWindow = null;
let shopLoggedIn = false;
let shopLoginName = '';
let pendingShopCredentials = null;
const shopSessionValidationTasks = new Map();
let activeShopAccountId = ''; // 当前活跃的店铺账号ID
let shopPageWindow = null;           // 店铺后台浏览窗口
let shopQueryInProgress = false;     // 自动查询任务锁
let shopSffContextHeaders = null;    // 商品页官方请求生成的 DSM 环境头（仅保存在内存）
// 老款实测使用主进程精简 HTTPS，并按“1页SPU -> 本页逐个SKU”串行处理。
const SHOP_GOODS_DIRECT_QUERY_ENABLED = true;
const shopSffHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
let lastShopSffResponseFinishedAt = 0;

// 获取当前店铺的 session 分区名
function getShopPartition() {
  if (activeShopAccountId) {
    return cookieManager.getPartitionName('shop', activeShopAccountId);
  }
  return 'persist:shop'; // 兼容旧版无ID情况
}

// 获取当前店铺的 session 实例
function getShopSession() {
  return session.fromPartition(getShopPartition());
}

function applyShopBrowserUserAgent(win) {
  if (!win || win.isDestroyed()) return;
  const defaultUA = win.webContents.getUserAgent();
  const cleanUA = defaultUA
    .replace(/\s*Electron\/[\d.]+/g, '')
    .replace(/\s*cloud-warehouse-assistant\/[\d.]+/g, '')
    .replace(/\s*ychelper\/[\d.]+/g, '');
  win.webContents.setUserAgent(cleanUA);
}

// 探测指定店铺账号，不切换当前账号，也不创建或加载浏览器窗口。
async function probeShopAccountSession(accountId) {
  if (!accountId) return { state: 'login', reason: 'no_account', durationMs: 0 };
  if (shopSessionValidationTasks.has(accountId)) {
    return shopSessionValidationTasks.get(accountId);
  }

  const validationPromise = (async () => {
    const startedAt = Date.now();
    try {
      const partition = cookieManager.getPartitionName('shop', accountId);
      const shopSession = session.fromPartition(partition);
      let cookies = await shopSession.cookies.get({ domain: 'jd.com' });
      const hasSavedCookie = cookieManager.validateCookieFile('shop', accountId);

      if (cookies.length === 0) {
        if (!hasSavedCookie) {
          return { state: 'login', reason: 'no_cookie', durationMs: Date.now() - startedAt };
        }
        const imported = await cookieManager.importCookies(shopSession, 'shop', accountId);
        if (!imported) {
          return { state: 'login', reason: 'import_failed', durationMs: Date.now() - startedAt };
        }
        cookies = await shopSession.cookies.get({ domain: 'jd.com' });
        if (cookies.length === 0) {
          return { state: 'login', reason: 'no_cookie', durationMs: Date.now() - startedAt };
        }
      }

      const callback = `shopSession_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
      const validationUrl = new URL('https://i.shop.jd.com/switch/vendor/list');
      validationUrl.searchParams.set('appName', 'shop');
      validationUrl.searchParams.set('callback', callback);
      validationUrl.searchParams.set('v', String(Math.floor(Math.random() * 10000)));

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      let response;
      let body;
      try {
        response = await shopSession.fetch(validationUrl.toString(), {
          method: 'GET',
          credentials: 'include',
          headers: { Accept: '*/*' },
          signal: controller.signal
        });
        body = await response.text();
      } finally {
        clearTimeout(timeout);
      }

      const state = classifyShopIdentityResponse({
        status: response.status,
        url: response.url,
        body
      });
      const durationMs = Date.now() - startedAt;
      console.log(`[店铺状态] 账号[${accountId}]轻量检测完成: state=${state}, HTTP=${response.status}, duration=${durationMs}ms`);
      return { state, status: response.status, durationMs, hasSavedCookie };
    } catch (error) {
      const message = error && error.name === 'AbortError' ? '请求超时' : error.message;
      console.warn(`[店铺状态] 账号[${accountId}]轻量检测失败，保留 Cookie 文件:`, message);
      return { state: 'unknown', reason: 'request_failed', durationMs: Date.now() - startedAt };
    }
  })();

  shopSessionValidationTasks.set(accountId, validationPromise);
  try {
    return await validationPromise;
  } finally {
    if (shopSessionValidationTasks.get(accountId) === validationPromise) {
      shopSessionValidationTasks.delete(accountId);
    }
  }
}

// 使用店铺后台的轻量身份接口校验当前 session，避免为校验加载完整首页。
async function validateShopSession() {
  if (shopLoggedIn) return { loggedIn: true, shopName: shopLoginName };
  if (!activeShopAccountId) return { loggedIn: false, shopName: '' };

  const validatingAccountId = activeShopAccountId;
  const probe = await probeShopAccountSession(validatingAccountId);
  if (activeShopAccountId !== validatingAccountId) {
    return { loggedIn: false, shopName: '', stale: true };
  }

  if (probe.state === 'authenticated') {
    shopLoggedIn = true;
    shopLoginName = shopLoginName || storeGet('lastShopName', '');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('shop-login-success', {
        shopName: shopLoginName,
        accountId: validatingAccountId
      });
    }
    return { loggedIn: true, shopName: shopLoginName };
  }

  shopLoggedIn = false;
  if (probe.state === 'login') {
    return { loggedIn: false, shopName: '', expired: true };
  }
  return { loggedIn: false, shopName: '', validationError: true };
}

// 与蚂蚁工具箱“商品上货 -> 登录店铺”一致：每次只执行一次短注入，
// 是否重试由主进程控制，避免页面跳转后 renderer 内的长 Promise 永久悬空。
function buildShopLoginAutofillScript(username, password) {
  const usernameValue = JSON.stringify(String(username || ''));
  const passwordValue = JSON.stringify(String(password || ''));

  return `
    (function() {
      var usernameValue = ${usernameValue};
      var passwordValue = ${passwordValue};

      function isVisible(element) {
        if (!element || element.disabled || element.readOnly) return false;
        var style = window.getComputedStyle(element);
        if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
        var rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      function collectRoots() {
        var roots = [document];
        var seen = new Set(roots);
        for (var index = 0; index < roots.length; index += 1) {
          var root = roots[index];
          var elements = [];
          try { elements = root.querySelectorAll('*'); } catch (_) {}
          for (var i = 0; i < elements.length; i += 1) {
            var element = elements[i];
            if (element.shadowRoot && !seen.has(element.shadowRoot)) {
              seen.add(element.shadowRoot);
              roots.push(element.shadowRoot);
            }
          }
        }
        return roots;
      }

      function findVisible(selectors) {
        var roots = collectRoots();
        for (var i = 0; i < selectors.length; i += 1) {
          for (var j = 0; j < roots.length; j += 1) {
            var matches = [];
            try { matches = roots[j].querySelectorAll(selectors[i]); } catch (_) {}
            for (var k = 0; k < matches.length; k += 1) {
              if (isVisible(matches[k])) {
                return { element: matches[k], selector: selectors[i] };
              }
            }
          }
        }
        return null;
      }

      function setInputValue(input, value) {
        var view = input.ownerDocument && input.ownerDocument.defaultView || window;
        var prototype = Object.getPrototypeOf(input);
        var descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
          || Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value');
        if (descriptor && descriptor.set) descriptor.set.call(input, value);
        else input.value = value;
        try {
          input.dispatchEvent(new view.InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: null
          }));
        } catch (_) {
          input.dispatchEvent(new view.Event('input', { bubbles: true }));
        }
        input.dispatchEvent(new view.Event('change', { bubbles: true }));
        try { input.dispatchEvent(new view.KeyboardEvent('keyup', { bubbles: true })); } catch (_) {}
      }

      function clickPasswordLoginTab() {
        var roots = collectRoots();
        for (var i = 0; i < roots.length; i += 1) {
          var candidates = [];
          try { candidates = roots[i].querySelectorAll('button, a, [role="tab"], li, span, div'); } catch (_) {}
          for (var j = 0; j < candidates.length; j += 1) {
            var text = (candidates[j].textContent || '').trim();
            if ((text === '密码登录' || text === '账号密码登录') && isVisible(candidates[j])) {
              candidates[j].click();
              return true;
            }
          }
        }
        return false;
      }

      var passwordMatch = findVisible([
        '#nloginpwd',
        '#loginpwd',
        'input[name="nloginpwd"]',
        'input[name="loginpwd"]',
        'input[autocomplete="current-password"]',
        'input[type="password"]'
      ]);
      var passwordTabClicked = false;
      if (!passwordMatch) passwordTabClicked = clickPasswordLoginTab();

      var usernameMatch = findVisible([
        '#loginname',
        '#nloginname',
        'input[name="loginname"]',
        'input[name="nloginname"]',
        'input[autocomplete="username"]',
        'input[placeholder*="账号"]',
        'input[placeholder*="帐号"]',
        'input[placeholder*="用户名"]',
        'input[placeholder*="手机号"]',
        'input[placeholder*="邮箱"]'
      ]);

      // 新登录页可能只保留通用属性，最后才使用可见的文本类输入框兜底。
      if (!usernameMatch && passwordMatch) {
        usernameMatch = findVisible([
          'input[type="text"]',
          'input[type="tel"]',
          'input[type="email"]',
          'input:not([type])'
        ]);
      }

      if (!usernameMatch || !passwordMatch) {
        return {
          filled: false,
          usernameFound: !!usernameMatch,
          passwordFound: !!passwordMatch,
          passwordTabClicked: passwordTabClicked
        };
      }

      setInputValue(usernameMatch.element, usernameValue);
      setInputValue(passwordMatch.element, passwordValue);
      usernameMatch.element.focus();
      passwordMatch.element.focus();
      return {
        filled: usernameMatch.element.value === usernameValue
          && passwordMatch.element.value === passwordValue,
        usernameFound: true,
        passwordFound: true,
        usernameSelector: usernameMatch.selector,
        passwordSelector: passwordMatch.selector
      };
    })()
  `;
}

async function createShopLoginWindow() {
  if (shopLoginWindow && !shopLoginWindow.isDestroyed()) {
    shopLoginWindow.destroy();
    shopLoginWindow = null;
  }
  if (shopPageWindow && !shopPageWindow.isDestroyed()) {
    shopPageWindow.destroy();
    shopPageWindow = null;
  }
  shopSffContextHeaders = null;

  // 确定当前店铺分区（基于 pendingShopCredentials 的 ID）
  const accountId = pendingShopCredentials ? pendingShopCredentials.id || '' : '';
  if (accountId) {
    activeShopAccountId = accountId;
  }
  const shopPartition = getShopPartition();

  // 从 cookie 文件恢复 session（免登录）
  // 仅在分区为空时恢复（重启后 session cookie 丢失），避免破坏同一会话中的 live cookie
  const shopSession = session.fromPartition(shopPartition);
  const existingShopCookies = await shopSession.cookies.get({});
  if (existingShopCookies.length === 0 && activeShopAccountId && cookieManager.validateCookieFile('shop', activeShopAccountId)) {
    console.log(`店铺端: 分区无 cookie，从文件恢复（免登录）, 账号ID: [${activeShopAccountId}]`);
    await cookieManager.importCookies(shopSession, 'shop', activeShopAccountId);
  } else if (existingShopCookies.length === 0) {
    // 无有效 cookie 文件且分区为空，清除确保全新登录页
    await shopSession.clearStorageData({ storages: ['cookies'] });
  } else {
    console.log(`店铺端: 分区已有 ${existingShopCookies.length} 条 cookie，跳过文件恢复`);
  }

  shopLoginWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    title: '京东店铺后台 - 登录',
    webPreferences: {
      partition: shopPartition,
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  shopLoginWindow.setMenuBarVisibility(false);
  applyShopBrowserUserAgent(shopLoginWindow);

  shopLoginWindow.loadURL('https://shop.jd.com');

  // 蚂蚁工具箱的可靠做法是：页面加载后延迟 2 秒，由主进程发起一次短注入。
  // 这里沿用该方式，并由主进程定时重试；每次注入都会立即返回，因此页面二次
  // 跳转不会再把自动填充锁死在 renderer 内尚未完成的 Promise 上。
  const autofillCredentials = pendingShopCredentials
    ? {
        username: String(pendingShopCredentials.username || ''),
        password: String(pendingShopCredentials.password || '')
      }
    : { username: '', password: '' };
  let shopAutofillInProgress = false;
  let shopAutofillCompleted = false;
  let shopAutofillAttemptCount = 0;
  let shopAutofillTimer = null;
  let shopAutofillDeadline = 0;

  const stopShopCredentialAutofill = () => {
    if (shopAutofillTimer) {
      clearTimeout(shopAutofillTimer);
      shopAutofillTimer = null;
    }
  };

  const executeShopAutofillInFrame = async (frame, script) => {
    let timeoutId;
    try {
      return await Promise.race([
        frame.executeJavaScript(script),
        new Promise((resolve) => {
          timeoutId = setTimeout(() => resolve(null), 1500);
        })
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  };

  const scheduleShopCredentialAutofill = (delayMs = 2000) => {
    if (
      shopAutofillCompleted
      || shopAutofillTimer
      || !autofillCredentials.username
      || !autofillCredentials.password
      || !shopLoginWindow
      || shopLoginWindow.isDestroyed()
      || !isShopLoginUrl(shopLoginWindow.webContents.getURL())
    ) return;

    if (!shopAutofillDeadline) {
      shopAutofillDeadline = Date.now() + 30000;
      console.log('店铺登录: 登录页已加载，将按老款方式自动填充账号密码');
    }
    shopAutofillTimer = setTimeout(() => {
      shopAutofillTimer = null;
      runShopCredentialAutofill();
    }, delayMs);
  };

  const runShopCredentialAutofill = async () => {
    if (!shopLoginWindow || shopLoginWindow.isDestroyed() || shopAutofillCompleted) return;
    const currentUrl = shopLoginWindow.webContents.getURL();
    if (!isShopLoginUrl(currentUrl)) return;
    if (!autofillCredentials.username || !autofillCredentials.password) return;

    if (shopAutofillInProgress) {
      scheduleShopCredentialAutofill(250);
      return;
    }

    shopAutofillInProgress = true;
    shopAutofillAttemptCount += 1;
    try {
      const script = buildShopLoginAutofillScript(
        autofillCredentials.username,
        autofillCredentials.password
      );
      const mainFrame = shopLoginWindow.webContents.mainFrame;
      const frames = mainFrame && Array.isArray(mainFrame.framesInSubtree)
        ? mainFrame.framesInSubtree
        : mainFrame ? [mainFrame] : [];
      let bestResult = null;

      for (const frame of frames) {
        if (!frame || frame.detached || !isTrustedShopLoginFrameUrl(frame.url)) continue;
        try {
          const result = await executeShopAutofillInFrame(frame, script);
          if (result && (result.usernameFound || result.passwordFound || result.passwordTabClicked)) {
            bestResult = result;
          }
          if (result && result.filled) {
            shopAutofillCompleted = true;
            stopShopCredentialAutofill();
            console.log(
              `店铺登录: 自动填充成功（账号输入框=${result.usernameSelector || '未知'}, `
              + `密码输入框=${result.passwordSelector || '未知'}, 主进程尝试=${shopAutofillAttemptCount}次）`
            );
            break;
          }
        } catch (frameError) {
          // 页面跳转或 iframe 被替换属于正常重试场景。
        }
      }

      if (!shopAutofillCompleted && Date.now() >= shopAutofillDeadline) {
        console.warn(
          `店铺登录: 自动填充未生效（找到账号输入框=${!!(bestResult && bestResult.usernameFound)}, `
          + `找到密码输入框=${!!(bestResult && bestResult.passwordFound)}, `
          + `主进程尝试=${shopAutofillAttemptCount}次），请手动输入`
        );
        stopShopCredentialAutofill();
      }
    } catch (e) {
      // 页面切换时本轮注入可能中断，下一轮会在新页面继续。
    } finally {
      shopAutofillInProgress = false;
      if (!shopAutofillCompleted && Date.now() < shopAutofillDeadline) {
        scheduleShopCredentialAutofill(500);
      }
    }
  };

  shopLoginWindow.webContents.on('did-finish-load', () => scheduleShopCredentialAutofill(2000));
  shopLoginWindow.webContents.on('did-frame-finish-load', () => scheduleShopCredentialAutofill(2000));
  shopLoginWindow.webContents.on('dom-ready', () => scheduleShopCredentialAutofill(2000));

  // 登录成功检测
  shopLoginWindow.webContents.on('did-navigate', async (event, url) => {
    if (!shopLoginWindow || shopLoginWindow.isDestroyed()) return;
    console.log('店铺登录: 导航到', url);
    if (isShopLoginUrl(url)) {
      scheduleShopCredentialAutofill(2000);
    }
    // 登录成功后URL会跳转到 shop.jd.com 的管理页面（非 passport/login）
    if (url.includes('shop.jd.com') && !url.includes('passport') && !url.includes('login')) {
      stopShopCredentialAutofill();
      console.log('店铺登录: 检测到登录成功');
      shopLoggedIn = true;

      // 等待页面完全加载后再提取店铺名称
      shopLoginWindow.webContents.once('did-finish-load', async () => {
        if (!shopLoginWindow || shopLoginWindow.isDestroyed()) return;

        // 延迟一小段时间，等待SPA异步渲染店铺名称
        await new Promise(r => setTimeout(r, 2000));
        if (!shopLoginWindow || shopLoginWindow.isDestroyed()) return;

        // 从页面提取店铺名称
        try {
          const name = await shopLoginWindow.webContents.executeJavaScript(`
            (function() {
              var el = document.getElementById('shop-base-name')
                || document.querySelector('.shop-base__right-title-name');
              if (el && el.textContent.trim()) return el.textContent.trim();
              // 兜底：从 document.title 提取
              var title = document.title || '';
              if (title && title.includes('-')) return title.split('-')[0].trim();
              return '';
            })();
          `);
          shopLoginName = name || (pendingShopCredentials ? pendingShopCredentials.name || '' : '');
          storeSet('lastShopName', shopLoginName);
          console.log('店铺登录: 提取到店铺名称:', shopLoginName);
        } catch (e) {
          shopLoginName = pendingShopCredentials ? pendingShopCredentials.name || '' : '';
          console.log('店铺登录: 提取名称失败:', e.message);
        }

        // 关闭登录窗口前导出 cookie 到文件
        if (activeShopAccountId) {
          const ses = session.fromPartition(getShopPartition());
          await cookieManager.exportCookies(ses, 'shop', activeShopAccountId);
        }

        // 保留刚完成登录的正常页面上下文，后续商品查询继续复用同一会话。
        // 旧软件也是在已登录的内嵌页面环境中完成签名和请求；销毁后重建会丢失
        // 页面侧的本地状态与签名环境，容易被京东判定为异常请求。
        if (shopLoginWindow && !shopLoginWindow.isDestroyed()) {
          if (shopPageWindow && !shopPageWindow.isDestroyed()) {
            shopPageWindow.destroy();
          }
          const retainedShopWindow = shopLoginWindow;
          shopPageWindow = retainedShopWindow;
          shopLoginWindow = null;
          retainedShopWindow.setTitle('店铺后台 - ' + (shopLoginName || ''));
          retainedShopWindow.hide();
          retainedShopWindow.once('closed', () => {
            shopSffContextHeaders = null;
            if (shopPageWindow === retainedShopWindow) shopPageWindow = null;
          });
          console.log('店铺登录: 已保留当前页面会话供商品查询复用');
        }

        // 通知渲染进程
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('shop-login-success', {
            shopName: shopLoginName,
            accountId: pendingShopCredentials ? pendingShopCredentials.id || '' : ''
          });
        }
      });
    }
  });

  const createdShopLoginWindow = shopLoginWindow;
  createdShopLoginWindow.on('closed', () => {
    stopShopCredentialAutofill();
    if (shopLoginWindow === createdShopLoginWindow) shopLoginWindow = null;
  });
}

ipcMain.handle('open-shop-login', async (event, cred) => {
  assertAutomationAccess();
  pendingShopCredentials = cred || null;
  await createShopLoginWindow();
});

ipcMain.handle('get-shop-login-status', async () => {
  if (shopLoggedIn) {
    return { loggedIn: true, shopName: shopLoginName, activeAccountId: activeShopAccountId };
  }
  // 尝试校验持久化的session
  const result = await validateShopSession();
  result.activeAccountId = activeShopAccountId;
  return result;
});

ipcMain.handle('open-shop-backend', async (event, accountId) => {
  assertAutomationAccess();
  const requestedAccountId = String(accountId || '');
  if (!requestedAccountId || requestedAccountId !== activeShopAccountId || !shopLoggedIn) {
    return { success: false, needLogin: true, error: '当前店铺登录状态已失效，请重新登录' };
  }

  try {
    const win = await ensureShopPageWindow({ show: true });
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message || '店铺后台打开失败' };
  }
});

// 打开账号管理时，用轻量身份接口检测每个账号；最多同时检测 4 个，避免瞬间并发过高。
ipcMain.handle('check-shop-accounts-status', async () => {
  const accounts = storeGet('shopAccounts', []);
  const statusMap = {};
  const stateMap = {};
  const savedCookieMap = {};
  for (const account of accounts) {
    statusMap[account.id] = false;
    stateMap[account.id] = 'checking';
    savedCookieMap[account.id] = cookieManager.validateCookieFile('shop', account.id);
  }

  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < accounts.length) {
      const account = accounts[nextIndex++];
      const probe = await probeShopAccountSession(account.id);
      const state = probe.state === 'authenticated'
        ? 'online'
        : probe.state === 'login' ? 'offline' : 'error';
      stateMap[account.id] = state;
      statusMap[account.id] = state === 'online';

      if (account.id === activeShopAccountId) {
        if (state === 'online') shopLoggedIn = true;
        if (state === 'offline') shopLoggedIn = false;
      }
    }
  };
  const workerCount = Math.min(4, accounts.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const onlineCount = Object.values(stateMap).filter(state => state === 'online').length;
  const errorCount = Object.values(stateMap).filter(state => state === 'error').length;
  console.log(`[店铺状态] 批量检测完成: 在线 ${onlineCount}/${accounts.length}, 检测失败 ${errorCount}`);

  return {
    statusMap,
    stateMap,
    savedCookieMap,
    activeAccountId: activeShopAccountId
  };
});

// 切换店铺账号（尝试从 cookie 文件恢复，免登录）
ipcMain.handle('switch-shop-account', async (event, account) => {
  assertAutomationAccess();
  if (!account || !account.id) {
    return { success: false, error: '无效的店铺账号' };
  }

  // 先销毁旧的 shop 窗口
  if (shopLoginWindow && !shopLoginWindow.isDestroyed()) {
    shopLoginWindow.destroy();
    shopLoginWindow = null;
  }
  if (shopPageWindow && !shopPageWindow.isDestroyed()) {
    shopPageWindow.destroy();
    shopPageWindow = null;
  }
  shopSffContextHeaders = null;

  // 切换活跃账号
  activeShopAccountId = account.id;
  shopLoggedIn = false;
  shopLoginName = account.name || account.username || '';
  storeSet('lastShopAccountId', account.id);

  // 检查 cookie 文件是否有效
  if (cookieManager.validateCookieFile('shop', account.id)) {
    const shopPartition = getShopPartition();
    const ses = session.fromPartition(shopPartition);

    // 从文件导入 cookie
    const imported = await cookieManager.importCookies(ses, 'shop', account.id);
    if (imported) {
      // 验证 session 有效性
      const result = await validateShopSession();
      if (result.loggedIn) {
        console.log(`[店铺状态] 账号[${account.id}]服务器验证成功`);
        return { success: true, loggedIn: true, shopName: result.shopName };
      }
      if (result.validationError) {
        console.warn(`[店铺状态] 账号[${account.id}]暂时无法验证，保留 Cookie 文件`);
        return {
          success: false,
          loggedIn: false,
          validationError: true,
          error: '店铺登录状态验证失败，请稍后重试'
        };
      }
    }
  }

  console.log(`[店铺状态] 账号[${account.id}]保存的登录状态已失效，需要重新登录`);
  return { success: true, loggedIn: false, needLogin: true };
});

// ========== 店铺商品API自动探测与调用 ==========

// ========== 店铺商品查询（直接调用 sff.jd.com API） ==========

/**
 * 确保店铺后台窗口已打开并导航到商品管理页面
 * @param {Object} options - 可选配置
 * @param {boolean} options.show - 是否显示窗口（默认 true）
 * @returns {BrowserWindow} shopPageWindow
 */
async function ensureShopPageWindow(options = {}) {
  const shouldShow = options.show !== false;

  if (shopPageWindow && !shopPageWindow.isDestroyed()) {
    if (shouldShow) {
      if (shopPageWindow.isMinimized()) shopPageWindow.restore();
      shopPageWindow.show();
      shopPageWindow.focus();
    }
    return shopPageWindow;
  }

  const shopPartition = getShopPartition();
  shopSffContextHeaders = null;

  shopPageWindow = new BrowserWindow({
    width: 1300, height: 850,
    show: shouldShow,
    title: '店铺后台 - ' + (shopLoginName || ''),
    webPreferences: {
      partition: shopPartition,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false
    }
  });

  shopPageWindow.setMenuBarVisibility(false);

  // 与普通内嵌 Chromium 一样只保留浏览器 UA；不改写 navigator、页面可见性、
  // XHR 原型或本地存储，避免页面状态与请求状态互相矛盾。
  applyShopBrowserUserAgent(shopPageWindow);
  console.log('[店铺] 已创建可持续复用的正常页面会话');

  // 导航到店铺首页（由用户自行导航到具体页面）
  shopPageWindow.loadURL('https://shop.jd.com/');

  shopPageWindow.on('closed', () => {
    shopSffContextHeaders = null;
    shopPageWindow = null;
  });

  return shopPageWindow;
}

/**
 * 从 SKU 对象中安全提取 productId（兼容多种字段名）
 */
function getSkuProductId(skuItem) {
  if (!skuItem) return '';
  const candidates = ['productId', 'product_id', 'spuId', 'spu_id', 'parentId', 'wareId'];
  for (const key of candidates) {
    if (skuItem[key] != null) return String(skuItem[key]);
  }
  return '';
}

/**
 * 从 SKU 对象中安全提取 skuId（兼容多种字段名）
 */
function getSkuItemId(skuItem) {
  if (!skuItem) return '';
  const candidates = ['skuId', 'sku_id', 'skuCode', 'id', 'skuNo'];
  for (const key of candidates) {
    if (skuItem[key] != null) return String(skuItem[key]);
  }
  return '';
}

/**
 * 按 productId 精确定位到对应行的展开按钮，直接调用 React onClick 触发 SKU 查询
 * 不依赖 DOM click 事件，避免 React 重渲染延迟导致的重复点击问题
 * @param {BrowserWindow} win
 * @param {string} productId
 * @returns {Promise<{success: boolean, alreadyExpanded?: boolean, viaReact?: boolean, viaClick?: boolean, error?: string}>}
 */
async function triggerSkuExpandByProductId(win, productId) {
  const result = await win.webContents.executeJavaScript(`
    (function() {
      const pid = ${JSON.stringify(productId)};
      // 1. 通过 data-row-key 或 data-id 精确找行
      let row = document.querySelector('tr[data-row-key="' + pid + '"]') ||
                document.querySelector('[data-row-key="' + pid + '"]') ||
                document.querySelector('tr[data-id="' + pid + '"]') ||
                document.querySelector('[data-id="' + pid + '"]');
      // 2. 兜底：在所有行中搜索包含 pid 文本的行
      if (!row) {
        const allRows = document.querySelectorAll('table tr, [class*="table"] tr, [class*="row"]');
        for (const r of allRows) {
          if (r.textContent.replace(/\\s/g, '').includes(pid)) { row = r; break; }
        }
      }
      if (!row) return { success: false, error: '未找到对应行' };

      // 3. 在行内查找展开按钮
      const btn = row.querySelector('.ant-table-row-expand-icon') ||
                  row.querySelector('[class*="row-expand"]') ||
                  row.querySelector('[class*="expand-icon"]') ||
                  row.querySelector('[class*="expand"]');
      if (!btn) return { success: false, error: '未找到展开按钮' };

      // 4. 检查是否已展开
      const cls = (btn.className || '').toString();
      const isExpanded = cls.includes('expanded') || cls.includes('expand-open') || cls.includes('unfold') || cls.includes('expanded-icon');
      if (isExpanded) return { success: true, alreadyExpanded: true };

      // 5. 直接调用 React onClick 处理函数（绕过 DOM 事件系统）
      const reactPropsKey = Object.keys(btn).find(k => k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$'));
      if (reactPropsKey) {
        const props = btn[reactPropsKey];
        if (props && typeof props.onClick === 'function') {
          props.onClick({ stopPropagation: function(){} });
          return { success: true, viaReact: true };
        }
      }

      // 6. Fallback: DOM click
      btn.click();
      return { success: true, viaClick: true };
    })()
  `);
  return result;
}

/**
 * 为每个商品按 productId 精确定位并触发展开，拦截 querySkuList 响应
 * @param {BrowserWindow} win - 店铺后台窗口
 * @param {string[]} productIds - 需要获取SKU的商品编码列表
 * @returns {Map<string, Array>} productId -> [skuItem, ...] 的映射
 */
async function collectSkuData(win, productIds) {
  if (!productIds || productIds.length === 0) return new Map();
  console.log(`[SKU展开] 开始为 ${productIds.length} 个商品获取SKU数据（按productId精确定位触发）...`);

  const skuMap = new Map();

  // 清空之前捕获的 SKU 数据
  try {
    await win.webContents.executeJavaScript(`
      (function() {
        const keys = Object.keys(window.__ychelper_captured__ || {});
        keys.forEach(k => {
          if (k.includes('querySkuList')) delete window.__ychelper_captured__[k];
        });
      })()
    `);
  } catch(e) {}

  // 等待页面渲染完成
  await new Promise(r => setTimeout(r, 2000));

  for (let i = 0; i < productIds.length; i++) {
    const pid = productIds[i];

    // 触发对应行的展开
    let triggerResult;
    try {
      triggerResult = await triggerSkuExpandByProductId(win, pid);
    } catch(e) {
      console.log(`[SKU展开] 商品 ${pid} 触发失败:`, e.message);
      continue;
    }

    if (!triggerResult || !triggerResult.success) {
      console.log(`[SKU展开] 商品 ${pid} 无法触发:`, triggerResult?.error || '未知错误');
      continue;
    }

    if (triggerResult.alreadyExpanded) {
      console.log(`[SKU展开] 商品 ${pid} 已展开，跳过`);
      continue;
    }

    console.log(`[SKU展开] 商品 ${pid} 已触发 (${triggerResult.viaReact ? 'React' : 'DOM'})，等待响应...`);

    // 等待对应的 querySkuList 响应被 preload 捕获
    try {
      const result = await waitOneSkuResponse(win, 8000);
      if (result && result.skuList && result.skuList.length > 0) {
        skuMap.set(String(pid), result.skuList);
        console.log(`[SKU展开] 商品 ${pid}: ${result.skuList.length} 个SKU (${skuMap.size}/${productIds.length})`);
      } else {
        console.log(`[SKU展开] 商品 ${pid}: 未获取到有效SKU数据`);
      }
    } catch(e) {
      console.log(`[SKU展开] 商品 ${pid} 等待响应失败:`, e.message);
    }

    // 每次触发后等待 React 重渲染完成，避免 DOM 结构混乱
    if (i < productIds.length - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  return skuMap;
}

/**
 * 从 querySkuList 响应中安全提取 SKU 数组（适配多种可能的结构）
 */
function extractSkuListFromResponse(json) {
  if (!json || typeof json !== 'object') return null;

  // 路径1: { code: 200, data: { data: [...] } } — 当前代码假设的结构
  if (json.code === 200 || json.code === '200' || json.success === true) {
    const d = json.data;
    if (d) {
      if (Array.isArray(d.data)) return d.data;
      if (Array.isArray(d.list)) return d.list;
      if (Array.isArray(d.result)) return d.result;
      if (Array.isArray(d.records)) return d.records;
      if (Array.isArray(d)) return d; // data 直接是数组
    }
  }

  // 路径2: { result: { data: [...] } }
  if (json.result && Array.isArray(json.result.data)) return json.result.data;
  if (json.result && Array.isArray(json.result.list)) return json.result.list;

  // 路径3: 顶层直接是数组
  if (Array.isArray(json)) return json;

  // 路径4: { data: [...] }
  if (Array.isArray(json.data)) return json.data;

  return null;
}

/**
 * 从 querySkuList 请求参数中解析 productId
 */
function extractProductIdFromRequest(url, postData) {
  try {
    // 1. 从 POST body 解析（JSON 或 form-data）
    if (postData) {
      const trimmed = postData.trim();
      if (trimmed.startsWith('{')) {
        try {
          const json = JSON.parse(trimmed);
          // 顶层字段
          let pid = json.productId || json.spuId || json.wareId || json.id || '';
          if (pid) return String(pid);
          // 嵌套字段：京东店铺 querySkuList 格式
          if (json.skuListQueryReq) {
            pid = json.skuListQueryReq.productId || json.skuListQueryReq.spuId || json.skuListQueryReq.wareId || '';
            if (pid) return String(pid);
          }
        } catch(e) {}
      }
      // 尝试 URLSearchParams
      try {
        const params = new URLSearchParams(trimmed);
        const pid = params.get('productId') || params.get('spuId') || params.get('wareId') || params.get('id') || '';
        if (pid) return String(pid);
      } catch(e) {}
    }
    // 2. 从 URL 查询参数解析
    if (url) {
      try {
        const urlObj = new URL(url);
        const pid = urlObj.searchParams.get('productId') || urlObj.searchParams.get('spuId') || urlObj.searchParams.get('wareId') || urlObj.searchParams.get('id') || '';
        if (pid) return String(pid);
      } catch(e) {}
      // 兜底正则
      const m = url.match(/[?&](?:productId|spuId|wareId|id)=(\d+)/);
      if (m) return m[1];
    }
  } catch(e) {}
  return '';
}

/**
 * 从页面 preload 捕获的数据中读取 querySkuList 响应
 * @returns {Promise<{skuList: Array, requestProductId: string} | null>}
 */
async function waitOneSkuResponse(win, timeoutMs = 8000) {
  const start = Date.now();
  let lastLen = 0;

  while (Date.now() - start < timeoutMs) {
    const captured = await win.webContents.executeJavaScript(`
      (function() {
        const keys = Object.keys(window.__ychelper_captured__ || {});
        const skuKeys = keys.filter(k => k.includes('querySkuList'));
        const result = {};
        skuKeys.forEach(k => result[k] = window.__ychelper_captured__[k]);
        return JSON.stringify(result);
      })()
    `);

    const data = JSON.parse(captured);
    const keys = Object.keys(data);

    // 如果有新的 SKU 响应（比之前多），解析最后一个
    if (keys.length > lastLen) {
      lastLen = keys.length;
      const lastKey = keys[keys.length - 1];
      try {
        const json = JSON.parse(data[lastKey]);
        const skuList = extractSkuListFromResponse(json);
        if (skuList) {
          const sampleKeys = skuList.length > 0 ? Object.keys(skuList[0]).slice(0, 8).join(',') : '空数组';
          console.log(`[SKU展开] 解析成功, 共 ${skuList.length} 条SKU, 字段样例: [${sampleKeys}]`);
          return { skuList, requestProductId: '' };
        }
      } catch (e) {
        console.log('[SKU展开] 解析捕获数据失败:', e.message);
      }
    }

    await new Promise(r => setTimeout(r, 400));
  }

  console.log('[SKU展开] 等待捕获数据超时');
  return null;
}

/**
 * 在页面中设置日期筛选条件
 * 优先通过精确选择器定位日期输入框，避免填入无关字段
 * 增强版：支持更多展开按钮和日期组件交互方式
 */
async function applyDateFilterToPage(win, dateFrom, dateTo) {
  const result = await win.webContents.executeJavaScript(`
    (async function() {
      try {
        function setReactInputValue(input, value) {
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('blur', { bubbles: true }));
        }

        function findElementsByText(selectors, texts) {
          const all = Array.from(document.querySelectorAll(selectors));
          return all.filter(el => {
            const t = (el.textContent || el.getAttribute('aria-label') || el.title || '').trim();
            return texts.some(keyword => t.includes(keyword));
          });
        }

        // 1. 不再执行任何 DOM 点击操作（包括"展开"按钮）
        // 京东风控已能检测到 element.click() 触发的点击事件，
        // 任何自动点击都会立即弹出"未经京东授权"警告并限制页面功能。
        // 日期筛选完全依赖 preload 中的请求拦截器修改请求体。
        let expandClicked = false;

        // 2. 收集所有可输入元素信息用于诊断
        const allInputs = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable], [role="textbox"]'));
        const inputSummary = allInputs.slice(0, 40).map(inp => ({
          type: inp.type || inp.getAttribute('role') || 'div',
          placeholder: inp.placeholder || inp.getAttribute('placeholder') || '',
          className: (inp.className || '').substring(0, 80),
          value: (inp.value || inp.textContent || '').substring(0, 30),
          tag: inp.tagName,
          name: inp.name || '',
          id: inp.id || '',
          ariaLabel: inp.getAttribute('aria-label') || '',
          editable: inp.isContentEditable,
          readonly: inp.readOnly
        }));

        let dateInputs = [];

        // 策略1: antd RangePicker / DatePicker（最可靠）
        const pickerInputs = Array.from(document.querySelectorAll('.ant-picker-input input, .ant-calendar-range input, [class*="RangePicker"] input, [class*="picker"] input'));
        if (pickerInputs.length >= 2) {
          dateInputs = pickerInputs.filter(inp => inp.tagName === 'INPUT').slice(0, 2);
        }

        // 策略2: 京东/苏宁等定制组件类名
        if (dateInputs.length < 2) {
          const customPickerInputs = Array.from(document.querySelectorAll('.jdesign-picker-input input, .jdc-picker input, .jdc-date-picker input, [class*="date-picker"] input, [class*="dateRange"] input, [class*="timeRange"] input, [class*="datetime"] input'));
          if (customPickerInputs.length >= 2) {
            dateInputs = customPickerInputs.slice(0, 2);
          }
        }

        // 策略3: placeholder 明确包含开始/结束/日期/时间
        if (dateInputs.length < 2) {
          dateInputs = allInputs.filter(inp => {
            const ph = (inp.placeholder || '').toLowerCase();
            return ph.includes('开始') || ph.includes('结束') || ph.includes('日期') || ph.includes('时间');
          }).slice(0, 2);
        }

        // 策略4: 通过 label 或父级 wrapper 文本找上架/创建日期
        if (dateInputs.length < 2) {
          dateInputs = allInputs.filter(inp => {
            const label = inp.closest('label');
            const labelText = label ? label.textContent.toLowerCase() : '';
            const wrapper = inp.closest('[class*="form-item"]') || inp.closest('[class*="field"]') || inp.closest('.ant-form-item') || inp.closest('[class*="picker"]') || inp.parentElement;
            const wrapperText = wrapper ? wrapper.textContent.toLowerCase() : '';
            return labelText.includes('日期') || labelText.includes('时间') || labelText.includes('上架') || labelText.includes('创建') ||
                   wrapperText.includes('日期') || wrapperText.includes('时间') || wrapperText.includes('上架') || wrapperText.includes('创建');
          }).slice(0, 2);
        }

        // 策略5: input type="date" 或 type="datetime-local"
        if (dateInputs.length < 2) {
          dateInputs = allInputs.filter(inp => inp.type === 'date' || inp.type === 'datetime-local').slice(0, 2);
        }

        // 策略6: 通过 name / id / aria-label 匹配日期相关属性
        if (dateInputs.length < 2) {
          dateInputs = allInputs.filter(inp => {
            const name = (inp.name || '').toLowerCase();
            const id = (inp.id || '').toLowerCase();
            const aria = (inp.getAttribute('aria-label') || '').toLowerCase();
            return name.includes('onlinetime') || name.includes('date') || name.includes('start') || name.includes('end') ||
                   id.includes('onlinetime') || id.includes('date') || id.includes('start') || id.includes('end') ||
                   aria.includes('日期') || aria.includes('时间');
          }).slice(0, 2);
        }

        // 策略7: 如果找到 ant-picker 容器但没有 input，尝试直接找容器内的 input
        if (dateInputs.length < 2) {
          const pickerContainers = document.querySelectorAll('.ant-picker, [class*="date-picker"], [class*="datepicker"], [class*="jdesign-picker"]');
          for (const container of pickerContainers) {
            const inputs = container.querySelectorAll('input');
            if (inputs.length >= 2) {
              dateInputs = Array.from(inputs).slice(0, 2);
              break;
            }
          }
        }

        // 安全兜底：如果展开后仍然找不到输入框，直接返回失败
        // 不再尝试点击查询设置或日期选择器容器（这些操作可能触发京东风控）
        if (dateInputs.length < 2) {
          const allBtns = Array.from(document.querySelectorAll('button, a, span, div, i'));
          const btnTexts = allBtns.filter(b => b.textContent && b.textContent.trim().length > 0 && b.textContent.trim().length < 20)
            .map(b => b.textContent.trim())
            .filter((v, i, a) => a.indexOf(v) === i)
            .slice(0, 40);

          let filterAreaHtml = '';
          const possibleAreas = document.querySelectorAll('[class*="search"], [class*="filter"], [class*="form"], [class*="query"], [class*="condition"]');
          for (const area of possibleAreas) {
            if (area.innerHTML && area.innerHTML.includes('input')) {
              filterAreaHtml = area.outerHTML.substring(0, 4000);
              break;
            }
          }

          return JSON.stringify({
            success: false,
            error: '未找到日期输入框, 找到' + dateInputs.length + '个',
            inputs: inputSummary,
            buttons: btnTexts,
            filterHtml: filterAreaHtml,
            expandClicked: expandClicked,
            pickerTriggered: false
          });
        }

        setReactInputValue(dateInputs[0], '${dateFrom}');
        setReactInputValue(dateInputs[1], '${dateTo}');
        return JSON.stringify({ success: true, from: dateInputs[0].value, to: dateInputs[1].value });
      } catch(err) {
        return JSON.stringify({ success: false, error: err.message });
      }
    })()
  `);
  const parsed = JSON.parse(result);
  if (!parsed.success) {
    console.log('[店铺商品] 日期输入框诊断:', JSON.stringify(parsed.inputs));
    if (parsed.buttons) console.log('[店铺商品] 页面按钮文本:', JSON.stringify(parsed.buttons));
    if (parsed.filterHtml) console.log('[店铺商品] 筛选区域HTML片段:', parsed.filterHtml);
    if (parsed.expandClicked !== undefined) console.log('[店铺商品] 展开按钮是否点击:', parsed.expandClicked);
    if (parsed.pickerTriggered !== undefined) console.log('[店铺商品] 日期选择器是否触发:', parsed.pickerTriggered);

    // 自动读取 preload 保存的本地诊断文件
    try {
      const diagDir = path.join(__dirname, 'diagnostics');
      if (fs.existsSync(diagDir)) {
        const files = fs.readdirSync(diagDir)
          .filter(f => f.startsWith('page-dom-') && f.endsWith('.json'))
          .map(f => ({ name: f, time: fs.statSync(path.join(diagDir, f)).mtimeMs }))
          .sort((a, b) => b.time - a.time);
        if (files.length > 0) {
          const latest = JSON.parse(fs.readFileSync(path.join(diagDir, files[0].name), 'utf-8'));
          console.log('[店铺商品] === 最新页面诊断信息（自动保存）===');
          console.log('[店铺商品] URL:', latest.url);
          console.log('[店铺商品] 标题:', latest.title);
          if (latest.buttons && latest.buttons.length) {
            console.log('[店铺商品] 按钮列表:', JSON.stringify(latest.buttons.map(b => b.text).filter(Boolean)));
          }
          if (latest.inputs && latest.inputs.length) {
            console.log('[店铺商品] 输入框列表:', JSON.stringify(latest.inputs.map(i => ({
              tag: i.tag, type: i.type, placeholder: i.placeholder, className: i.className, name: i.name, ariaLabel: i.ariaLabel
            }))));
          }
          if (latest.relatedHtml && latest.relatedHtml.length) {
            console.log('[店铺商品] 相关HTML片段:', JSON.stringify(latest.relatedHtml.map(r => ({
              tag: r.tag, className: r.className, text: r.text, html: r.html
            }))));
          }
        }
      }
    } catch (e) {
      // 诊断读取失败不影响主流程
    }
  }
  return parsed;
}

/**
 * 在页面中点击查询按钮
 * 注意：由于京东风控已能检测 element.click()，此函数不再执行实际点击，
 * 仅返回按钮位置信息供 sendInputEvent 方案使用（如未来需要）
 */
async function clickPageQueryButton(win) {
  // 京东风控已能检测到通过 executeJavaScript 执行的 element.click()
  // 任何自动点击都会立即弹出"未经京东授权"警告并限制页面功能
  // 查询触发改为依赖页面导航后的自动查询，或用户手动点击
  throw new Error('风控限制：已禁用自动点击查询按钮');
}

/**
 * 在页面中注入请求拦截脚本，自动修改 queryValidProductList 的请求体加入日期参数
 * 利用 h5st 签名在 send 阶段计算的特性，我们的拦截器在 h5st 之后执行，签名会基于修改后的 body
 */
async function injectRequestInterceptor(win, dateFrom, dateTo) {
  const script = `
    (function() {
      if (window.__ychelper_request_interceptor_installed__) return;
      window.__ychelper_request_interceptor_installed__ = true;

      const dateFrom = '${dateFrom || ''}';
      const dateTo = '${dateTo || ''}';

      function patchBody(body) {
        if (!body || typeof body !== 'string') return body;
        try {
          const json = JSON.parse(body);
          if (json && json.productListQueryReq) {
            if (dateFrom && dateTo) {
              const start = dateFrom + ' 00:00:00';
              const end = dateTo + ' 23:59:59';
              json.productListQueryReq.onlineTime = [start, end];
              json.productListQueryReq.startOnlineTime = start;
              json.productListQueryReq.endOnlineTime = end;
            }
            // 尽量拉取更多数据，避免分页导致漏抓
            if (json.productListQueryReq.pageSize != null) {
              json.productListQueryReq.pageSize = 100;
            }
            return JSON.stringify(json);
          }
        } catch(e) {}
        return body;
      }

      // 拦截 XMLHttpRequest
      if (window.XMLHttpRequest) {
        const originalSend = window.XMLHttpRequest.prototype.send;
        window.XMLHttpRequest.prototype.send = function(body) {
          return originalSend.call(this, patchBody(body));
        };
      }

      // 拦截 fetch
      if (window.fetch) {
        const originalFetch = window.fetch;
        window.fetch = function(url, options) {
          if (options && options.body && typeof options.body === 'string') {
            options = Object.assign({}, options, { body: patchBody(options.body) });
          }
          return originalFetch.call(this, url, options);
        };
      }
    })()
  `;
  await win.webContents.executeJavaScript(script);
}

/**
 * 从 queryValidProductList 响应体解析商品数据
 * @param {string} responseBody - API 响应 JSON 字符串
 * @param {Map} skuMap - productId → SKU列表 的映射（可为空 Map）
 * @returns {Object} { success, goods, total } 或 { success: false, error }
 */
function parseProductListResponse(responseBody, skuMap = new Map()) {
  let json;
  try {
    json = JSON.parse(responseBody);
  } catch(e) {
    return { success: false, error: '响应解析失败' };
  }

  if (json.code !== 200) {
    return { success: false, error: json.msg || `API错误 code=${json.code}` };
  }

  const items = json.data && json.data.data;
  if (!Array.isArray(items)) {
    return { success: false, error: 'API响应结构异常' };
  }

  console.log(`[店铺商品] 获取到 ${items.length} 个商品`);

  const allGoods = [];
  for (const product of items) {
    const productName = product.productName || '';
    let listDate = '';
    if (product.onlineTime) {
      const ts = typeof product.onlineTime === 'number' ? product.onlineTime : parseInt(product.onlineTime);
      if (ts > 0) {
        const d = new Date(ts);
        listDate = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      }
    }

    let price = null;
    if (product.priceDetailVO && product.priceDetailVO.jdPrice != null) {
      price = parseFloat(product.priceDetailVO.jdPrice);
    }

    let imageUrl = product.logo || '';
    if (imageUrl && !imageUrl.startsWith('http')) {
      imageUrl = 'https://img14.360buyimg.com/n1/' + imageUrl.replace(/^\/+/, '');
    }

    const productCode = String(product.productId || '');
    const expandedSkus = skuMap.get(productCode);

    if (expandedSkus && expandedSkus.length > 0) {
      for (const skuItem of expandedSkus) {
        const skuId = getSkuItemId(skuItem);
        let skuPrice = price;
        const skuPriceVo = skuItem.priceDetailVO || skuItem.priceVo || skuItem.price || null;
        if (skuPriceVo && skuPriceVo.jdPrice != null) {
          skuPrice = parseFloat(skuPriceVo.jdPrice);
        } else if (skuItem.jdPrice != null) {
          skuPrice = parseFloat(skuItem.jdPrice);
        } else if (skuItem.price != null) {
          skuPrice = parseFloat(skuItem.price);
        }
        let skuListDate = listDate;
        if (skuItem.onlineTime) {
          const ot = skuItem.onlineTime;
          if (typeof ot === 'string' && ot.includes('-')) {
            skuListDate = ot.substring(0, 10);
          } else {
            const ts = typeof ot === 'number' ? ot : parseInt(ot);
            if (ts > 0) {
              const d = new Date(ts);
              skuListDate = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
            }
          }
        }
        let skuName = skuItem.skuName || skuItem.sku_name || skuItem.name || productName;
        const saleAttrs = skuItem.saleAttrs || skuItem.saleAttrList || skuItem.attrs || skuItem.specs || null;
        if (saleAttrs && Array.isArray(saleAttrs)) {
          const attrs = saleAttrs.map(a => {
            if (Array.isArray(a.attrValueAlias) && a.attrValueAlias.length > 0) return a.attrValueAlias[0];
            if (typeof a.attrValueAlias === 'string' && a.attrValueAlias) return a.attrValueAlias;
            if (Array.isArray(a.attrValues) && a.attrValues.length > 0) return a.attrValues[0];
            return a.attrValueName || a.attrValue || a.name || '';
          }).filter(Boolean);
          if (attrs.length > 0 && !skuName.includes('[')) {
            skuName = productName + ' [' + attrs.join(', ') + ']';
          }
        }
        allGoods.push({
          sku: skuId,
          productCode: productCode,
          name: skuName,
          price: skuPrice,
          listDate: skuListDate,
          image: imageUrl
        });
      }
    } else {
      let skuId = '';
      if (product.productSkuInfoVO && product.productSkuInfoVO.skuId) {
        skuId = String(product.productSkuInfoVO.skuId);
      }
      allGoods.push({
        sku: skuId,
        productCode: productCode,
        name: productName,
        price: price,
        listDate: listDate,
        image: imageUrl
      });
    }
  }

  const skuExpandedCount = Array.from(skuMap.values()).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`[店铺商品] 最终: ${items.length} 个商品 → ${allGoods.length} 条SKU记录 (展开了 ${skuMap.size} 个商品, ${skuExpandedCount} 个SKU)`);

  return { success: true, goods: allGoods, total: allGoods.length };
}

/**
 * 在 dom-ready 时注入查询参数到页面上下文
 * reload 后页面上下文销毁，需要在 dom-ready 时重新注入
 */
function injectQueryParams(win, queryParams) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      win.webContents.removeListener('dom-ready', onDomReady);
      resolve();
    };
    const onDomReady = () => {
      win.webContents.executeJavaScript(
        `window.__ychelper_query_params__ = ${JSON.stringify(queryParams)};`
      ).then(() => {
        console.log('[店铺商品] 查询参数已注入 (dom-ready)');
        done();
      }).catch(() => done());
    };
    win.webContents.once('dom-ready', onDomReady);
    const timeoutId = setTimeout(() => {
      console.warn('[店铺商品] injectQueryParams 超时(30s)，强制继续');
      done();
    }, 30000);
  });
}

/**
 * 检测页面是否跳转到登录页（session 过期）
 */
async function detectLoginExpired(win) {
  if (!win || win.isDestroyed()) return true;
  const url = win.webContents.getURL();
  return url.includes('passport.jd.com') || url.includes('/login');
}

const SHOP_GOODS_PAGE_URL = 'https://wares-jdm.jd.com/ware/wareList?activeTab=OnsaleWare&businessModel=0';

function formatShopApiError(parsed, label) {
  if (Number(parsed.code) === 601) {
    return `${label}触发京东风险校验(code:601)，本次未继续请求，请稍后在店铺后台确认账号状态`;
  }
  if (Number(parsed.code) === 312) {
    return `${label}签名校验失败(code:312)，请重新打开店铺后台后重试`;
  }
  return `${label}失败：${parsed.error || '未知错误'}`;
}

function logShopApiFailure(parsed, label) {
  const json = parsed && parsed.json && typeof parsed.json === 'object' ? parsed.json : null;
  const data = json && json.data && typeof json.data === 'object' ? json.data : null;
  const code = parsed && parsed.code != null ? parsed.code : '未知';
  const error = parsed && parsed.error ? parsed.error : '未知错误';
  const responseKeys = json ? Object.keys(json).slice(0, 20).join(',') : '(无JSON)';
  const dataKeys = data ? Object.keys(data).slice(0, 20).join(',') : '(无data)';
  console.warn(
    `[店铺商品] ${label}业务响应失败: code=${code}, message=${error}, ` +
    `responseKeys=${responseKeys}, dataKeys=${dataKeys}`
  );
}

const SHOP_SFF_CONTEXT_HEADER_NAMES = [
  'dsm-eid',
  'dsm-platform'
];

/**
 * 在商品页首次自动查询时，仅从该页面自己的官方请求中读取 DSM 环境头。
 * 不读取 Cookie、h5st 或 Authorization，也不把环境头的值写入日志。
 */
async function captureShopSffContextHeaders(win, timeoutMs = 35000) {
  if (shopSffContextHeaders) return shopSffContextHeaders;
  if (!win || win.isDestroyed()) throw new Error('店铺后台窗口已关闭');

  let attachedHere = false;
  if (!win.webContents.debugger.isAttached()) {
    win.webContents.debugger.attach('1.3');
    attachedHere = true;
  }
  await win.webContents.debugger.sendCommand('Network.enable');

  return new Promise((resolve) => {
    let settled = false;
    const finish = (headers) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      win.webContents.debugger.removeListener('message', onMessage);
      if (attachedHere && win.webContents.debugger.isAttached()) {
        try { win.webContents.debugger.detach(); } catch (error) {}
      }
      resolve(headers || null);
    };

    const onMessage = (event, method, params) => {
      if (method !== 'Network.requestWillBeSent') return;
      const request = params && params.request;
      if (!request || !String(request.url || '').includes(PRODUCT_LIST_API)) return;

      const sourceHeaders = request.headers || {};
      const normalized = {};
      for (const [name, value] of Object.entries(sourceHeaders)) {
        const lowerName = String(name).toLowerCase();
        if (SHOP_SFF_CONTEXT_HEADER_NAMES.includes(lowerName)) {
          normalized[lowerName] = String(value == null ? '' : value);
        }
      }

      // dsm-eid 是签名请求所依赖的当前页面设备上下文；缺少时不能复用该模板。
      if (!normalized['dsm-eid']) return;
      shopSffContextHeaders = normalized;
      console.log(
        `[店铺商品] 已捕获官方 DSM 请求环境: ` +
        `${Object.keys(normalized).sort().join(',')}（值不写入日志）`
      );
      finish(normalized);
    };

    win.webContents.debugger.on('message', onMessage);
    const timer = setTimeout(() => {
      console.warn('[店铺商品] 等待商品页官方 DSM 请求环境超时');
      finish(null);
    }, timeoutMs);
  });
}

async function waitForShopPageLoad(win, timeoutMs = 25000) {
  if (!win || win.isDestroyed()) throw new Error('店铺后台窗口已关闭');
  if (!win.webContents.isLoading()) return;

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      win.webContents.removeListener('did-finish-load', finish);
      resolve();
    };
    win.webContents.once('did-finish-load', finish);
    const timer = setTimeout(finish, timeoutMs);
  });
}

async function ensureShopGoodsPageReady(win) {
  if (!win || win.isDestroyed()) throw new Error('店铺后台窗口无法创建');

  const currentUrl = win.webContents.getURL();
  const contextHeadersPromise = shopSffContextHeaders
    ? Promise.resolve(shopSffContextHeaders)
    : captureShopSffContextHeaders(win);
  if (!currentUrl.startsWith('https://wares-jdm.jd.com/ware/wareList')) {
    console.log('[店铺商品] 在当前登录会话中打开商品列表页');
    try {
      await win.loadURL(SHOP_GOODS_PAGE_URL);
    } catch (error) {
      if (!String(error.message || '').includes('ERR_ABORTED')) throw error;
    }
  } else if (!shopSffContextHeaders) {
    // 当前已经在商品页但尚未取得官方请求模板时，刷新一次触发页面自己的初始查询。
    console.log('[店铺商品] 刷新商品列表页以获取官方 DSM 请求环境');
    win.webContents.reload();
  }

  await waitForShopPageLoad(win);
  if (await detectLoginExpired(win)) {
    shopLoggedIn = false;
    throw new Error('店铺登录已过期，请重新登录店铺后台');
  }

  const contextHeaders = await contextHeadersPromise;
  if (!contextHeaders || !contextHeaders['dsm-eid']) {
    throw new Error('未取得商品页官方 DSM 请求环境，请确认商品列表页可以正常加载');
  }

  // 等待商品页官方 ParamsSign 组件初始化。这里只读取状态，不覆盖任何页面 API。
  let runtime = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!win || win.isDestroyed()) throw new Error('店铺后台窗口已关闭');
    try {
      runtime = await win.webContents.executeJavaScript(`
        (function() {
          return {
            readyState: document.readyState,
            paramsSignReady: typeof ParamsSign === 'function' &&
              ParamsSign.prototype && typeof ParamsSign.prototype.sign === 'function'
          };
        })()
      `);
    } catch (error) {
      runtime = null;
    }
    if (runtime && runtime.readyState !== 'loading' && runtime.paramsSignReady) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  if (!runtime || !runtime.paramsSignReady) {
    throw new Error('店铺商品页签名组件未加载，请打开店铺后台确认页面是否正常');
  }
  console.log('[店铺商品] 商品页已就绪，官方 ParamsSign 已初始化');
}

async function generateShopH5st(win, api, bodyText, timeoutMs = 15000) {
  const bodyHash = crypto.createHash('sha256').update(bodyText, 'utf8').digest('hex').toUpperCase();
  const signInput = {
    body: bodyHash,
    appId: SHOP_SFF_APP_ID,
    api,
    v: '1.0'
  };
  const script = `
    (function() {
      if (typeof ParamsSign !== 'function') {
        throw new Error('ParamsSign未加载');
      }
      var signer = new ParamsSign({ appId: ${JSON.stringify(SHOP_H5ST_APP_ID)} });
      return Promise.resolve(signer.sign(${JSON.stringify(signInput)})).then(function(result) {
        return {
          h5st: result && result.h5st ? String(result.h5st) : '',
          stk: result && result._stk ? String(result._stk) : '',
          ste: result && result._ste != null ? Number(result._ste) : null
        };
      });
    })()
  `;

  let signTimeoutId = null;
  let signature;
  try {
    signature = await Promise.race([
      win.webContents.executeJavaScript(script),
      new Promise((resolve, reject) => {
        signTimeoutId = setTimeout(() => reject(new Error('店铺页面签名超时')), timeoutMs);
      })
    ]);
  } finally {
    if (signTimeoutId) clearTimeout(signTimeoutId);
  }
  if (!signature || typeof signature.h5st !== 'string' || signature.h5st.length < 100) {
    throw new Error('店铺页面未生成有效请求签名');
  }
  return signature;
}

async function waitForShopSffRequestPacing() {
  if (!lastShopSffResponseFinishedAt) return;
  const elapsed = Date.now() - lastShopSffResponseFinishedAt;
  const delayMs = Math.max(0, SHOP_REQUEST_RESPONSE_DELAY_MS - elapsed);
  if (delayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}

function sendShopSffHttpsRequest(requestUrl, bodyText, headers, timeoutMs) {
  const normalizedTimeoutMs = Math.max(1000, Number(timeoutMs) || 30000);
  const maxResponseBytes = 20 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    let settled = false;
    const succeed = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const request = https.request(requestUrl, {
      method: 'POST',
      agent: shopSffHttpsAgent,
      headers
    }, response => {
      const chunks = [];
      let responseBytes = 0;
      response.on('data', chunk => {
        responseBytes += chunk.length;
        if (responseBytes > maxResponseBytes) {
          response.destroy();
          fail(new Error('店铺接口响应超过20MB，已停止读取'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        succeed({
          status: Number(response.statusCode) || 0,
          headers: response.headers || {},
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
      response.on('error', fail);
    });

    request.setTimeout(normalizedTimeoutMs, () => {
      request.destroy(new Error('店铺接口请求超时'));
    });
    request.on('error', fail);
    request.end(bodyText);
  });
}

async function executeShopSffRequest(win, api, requestBody, timeoutMs = 30000) {
  if (!win || win.isDestroyed()) throw new Error('店铺后台窗口已关闭');

  await waitForShopSffRequestPacing();
  const bodyText = JSON.stringify(requestBody);
  const signature = await generateShopH5st(win, api, bodyText);
  const requestUrl = `https://sff.jd.com/api?v=1.0&appId=${encodeURIComponent(SHOP_SFF_APP_ID)}&api=${encodeURIComponent(api)}`;
  const cookies = await getShopSession().cookies.get({ url: 'https://sff.jd.com/' });
  const headers = buildShopSffRequestHeaders({
    bodyText,
    h5st: signature.h5st,
    dsmEid: shopSffContextHeaders && shopSffContextHeaders['dsm-eid'],
    userAgent: win.webContents.getUserAgent(),
    cookies
  });

  console.log(`[店铺商品] 主进程精简请求已签名: api=${api}, h5st=true`);
  let result;
  try {
    result = await sendShopSffHttpsRequest(requestUrl, bodyText, headers, timeoutMs);
  } finally {
    lastShopSffResponseFinishedAt = Date.now();
  }
  const status = Number(result && result.status) || 0;
  console.log(`[店铺商品] 主进程精简请求完成: api=${api}, HTTP=${status}`);

  if (status === 401 || status === 403) {
    shopLoggedIn = false;
    throw new Error(`店铺登录已失效(HTTP ${status})，请重新登录`);
  }
  if ([301, 302, 303, 307, 308].includes(status)) {
    const location = String(result && result.headers && result.headers.location || '');
    if (/passport\.jd\.com|\/login/i.test(location)) shopLoggedIn = false;
    throw new Error(shopLoggedIn
      ? `店铺接口发生重定向(HTTP ${status})`
      : '店铺登录已失效，请重新登录');
  }
  if (status < 200 || status >= 300) {
    throw new Error(`店铺接口请求失败(HTTP ${status || '未知'})`);
  }

  const responseBody = String((result && result.body) || '');
  return responseBody;
}

/**
 * 复用已登录店铺页生成签名，并按老款实测顺序由主进程请求：
 * 每取一页 SPU，立即按 productId 串行取完该页 SKU，再进入下一页。
 */
async function queryShopGoodsDirect(params, onProgress = () => {}) {
  if (shopQueryInProgress) {
    return { success: false, error: '已有查询任务在进行中，请等待完成' };
  }
  shopQueryInProgress = true;
  const emitProgress = progress => {
    try { onProgress(progress); } catch (error) {}
  };

  try {
    emitProgress({ stage: 'preparing', message: '正在准备店铺商品页…' });
    const queryOptions = {
      pageSize: 100,
      productState: getProductState(params.goodsStatus),
      dateFrom: params.dateFrom || '',
      dateTo: params.dateTo || ''
    };
    const firstProductRequestBody = buildProductListRequest({ ...queryOptions, pageNum: 1 });
    console.log('[店铺商品] 开始查询（复用已登录页面）, params:', JSON.stringify(queryOptions));

    const win = await ensureShopPageWindow({ show: false });
    await ensureShopGoodsPageReady(win);
    emitProgress({ stage: 'preparing', message: '商品页已就绪，正在查询第1页…' });

    lastShopSffResponseFinishedAt = 0;
    console.log(
      `[店铺商品] 使用老款实测流程：每页SPU后查询本页SKU，` +
      `每次响应后等待${SHOP_REQUEST_RESPONSE_DELAY_MS}ms`
    );
    const queryResult = await queryProductPagesPageMajor({
      pageSize: queryOptions.pageSize,
      fetchProductPage: async pageNum => {
        const requestBody = pageNum === 1
          ? firstProductRequestBody
          : buildProductListRequest({ ...queryOptions, pageNum });
        const responseBody = await executeShopSffRequest(win, PRODUCT_LIST_API, requestBody);
        const page = extractProductPage(responseBody);
        if (!page.success) {
          logShopApiFailure(page, `商品列表第${pageNum}页`);
          throw new Error(formatShopApiError(page, `商品列表第${pageNum}页`));
        }
        return page;
      },
      fetchSkuList: async productId => {
        const skuResponseBody = await executeShopSffRequest(
          win,
          SKU_LIST_API,
          buildSkuListRequest(productId),
          SKU_REQUEST_TIMEOUT_MS
        );
        const skuResult = extractSkuList(skuResponseBody);
        if (!skuResult.success) {
          logShopApiFailure(skuResult, `商品${productId}的SKU查询`);
          throw new Error(formatShopApiError(skuResult, `商品${productId}的SKU查询`));
        }
        return skuResult.items;
      },
      onProductPage: ({ pageNum, totalPages, totalCount, completed, items, allProducts }) => {
        console.log(
          `[店铺商品] SPU第${pageNum}/${totalPages}页：` +
          `本页${items.length}个，累计${allProducts.length}/${totalCount}`
        );
        emitProgress({
          stage: 'sku',
          completed,
          total: totalCount,
          pageNum,
          totalPages,
          pageCompleted: 0,
          pageTotal: items.length
        });
      },
      onMissingProductId: ({ productNumber, totalCount, pageNum, totalPages, pageIndex, pageSize }) => {
        console.warn(`[店铺商品] 第${productNumber}个商品没有 productId，无法查询 SKU`);
        emitProgress({
          stage: 'sku',
          completed: productNumber,
          total: totalCount,
          pageNum,
          totalPages,
          pageCompleted: pageIndex + 1,
          pageTotal: pageSize
        });
      },
      onSku: ({ productNumber, totalCount, totalPages, pageNum, pageIndex, pageSize, productId, skuItems }) => {
        if (skuItems.length === 0) {
          console.warn(`[店铺商品] 商品${productId}的SKU接口返回0条，将保留商品列表附带的SKU`);
        }
        console.log(
          `[店铺商品] SKU ${productNumber}/${totalCount}（第${pageNum}页 ` +
          `${pageIndex + 1}/${pageSize}）：商品${productId}共${skuItems.length}个`
        );
        emitProgress({
          stage: 'sku',
          completed: productNumber,
          total: totalCount,
          pageNum,
          totalPages,
          pageCompleted: pageIndex + 1,
          pageTotal: pageSize
        });
      }
    });
    const { allProducts, skuMap } = queryResult;

    const combinedResponse = JSON.stringify({ code: 200, data: { data: allProducts } });
    const parsed = parseProductListResponse(combinedResponse, skuMap);
    if (!parsed.success) {
      return { success: false, error: parsed.error || '商品与SKU数据组合失败' };
    }

    let goods = parsed.goods;
    const pMin = params.priceMin ? Number.parseFloat(params.priceMin) : 0;
    const pMax = params.priceMax ? Number.parseFloat(params.priceMax) : Infinity;
    if (pMin > 0 || pMax < Infinity) {
      goods = goods.filter(item => item.price == null || (item.price >= pMin && item.price <= pMax));
    }

    const message = `查询到${allProducts.length}个商品，完整展开为${goods.length}个SKU`;
    console.log(`[店铺商品] ${message}`);
    emitProgress({
      stage: 'complete',
      completed: queryResult.totalCount,
      total: queryResult.totalCount,
      skuTotal: goods.length,
      message
    });
    return { success: true, goods, total: goods.length, productTotal: allProducts.length, message };
  } catch (error) {
    console.error('[店铺商品] 查询异常:', error.message, error.stack || '');
    emitProgress({ stage: 'error', message: error.message });
    return { success: false, error: error.message };
  } finally {
    shopQueryInProgress = false;
  }
}

ipcMain.handle('shop-query-goods', async (event, params) => {
  assertAutomationAccess();
  console.log('[店铺商品] shop-query-goods 被调用, shopLoggedIn:', shopLoggedIn, 'params:', JSON.stringify(params));
  if (!SHOP_GOODS_DIRECT_QUERY_ENABLED) {
    const error = '为避免触发京东客户端或风控提示，商品查询已临时暂停；待确认老款软件流程后再恢复';
    console.warn(`[店铺商品] ${error}`);
    return { success: false, temporarilyDisabled: true, error };
  }
  if (!shopLoggedIn) {
    return { success: false, error: '店铺未登录，请先登录店铺后台', needLogin: true };
  }

  try {
    const sender = event.sender;
    const result = await queryShopGoodsDirect(params, progress => {
      if (!sender.isDestroyed()) sender.send('shop-query-progress', progress);
    });
    if (!result.success && !shopLoggedIn) result.needLogin = true;
    return result;
  } catch (err) {
    console.error('[店铺商品] 查询异常:', err.message);
    return { success: false, error: err.message, needLogin: !shopLoggedIn };
  }
});

// 导出 SKU TXT 文件
ipcMain.handle('export-sku-txt', async (event, { skus, shopName, dateFrom, dateTo } = {}) => {
  assertAutomationAccess();
  try {
    const exportSkus = Array.isArray(skus)
      ? skus.map(value => String(value || '').trim()).filter(Boolean)
      : [];
    if (exportSkus.length === 0) {
      return { success: false, error: '没有可导出的 SKU' };
    }

    const outputDir = app.getPath('desktop');
    const requestedFileName = buildShopSkuExportFileName({
      shopName,
      dateFrom,
      dateTo,
      skuCount: exportSkus.length
    });
    const extension = path.extname(requestedFileName);
    const baseName = path.basename(requestedFileName, extension);
    let fileName = requestedFileName;
    let filePath = path.join(outputDir, fileName);
    let sequence = 1;
    while (fs.existsSync(filePath)) {
      fileName = `${baseName}(${sequence})${extension}`;
      filePath = path.join(outputDir, fileName);
      sequence += 1;
    }

    fs.writeFileSync(filePath, exportSkus.join('\n'), 'utf-8');
    return { success: true, filePath, fileName, skuCount: exportSkus.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 店铺管理统计数据
ipcMain.handle('get-sm-stats', async () => {
  const stats = storeGet('smStats', { date: '', shops: 0, skus: 0 });
  const today = new Date().toISOString().slice(0, 10);
  if (stats.date !== today) {
    // 非今日数据，重置
    return { date: today, shops: 0, skus: 0 };
  }
  return stats;
});

ipcMain.handle('update-sm-stats', async (event, { shops, skus }) => {
  assertAutomationAccess();
  const today = new Date().toISOString().slice(0, 10);
  let stats = storeGet('smStats', { date: '', shops: 0, skus: 0 });
  if (stats.date !== today) {
    stats = { date: today, shops: 0, skus: 0 };
  }
  stats.shops += (shops || 0);
  stats.skus += (skus || 0);
  storeSet('smStats', stats);
  return stats;
});

// ========== IPC: Excel 上传 ==========

// 4种模板的上传接口配置
const uploadConfigs = {
  popGoodsImport: {
    url: 'https://o.jdl.com/shopGoods/importPopSG.do',
    fileField: 'shopGoodsPopGoodsListFile',
    needCsrf: true,
    buildQuery: (params) => `spShopNo=${params.spShopNo || ''}&_r=${Math.random()}`
  },
  goodsLogistics: {
    url: 'https://o.jdl.com/goods/doImportGoodsLogistics.do',
    fileField: 'importAttributeFile',
    needCsrf: false,
    buildQuery: () => `_r=${Math.random()}`
  },
  updateShopGoods: {
    url: 'https://o.jdl.com/shopGoods/importUpdateShopGoodsJpSearch.do',
    fileField: 'updateShopGoodsJpSearchListFile',
    needCsrf: true,
    buildQuery: () => `_r=${Math.random()}`
  },
  purchaseImport: {
    url: 'https://o.jdl.com/poMain/batchImportPo.do',
    fileField: 'batchImportPoFiles',
    needCsrf: false,
    buildQuery: () => ''
  }
};

// 通用文件上传函数（使用 session.fetch，自动携带 session cookie）
async function uploadFileToApi(config, filePath, params = {}) {
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2, 15);
  const fileName = path.basename(filePath);
  const fileData = fs.readFileSync(filePath);

  // 构建 multipart body
  const parts = [];

  // 额外表单字段（如 csrfToken）
  if (config.needCsrf) {
    const csrfToken = storeGet('csrfToken', '');
    if (csrfToken) {
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="csrfToken"\r\n\r\n` +
        `${csrfToken}\r\n`
      );
    }
  }

  // 文件字段
  const fileHeader =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${config.fileField}"; filename="${fileName}"\r\n` +
    `Content-Type: application/vnd.ms-excel\r\n\r\n`;
  const fileFooter = `\r\n--${boundary}--\r\n`;

  const body = Buffer.concat([
    Buffer.from(parts.join('')),
    Buffer.from(fileHeader),
    fileData,
    Buffer.from(fileFooter)
  ]);

  // 构建完整 URL
  const query = config.buildQuery(params);
  const fullUrl = query ? `${config.url}?${query}` : config.url;

  console.log(`上传文件: ${fileName} -> ${fullUrl}`);
  console.log(`上传 body 大小: ${body.length}, csrfToken: ${config.needCsrf ? storeGet('csrfToken', '').substring(0, 10) + '...' : '不需要'}`);

  const response = await getMerchantSession().fetch(fullUrl, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': 'https://o.jdl.com',
      'Referer': fullUrl
    },
    body: body
  });

  const responseText = await response.text();
  console.log(`上传响应 [${response.status}]:`, responseText.substring(0, 500));

  try {
    const jsonResp = JSON.parse(responseText);
    return { success: response.ok, statusCode: response.status, data: jsonResp };
  } catch (e) {
    return { success: response.ok, statusCode: response.status, data: responseText };
  }
}

ipcMain.handle('upload-excel', async (event, { type, filePath, params }) => {
  try {
    const config = uploadConfigs[type];
    if (!config) {
      return { success: false, error: `未知的上传类型: ${type}` };
    }

    if (!fs.existsSync(filePath)) {
      return { success: false, error: `文件不存在: ${filePath}` };
    }

    const result = await uploadFileToApi(config, filePath, params || {});
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 查询店铺商品列表（根据 SKU 获取 CSG 编码）— 批量查询
ipcMain.handle('query-shop-goods', async (event, { skus }) => {
  try {
    const csrfToken = storeGet('csrfToken', '');
    const sellerId = storeGet('sellerId', '');
    const sellerNo = sellerId ? `CCP00${sellerId}` : '';
    const results = {};
    const failed = [];

    // 将SKU按批次分组，每批最多50个
    const CSG_BATCH = 50;
    const batches = [];
    for (let i = 0; i < skus.length; i += CSG_BATCH) {
      batches.push(skus.slice(i, i + CSG_BATCH));
    }

    console.log(`CSG批量查询: ${skus.length}个SKU，分${batches.length}批（每批最多${CSG_BATCH}）`);

    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi];
      // 每批查询间隔1.5秒，避免限流
      if (bi > 0) await new Promise(r => setTimeout(r, 1500));

      const batchSize = batch.length;
      const aoData = JSON.stringify([
        {"name":"sEcho","value":bi + 1},
        {"name":"iColumns","value":14},
        {"name":"sColumns","value":",,,,,,,,,,,,,,"},
        {"name":"iDisplayStart","value":0},
        {"name":"iDisplayLength","value":batchSize},
        {"name":"mDataProp_0","value":0},{"name":"bSortable_0","value":false},
        {"name":"mDataProp_1","value":1},{"name":"bSortable_1","value":false},
        {"name":"mDataProp_2","value":"shopGoodsName"},{"name":"bSortable_2","value":false},
        {"name":"mDataProp_3","value":"goodsNo"},{"name":"bSortable_3","value":false},
        {"name":"mDataProp_4","value":"spGoodsNo"},{"name":"bSortable_4","value":false},
        {"name":"mDataProp_5","value":"isvGoodsNo"},{"name":"bSortable_5","value":false},
        {"name":"mDataProp_6","value":"shopGoodsNo"},{"name":"bSortable_6","value":false},
        {"name":"mDataProp_7","value":"barcode"},{"name":"bSortable_7","value":false},
        {"name":"mDataProp_8","value":"shopName"},{"name":"bSortable_8","value":false},
        {"name":"mDataProp_9","value":"createTime"},{"name":"bSortable_9","value":false},
        {"name":"mDataProp_10","value":10},{"name":"bSortable_10","value":false},
        {"name":"mDataProp_11","value":"isCombination"},{"name":"bSortable_11","value":false},
        {"name":"mDataProp_12","value":"status"},{"name":"bSortable_12","value":false},
        {"name":"mDataProp_13","value":13},{"name":"bSortable_13","value":false},
        {"name":"iSortCol_0","value":9},
        {"name":"sSortDir_0","value":"desc"},
        {"name":"iSortingCols","value":1}
      ]);

      let retries = 3;
      while (retries > 0) {
        try {
          const url = `https://o.jdl.com/shopGoods/queryShopGoodsList.do?rand=${Math.random()}`;
          const params = new URLSearchParams();
          params.set('csrfToken', csrfToken);
          params.set('ids', '');
          params.set('shopId', '');
          params.set('sellerId', sellerId);
          params.set('sellerNo', sellerNo);
          params.set('deptId', '');
          params.set('deptNo', '');
          params.set('shopNo', '');
          params.set('spSource', '');
          params.set('shopGoodsName', '');
          params.set('isCombination', '');
          params.set('barcode', '');
          params.set('jdDeliver', '');
          params.set('createTimeRange', '');
          params.set('sellerGoodsSigns', batch.join(','));
          params.set('spGoodsNos', '');
          params.set('goodsNos', '');
          params.set('isvGoodsNos', '');
          params.set('status', '');
          params.set('originSend', '');
          params.set('aoData', aoData);

          const response = await getMerchantSession().fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-Requested-With': 'XMLHttpRequest',
              'Origin': 'https://o.jdl.com',
              'Referer': 'https://o.jdl.com/shopGoods/shopGoodsList.do'
            },
            body: params.toString()
          });

          const text = await response.text();
          const data = JSON.parse(text);

          // 检测限流
          if (data.resultCode === 0 && data.resultMessage && data.resultMessage.includes('频繁')) {
            retries--;
            if (retries > 0) {
              const waitMatch = data.resultMessage.match(/(\d+)\s*秒/);
              const waitSec = waitMatch ? parseInt(waitMatch[1]) : 2;
              console.log(`CSG限流 批次${bi + 1}，${waitSec}秒后重试 (剩余${retries}次)`);
              await new Promise(r => setTimeout(r, waitSec * 1000));
              continue;
            }
          }

          if (data.aaData && data.aaData.length > 0) {
            // 将返回结果按 sellerGoodsSign 映射回SKU
            const foundSkus = new Set();
            for (const item of data.aaData) {
              const matchSku = String(item.sellerGoodsSign || '');
              if (matchSku && batch.includes(matchSku)) {
                results[matchSku] = {
                  shopGoodsNo: item.shopGoodsNo || '',
                  shopGoodsName: item.shopGoodsName || '',
                  shopId: item.shopId || '',
                  shopNo: item.shopNo || '',
                  raw: item
                };
                foundSkus.add(matchSku);
              }
            }
            // 检查本批中未找到的SKU
            for (const sku of batch) {
              if (!foundSkus.has(sku)) {
                failed.push(sku);
              }
            }
            console.log(`CSG批次${bi + 1}/${batches.length}: 查到${foundSkus.size}/${batch.length}`);
          } else {
            console.log(`CSG批次${bi + 1}未找到任何结果 raw=${text.substring(0, 200).replace(/[\n\r]/g, ' ')}`);
            batch.forEach(sku => failed.push(sku));
          }
          break;  // 成功，跳出重试
        } catch (e) {
          console.error(`CSG批次${bi + 1}查询失败:`, e.message);
          retries--;
          if (retries <= 0) batch.forEach(sku => failed.push(sku));
          else await new Promise(r => setTimeout(r, 1500));
        }
      }
    }

    console.log('CSG查询结果:', JSON.stringify({ found: Object.keys(results).length, failed: failed.length }));
    if (Object.keys(results).length > 0) {
      const first = Object.entries(results)[0];
      console.log('CSG样例:', first[0], '->', first[1].shopGoodsNo);
    }
    return { success: true, results, failed };
  } catch (err) {
    console.error('CSG查询异常:', err.message);
    return { success: false, error: err.message, results: {}, failed: skus };
  }
});

// 批量保存库存比例配置
ipcMain.handle('save-stock-config', async (event, { shopGoodsList, percent, vmiPercent, stockWay }) => {
  try {
    const csrfToken = storeGet('csrfToken', '');

    // 构建 shopGoodsMapStr: { "goodsId_shopId": item, ... }
    const shopGoodsMap = {};
    const goodsIdList = [];
    const shopIdSet = new Set();
    for (const item of shopGoodsList) {
      const gid = item.goodsId || item.id;
      const sid = item.shopId;
      shopGoodsMap[`${gid}_${sid}`] = item;
      goodsIdList.push(gid);
      shopIdSet.add(String(sid));
    }

    // goodsStockConfigsStr: 按 shopId 分组配置
    const goodsStockConfigs = [];
    for (const sid of shopIdSet) {
      goodsStockConfigs.push({
        shopId: sid,
        percent: String(percent),
        vmiPercent: String(vmiPercent || percent),
        stockWay: String(stockWay || '1')
      });
    }

    const params = new URLSearchParams();
    params.set('csrfToken', csrfToken);
    params.set('shopGoodsMapStr', JSON.stringify(shopGoodsMap));
    params.set('goodsIdListStr', JSON.stringify(goodsIdList));
    params.set('goodsStockConfigsStr', JSON.stringify(goodsStockConfigs));

    console.log(`库存比例批量保存: ${shopGoodsList.length}个商品, ${shopIdSet.size}个店铺, percent=${percent}`);

    const response = await getMerchantSession().fetch('https://o.jdl.com/goodsStockConfig/batchSaveSetting.do', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': 'https://o.jdl.com',
        'Referer': 'https://o.jdl.com/goodsStockConfig/goodsStockConfigList.do'
      },
      body: params.toString()
    });

    const text = await response.text();
    console.log('库存比例批量保存响应:', text.substring(0, 500));

    try {
      const data = JSON.parse(text);
      return { success: response.ok, data };
    } catch (e) {
      return { success: response.ok, data: text };
    }
  } catch (err) {
    console.error('库存比例批量保存异常:', err.message);
    return { success: false, error: err.message };
  }
});

// ========== 批量启用/停用店铺商品 ==========
ipcMain.handle('batch-toggle-shop-goods', async (event, { ids, action }) => {
  try {
    const label = action === 'on' ? '启用' : '停用';
    const numericIds = ids.map(id => Number(id));
    console.log(`批量${label}店铺商品: ${numericIds.length}个, ids=${JSON.stringify(numericIds).substring(0, 200)}`);

    const win = await ensureJdPageReady();
    const storedCsrfToken = storeGet('csrfToken', '');

    if (action === 'on') {
      // 启用：直接调用 batchOnShopGoods.do
      const resultText = await win.webContents.executeJavaScript(`
        (function() {
          return new Promise(function(resolve) {
            var csrfToken = '';
            try {
              if (typeof _csrfToken !== 'undefined') csrfToken = _csrfToken;
              else {
                var el = document.querySelector('input[name="csrfToken"]');
                if (el) csrfToken = el.value;
              }
            } catch(e) {}
            if (!csrfToken) csrfToken = ${JSON.stringify(storedCsrfToken)};

            jQuery.ajax({
              url: '/shopGoods/batchOnShopGoods.do?_r=' + Math.random(),
              type: 'POST',
              data: {
                csrfToken: csrfToken,
                ids: JSON.stringify(${JSON.stringify(numericIds)})
              },
              complete: function(xhr) {
                resolve(JSON.stringify({ httpStatus: xhr.status, response: xhr.responseText || '' }));
              }
            });
          });
        })()
      `);

      console.log('批量启用店铺商品响应:', resultText.substring(0, 500));
      try {
        const parsed = JSON.parse(resultText);
        let data;
        try { data = JSON.parse(parsed.response); } catch(e) { data = parsed.response; }
        return { success: parsed.httpStatus === 200 && (typeof data !== 'object' || data?.resultCode === 1), data };
      } catch (e) {
        return { success: false, data: resultText };
      }
    } else {
      // 停用：两步操作（同一个executeJavaScript上下文中完成）
      // Step 1: checkBatchOffShopGoods.do 预检 → 获取 resultData
      // Step 2: batchOffShopGoods.do 传入 map=resultData 实际停用
      // 需要设置 window.batchChangeStatusMap 全局变量供 h5st 签名
      const resultText = await win.webContents.executeJavaScript(`
        (function() {
          return new Promise(function(resolve) {
            var csrfToken = '';
            try {
              if (typeof _csrfToken !== 'undefined') csrfToken = _csrfToken;
              else {
                var el = document.querySelector('input[name="csrfToken"]');
                if (el) csrfToken = el.value;
              }
            } catch(e) {}
            if (!csrfToken) csrfToken = ${JSON.stringify(storedCsrfToken)};

            // Step 1: 预检
            jQuery.ajax({
              url: '/shopGoods/checkBatchOffShopGoods.do?_r=' + Math.random(),
              type: 'POST',
              dataType: 'json',
              data: {
                csrfToken: csrfToken,
                ids: JSON.stringify(${JSON.stringify(numericIds)})
              },
              success: function(checkData) {
                if (!checkData || checkData.resultCode != 1) {
                  resolve(JSON.stringify({ step: 'check', ok: false, data: checkData }));
                  return;
                }

                // 设置全局变量供 h5st 签名使用
                window.batchChangeStatusMap = checkData.resultData;

                // Step 2: 实际停用
                jQuery.ajax({
                  url: '/shopGoods/batchOffShopGoods.do?_r=' + Math.random(),
                  type: 'POST',
                  dataType: 'json',
                  data: {
                    csrfToken: csrfToken,
                    map: JSON.stringify(checkData.resultData)
                  },
                  complete: function(xhr) {
                    resolve(JSON.stringify({ step: 'off', httpStatus: xhr.status, response: xhr.responseText || '' }));
                  }
                });
              },
              error: function(xhr) {
                resolve(JSON.stringify({ step: 'check', ok: false, error: 'HTTP ' + xhr.status }));
              }
            });
          });
        })()
      `);

      console.log('停用店铺商品响应:', resultText.substring(0, 500));

      try {
        const parsed = JSON.parse(resultText);
        if (parsed.step === 'check' && !parsed.ok) {
          return { success: false, data: parsed.data || parsed.error };
        }
        let data;
        try { data = JSON.parse(parsed.response); } catch(e) { data = parsed.response; }
        return { success: parsed.httpStatus === 200 && (typeof data !== 'object' || data?.resultCode === 1), data };
      } catch (e) {
        return { success: false, data: resultText };
      }
    }
  } catch (err) {
    console.error('批量启用/停用店铺商品异常:', err.message);
    return { success: false, error: err.message };
  }
});

// ========== 批量启用/停用商品主数据 ==========
ipcMain.handle('batch-toggle-master-data', async (event, { ids, action }) => {
  try {
    const label = action === 'on' ? '启用' : '停用';
    console.log(`批量${label}商品主数据: ${ids.length}个, ids=${JSON.stringify(ids).substring(0, 200)}`);

    const win = await ensureJdPageReady();
    const storedCsrfToken = storeGet('csrfToken', '');

    if (action === 'on') {
      // 启用：直接调用 batchOnGoods.do
      const resultText = await win.webContents.executeJavaScript(`
        (function() {
          return new Promise(function(resolve) {
            var csrfToken = '';
            try {
              if (typeof _csrfToken !== 'undefined') csrfToken = _csrfToken;
              else {
                var el = document.querySelector('input[name="csrfToken"]');
                if (el) csrfToken = el.value;
              }
            } catch(e) {}
            if (!csrfToken) csrfToken = ${JSON.stringify(storedCsrfToken)};

            jQuery.ajax({
              url: '/goods/batchOnGoods.do?_r=' + Math.random(),
              type: 'POST',
              data: {
                csrfToken: csrfToken,
                ids: JSON.stringify(${JSON.stringify(ids)})
              },
              complete: function(xhr) {
                resolve(JSON.stringify({ httpStatus: xhr.status, response: xhr.responseText || '' }));
              }
            });
          });
        })()
      `);

      console.log('批量启用商品主数据响应:', resultText.substring(0, 500));
      try {
        const parsed = JSON.parse(resultText);
        let data;
        try { data = JSON.parse(parsed.response); } catch(e) { data = parsed.response; }
        return { success: parsed.httpStatus === 200 && (typeof data !== 'object' || data?.resultCode === 1), data };
      } catch (e) {
        return { success: false, data: resultText };
      }
    } else {
      // 停用：两步操作（同一个executeJavaScript上下文中完成）
      // Step 1: checkBatchOffGoods.do 预检 → 获取 resultData
      // Step 2: batchOffGoods.do 传入 map=resultData 实际停用
      const resultText = await win.webContents.executeJavaScript(`
        (function() {
          return new Promise(function(resolve) {
            var csrfToken = '';
            try {
              if (typeof _csrfToken !== 'undefined') csrfToken = _csrfToken;
              else {
                var el = document.querySelector('input[name="csrfToken"]');
                if (el) csrfToken = el.value;
              }
            } catch(e) {}
            if (!csrfToken) csrfToken = ${JSON.stringify(storedCsrfToken)};

            // Step 1: 预检
            jQuery.ajax({
              url: '/goods/checkBatchOffGoods.do?_r=' + Math.random(),
              type: 'POST',
              dataType: 'json',
              data: {
                csrfToken: csrfToken,
                ids: JSON.stringify(${JSON.stringify(ids)})
              },
              success: function(checkData) {
                if (!checkData || checkData.resultCode != 1) {
                  resolve(JSON.stringify({ step: 'check', ok: false, data: checkData }));
                  return;
                }

                // 设置全局变量供 h5st 签名使用
                window.batchChangeStatusMap = checkData.resultData;

                // Step 2: 实际停用
                jQuery.ajax({
                  url: '/goods/batchOffGoods.do?_r=' + Math.random(),
                  type: 'POST',
                  dataType: 'json',
                  data: {
                    csrfToken: csrfToken,
                    map: JSON.stringify(checkData.resultData)
                  },
                  complete: function(xhr) {
                    resolve(JSON.stringify({ step: 'off', httpStatus: xhr.status, response: xhr.responseText || '' }));
                  }
                });
              },
              error: function(xhr) {
                resolve(JSON.stringify({ step: 'check', ok: false, error: 'HTTP ' + xhr.status }));
              }
            });
          });
        })()
      `);

      console.log('停用商品主数据响应:', resultText.substring(0, 500));

      try {
        const parsed = JSON.parse(resultText);
        if (parsed.step === 'check' && !parsed.ok) {
          return { success: false, data: parsed.data || parsed.error };
        }
        let data;
        try { data = JSON.parse(parsed.response); } catch(e) { data = parsed.response; }
        return { success: parsed.httpStatus === 200 && (typeof data !== 'object' || data?.resultCode === 1), data };
      } catch (e) {
        return { success: false, data: resultText };
      }
    }
  } catch (err) {
    console.error('批量启用/停用商品主数据异常:', err.message);
    return { success: false, error: err.message };
  }
});

// ========== 京配打标生效/取消（复用登录窗口，h5st自动签名） ==========

async function ensureJdPageReady() {
  if (!jdPageWindow || jdPageWindow.isDestroyed()) {
    throw new Error('JD页面窗口未就绪，请重新登录后再试');
  }
  // 检查当前页面状态
  const pageInfo = await jdPageWindow.webContents.executeJavaScript(`
    JSON.stringify({ title: document.title, hasJQuery: typeof jQuery !== 'undefined', url: location.href })
  `);
  const info = JSON.parse(pageInfo);
  console.log('京配打标: 当前页面状态:', pageInfo);

  if (info.hasJQuery) {
    // 当前页面已有jQuery，直接使用
    return jdPageWindow;
  }

  // 当前页面没有jQuery，尝试跳转到shopGoods页
  console.log('京配打标: 当前页面无jQuery，尝试跳转到商品管理页...');
  try {
    await jdPageWindow.loadURL('https://o.jdl.com/shopGoods/shopGoodsList.do');
    await new Promise(r => setTimeout(r, 3000));
    const retryInfo = await jdPageWindow.webContents.executeJavaScript(`
      JSON.stringify({ title: document.title, hasJQuery: typeof jQuery !== 'undefined' })
    `);
    const retry = JSON.parse(retryInfo);
    console.log('京配打标: 跳转后页面状态:', JSON.stringify(retry));
    if (retry.hasJQuery) return jdPageWindow;
  } catch(e) {
    console.error('京配打标: shopGoodsList加载失败:', e.message);
  }

  // shopGoodsList也失败，尝试主页
  console.log('京配打标: 尝试加载o.jdl.com主页...');
  try {
    await jdPageWindow.loadURL('https://o.jdl.com/main/main.do');
    await new Promise(r => setTimeout(r, 3000));
    const mainInfo = await jdPageWindow.webContents.executeJavaScript(`
      JSON.stringify({ title: document.title, hasJQuery: typeof jQuery !== 'undefined' })
    `);
    const main = JSON.parse(mainInfo);
    console.log('京配打标: 主页状态:', JSON.stringify(main));
    if (main.hasJQuery) return jdPageWindow;
  } catch(e) {
    console.error('京配打标: 主页加载失败:', e.message);
  }

  throw new Error('JD页面无法加载jQuery，京配打标功能不可用');
}

ipcMain.handle('jd-label-goods', async (event, { goodArray, enable }) => {
  try {
    const jdDeliver = enable ? '1' : '0';
    const formattedArray = goodArray.map(item => ({
      id: item.id,
      jdDeliver,
      shopId: item.shopId,
      deptId: item.deptId
    }));

    const label = enable ? '生效' : '取消';
    console.log(`京配打标${label}: ${formattedArray.length}个商品`);

    const win = await ensureJdPageReady();
    const storedCsrfToken = storeGet('csrfToken', '');

    // 在JD页面上下文中用jQuery.ajax发起请求（h5st自动添加resParams）
    const resultText = await win.webContents.executeJavaScript(`
      (function() {
        return new Promise(function(resolve) {
          var goodArray = ${JSON.stringify(formattedArray)};
          var csrfToken = '';
          try {
            if (typeof _csrfToken !== 'undefined') csrfToken = _csrfToken;
            else {
              var el = document.querySelector('input[name="csrfToken"]');
              if (el) csrfToken = el.value;
            }
          } catch(e) {}
          // 兜底：使用存储的csrfToken
          if (!csrfToken) csrfToken = ${JSON.stringify(storedCsrfToken)};

          var debugInfo = {
            csrfToken: csrfToken ? csrfToken.substring(0, 10) + '...' : '(empty)',
            hasJQuery: typeof jQuery !== 'undefined',
            pageTitle: document.title
          };

          jQuery.ajax({
            url: '/shopGoods/handleShopGoodsDelivers.do?_r=' + Math.random(),
            type: 'POST',
            data: {
              csrfToken: csrfToken,
              goodArray: JSON.stringify(goodArray)
            },
            complete: function(xhr) {
              debugInfo.httpStatus = xhr.status;
              resolve(JSON.stringify({ _debug: debugInfo, response: xhr.responseText || '' }));
            }
          });
        });
      })()
    `);

    console.log(`京配打标${label}响应:`, resultText.substring(0, 300));

    try {
      const parsed = JSON.parse(resultText);
      let respData;
      try { respData = JSON.parse(parsed.response); } catch(e) { respData = { resultMessage: parsed.response || '空响应' }; }
      return { success: respData.resultCode === 1, data: respData };
    } catch (e) {
      return { success: false, data: resultText };
    }
  } catch (err) {
    console.error('京配打标异常:', err.message);
    return { success: false, error: err.message };
  }
});

// ========== WMS 仓库端 - 验收上架 ==========

let activeWmsAccountId = ''; // 当前活跃的仓库端账号ID
let activeWmsWarehouseName = ''; // 当前实际进入的 WMS 仓库显示名称
let activeWmsWarehouseNo = ''; // 当前实际进入的 WMS 仓库编号
let wmsRestorePromise = null;
let wmsLastRestoreResult = null;

// 获取当前 WMS 的 session 分区名
function getWmsPartition() {
  if (activeWmsAccountId) {
    return cookieManager.getPartitionName('wms', activeWmsAccountId);
  }
  return 'persist:wms'; // 兼容旧版
}

function createWmsApiError(kind, message, status = 0, responseData = null) {
  const error = new Error(message || 'WMS 请求失败');
  error.wmsFailureType = kind;
  error.status = status;
  error.responseData = responseData;
  return error;
}

function getActiveWmsAccount() {
  const accounts = storeGet('wmsAccounts', []);
  return accounts.find(account => account.id === activeWmsAccountId) || null;
}

async function clearInvalidWmsSessionAndOpenLogin(account) {
  const partition = getWmsPartition();
  await cookieManager.clearPartition(partition);
  if (activeWmsAccountId) cookieManager.deleteCookieFile('wms', activeWmsAccountId);

  wmsLoggedIn = false;
  activeWmsWarehouseName = '';
  activeWmsWarehouseNo = '';

  if (wmsLoginWindow && !wmsLoginWindow.isDestroyed()) {
    wmsIsQuitting = true;
    wmsLoginWindow.destroy();
    wmsLoginWindow = null;
    wmsIsQuitting = false;
  }
  if (wmsPrintWindow && !wmsPrintWindow.isDestroyed()) {
    wmsPrintWindow.destroy();
    wmsPrintWindow = null;
  }

  const fallbackCredentials = storeGet('wmsCredentials', null) || {};
  pendingWmsCredentials = {
    id: account?.id || activeWmsAccountId || '',
    username: account?.username || fallbackCredentials.username || '',
    password: account?.password || fallbackCredentials.password || ''
  };
  setTimeout(() => createWmsLoginWindow(), 50);
  return true;
}

async function restoreLastWmsSession({ force = false } = {}) {
  if (wmsRestorePromise) return wmsRestorePromise;
  if (!force && wmsLoggedIn) {
    return wmsLastRestoreResult || {
      status: 'valid',
      loggedIn: true,
      warehouseName: activeWmsWarehouseName,
      warehouseNo: activeWmsWarehouseNo,
      orders: []
    };
  }
  if (!force && ['auth_failed', 'no_account', 'no_cookie'].includes(wmsLastRestoreResult?.status)) {
    return wmsLastRestoreResult;
  }

  wmsRestorePromise = (async () => {
    if (!activeWmsAccountId) {
      wmsLoggedIn = false;
      return { status: 'no_account', loggedIn: false, orders: [] };
    }

    const account = getActiveWmsAccount();
    if (!account) {
      wmsLoggedIn = false;
      return { status: 'no_account', loggedIn: false, orders: [] };
    }

    activeWmsWarehouseName = account.warehouseName || '';
    activeWmsWarehouseNo = account.warehouseNo || '';
    const partition = getWmsPartition();
    const ses = session.fromPartition(partition);

    if (!cookieManager.validateCookieFile('wms', account.id)) {
      wmsLoggedIn = false;
      return { status: 'no_cookie', loggedIn: false, orders: [] };
    }

    console.log(`WMS 恢复: 正在导入上次账号 Cookie, 账号ID: [${account.id}]`);
    const imported = await cookieManager.importCookies(ses, 'wms', account.id);
    if (!imported) {
      wmsLoggedIn = false;
      return { status: 'no_cookie', loggedIn: false, orders: [] };
    }

    const queryResult = await queryWmsOrders(activeWmsWarehouseNo, { allowUnverified: true });
    if (queryResult.success) {
      wmsLoggedIn = true;
      await cookieManager.exportCookies(ses, 'wms', account.id);
      console.log(`WMS 恢复: Cookie 验证成功，查询完成，共 ${queryResult.orders.length} 条单据`);
      return {
        status: 'valid',
        loggedIn: true,
        warehouseName: activeWmsWarehouseName,
        warehouseNo: activeWmsWarehouseNo,
        orders: queryResult.orders,
        total: queryResult.total
      };
    }

    if (queryResult.failureType === 'auth') {
      console.warn('WMS 恢复: 保存的登录状态已失效，清理会话并重新登录');
      await clearInvalidWmsSessionAndOpenLogin(account);
      return {
        status: 'auth_failed',
        loggedIn: false,
        loginOpened: true,
        error: queryResult.error,
        orders: []
      };
    }

    wmsLoggedIn = false;
    const status = queryResult.failureType === 'network' ? 'network_error' : 'service_error';
    console.warn(`WMS 恢复: 验证暂时失败，保留 Cookie: ${queryResult.error}`);
    return { status, loggedIn: false, error: queryResult.error, orders: [] };
  })();

  try {
    wmsLastRestoreResult = await wmsRestorePromise;
    return wmsLastRestoreResult;
  } finally {
    wmsRestorePromise = null;
  }
}

async function waitForWmsWarehouseInfo(targetWindow, timeoutMs = 15000, stableMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  let lastValidKey = '';
  let lastValidInfo = null;
  let stableSince = 0;

  while (Date.now() < deadline) {
    if (!targetWindow || targetWindow.isDestroyed()) return '';
    if (classifyWmsPageUrl(targetWindow.webContents.getURL()) !== 'warehouse-workspace') return '';

    let candidate = null;
    try {
      candidate = await targetWindow.webContents.executeJavaScript(`
        (function() {
          var section = document.querySelector(${JSON.stringify(WMS_WAREHOUSE_SECTION_SELECTOR)});
          var vm = section && section.__vue__;
          var props = vm && vm.$props ? vm.$props : {};
          var warehouseName = vm && vm.name != null ? vm.name : props.name;
          var warehouseNo = vm && vm.no != null ? vm.no : props.no;
          var labelEl = document.querySelector(${JSON.stringify(WMS_WAREHOUSE_MULTI_LABEL_SELECTOR)})
            || document.querySelector(${JSON.stringify(WMS_WAREHOUSE_SINGLE_LABEL_SELECTOR)});
          return {
            label: labelEl ? labelEl.textContent.replace(/\\s+/g, ' ').trim() : '',
            warehouseName: warehouseName == null ? '' : String(warehouseName),
            warehouseNo: warehouseNo == null ? '' : String(warehouseNo)
          };
        })()
      `, true);
    } catch (_) {
      return null;
    }

    const info = normalizeWmsWarehouseInfo(candidate || {});
    if (info.warehouseName && info.warehouseNo) {
      const key = `${info.warehouseName}\u0000${info.warehouseNo}`;
      if (key !== lastValidKey) {
        lastValidKey = key;
        lastValidInfo = info;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= stableMs) {
        return lastValidInfo;
      }
    } else {
      // WMS 初始会短暂渲染占位文本“()”，不能视为有效仓库。
      lastValidKey = '';
      lastValidInfo = null;
      stableSince = 0;
    }

    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return null;
}

async function showWmsManualConfirmFallback(targetWindow, retryFailed = false) {
  if (!targetWindow || targetWindow.isDestroyed()) return false;
  if (classifyWmsPageUrl(targetWindow.webContents.getURL()) !== 'warehouse-workspace') return false;

  try {
    await targetWindow.webContents.executeJavaScript(`
      (function() {
      var buttonId = 'ychelper-wms-manual-confirm';
      var tipId = 'ychelper-wms-manual-confirm-tip';
      var button = document.getElementById(buttonId);
      if (!button) {
        button = document.createElement('button');
        button.id = buttonId;
        button.type = 'button';
        button.style.cssText = 'position:fixed;right:30px;bottom:30px;z-index:999999;'
          + 'border:0;border-radius:8px;padding:12px 24px;background:#1677ff;color:#fff;'
          + 'font-size:15px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.22);';
        document.body.appendChild(button);
      }

      var tip = document.getElementById(tipId);
      if (!tip) {
        tip = document.createElement('div');
        tip.id = tipId;
        tip.style.cssText = 'position:fixed;right:30px;bottom:86px;z-index:999999;max-width:360px;'
          + 'padding:10px 14px;border-radius:8px;background:#fff;color:#333;font-size:14px;'
          + 'line-height:1.5;box-shadow:0 4px 16px rgba(0,0,0,.18);border:1px solid #e8e8e8;';
        document.body.appendChild(tip);
      }

      button.disabled = false;
      button.style.opacity = '1';
      button.style.cursor = 'pointer';
      button.textContent = ${JSON.stringify(retryFailed
        ? '我已进入仓库，重新获取'
        : '我已进入仓库')};
      tip.textContent = ${JSON.stringify(retryFailed
        ? '仍未识别到完整仓库名和仓库编号，请确认右上角信息完整后再次点击。'
        : '软件正在自动获取完整仓库名和编号；若窗口未自动关闭，可点击下方按钮重新获取。')};
      button.onclick = function() {
        button.disabled = true;
        button.style.opacity = '.7';
        button.style.cursor = 'wait';
        button.textContent = '正在获取仓库信息...';
        document.title = '__YCHELPER_WMS_MANUAL_RETRY__' + Date.now();
      };
      })()
    `, true);
    console.log(`WMS: ${retryFailed ? '重新获取' : '我已进入仓库'}兜底按钮已显示`);
    return true;
  } catch (err) {
    console.warn('WMS: 兜底按钮注入失败，继续自动识别:', err.message);
    return false;
  }
}

async function finalizeWmsWorkspaceLogin(targetWindow, wmsPartition, accountId) {
  if (!targetWindow || targetWindow.isDestroyed()) return false;
  if (classifyWmsPageUrl(targetWindow.webContents.getURL()) !== 'warehouse-workspace') return false;

  const warehouseInfo = await waitForWmsWarehouseInfo(targetWindow);
  if (!targetWindow || targetWindow.isDestroyed()) return false;
  if (classifyWmsPageUrl(targetWindow.webContents.getURL()) !== 'warehouse-workspace') return false;
  if (!warehouseInfo || !warehouseInfo.warehouseName || !warehouseInfo.warehouseNo) {
    console.warn('WMS: 工作台已打开，但当前仓库名称/编号尚未完整加载，保留窗口等待用户处理');
    return false;
  }

  activeWmsWarehouseName = warehouseInfo.displayName;
  activeWmsWarehouseNo = warehouseInfo.warehouseNo;
  console.log('WMS 当前仓库:', activeWmsWarehouseName || '(未识别)', activeWmsWarehouseNo || '(无编号)');

  if (accountId) {
    const ses = session.fromPartition(wmsPartition);
    const exported = await cookieManager.exportCookies(ses, 'wms', accountId);
    if (!exported) console.warn('WMS: 已进入仓库，但 Cookie 导出为空');
    storeSet('lastWmsAccountId', accountId);

    const accounts = storeGet('wmsAccounts', []);
    const accountIndex = accounts.findIndex(account => account.id === accountId);
    if (accountIndex >= 0) {
      accounts[accountIndex] = {
        ...accounts[accountIndex],
        warehouseName: activeWmsWarehouseName,
        warehouseNo: activeWmsWarehouseNo,
        lastLogin: Date.now()
      };
      storeSet('wmsAccounts', accounts);
    }
  } else {
    console.warn('WMS: 当前账号缺少 ID，无法保存独立 Cookie 文件');
  }

  wmsLoggedIn = true;
  wmsLastRestoreResult = {
    status: 'valid',
    loggedIn: true,
    warehouseName: activeWmsWarehouseName,
    warehouseNo: activeWmsWarehouseNo,
    orders: []
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('wms-login-success', {
      warehouseName: activeWmsWarehouseName,
      warehouseNo: activeWmsWarehouseNo
    });
  }
  targetWindow.hide();
  console.log('WMS: 已自动确认进入仓库并隐藏登录窗口');
  return true;
}

async function createWmsLoginWindow() {
  // 确定当前 WMS 分区（基于 pendingWmsCredentials 的 ID）
  const accountId = pendingWmsCredentials ? pendingWmsCredentials.id || '' : '';
  if (wmsLoginWindow && !wmsLoginWindow.isDestroyed()) {
    if (accountId && accountId !== activeWmsAccountId) {
      wmsIsQuitting = true;
      wmsLoginWindow.destroy();
      wmsLoginWindow = null;
      wmsIsQuitting = false;
    } else {
      wmsLoginWindow.show();
      wmsLoginWindow.focus();
      return;
    }
  }

  if (accountId) {
    activeWmsAccountId = accountId;
  }
  const wmsPartition = getWmsPartition();

  // WMS 免登录策略：
  // - WMS 有"顶号"机制（同一时间只允许一个 session），cookie 文件恢复不可靠
  // - 同一 app 会话内二次进入：分区 live cookie 有效，可免登录
  // - 重启后：不从文件恢复（大概率被顶号失效），走自动填充快速登录
  if (activeWmsAccountId) {
    const ses = session.fromPartition(wmsPartition);
    const existingCookies = await ses.cookies.get({});
    if (existingCookies.length > 0) {
      console.log(`仓库端: 分区已有 ${existingCookies.length} 条 cookie，使用现有 session（免登录）`);
    } else {
      console.log('仓库端: 分区无 cookie，将通过 passport 自动填充登录');
    }
  }

  wmsLoginWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    center: true,
    show: false,
    title: 'WMS 仓库管理',
    webPreferences: {
      partition: wmsPartition,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // 窗口准备好后再显示
  wmsLoginWindow.once('ready-to-show', () => {
    wmsLoginWindow.show();
  });

  // 处理 WMS 页面的弹出窗口请求（允许在新窗口中打开，避免红色错误标签页）
  wmsLoginWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.log('WMS 弹窗请求:', url.substring(0, 120));
    return {
      action: 'allow',
      overrideBrowserWindowOptions: { show: false }
    };
  });

  let wmsAutoFillCount = 0; // 自动填充计数器，防止无限循环
  let wmsFinalizeInProgress = false;
  const WMS_MAX_AUTO_FILL = 2; // 最多自动填充2次

  const attemptWmsWorkspaceFinalize = async (manualRetry = false) => {
    if (wmsFinalizeInProgress) return false;
    wmsFinalizeInProgress = true;
    try {
      const finalized = await finalizeWmsWorkspaceLogin(
        wmsLoginWindow,
        wmsPartition,
        activeWmsAccountId
      );
      if (!finalized && wmsLoginWindow && !wmsLoginWindow.isDestroyed() &&
          classifyWmsPageUrl(wmsLoginWindow.webContents.getURL()) === 'warehouse-workspace') {
        // 自动或手动获取失败都保留按钮，允许用户继续重试。
        await showWmsManualConfirmFallback(wmsLoginWindow, true);
      }
      return finalized;
    } catch (err) {
      console.error('WMS 自动确认进入仓库失败:', err.message);
      if (wmsLoginWindow && !wmsLoginWindow.isDestroyed() &&
          classifyWmsPageUrl(wmsLoginWindow.webContents.getURL()) === 'warehouse-workspace') {
        await showWmsManualConfirmFallback(wmsLoginWindow, true).catch(() => {});
      }
      return false;
    } finally {
      wmsFinalizeInProgress = false;
    }
  };

  wmsLoginWindow.loadURL('https://unionwms.jdl.com');

  // 监听 WMS 页面的 POST 请求；敏感请求头不得写入日志。
  const wmsSession = session.fromPartition(wmsPartition);
  wmsSession.webRequest.onBeforeSendHeaders({ urls: ['*://api-w6.jdl.com/*'] }, (details, callback) => {
    if (details.method === 'POST') {
      console.log('WMS 网络请求:', details.method, details.url.substring(0, 120));
      if (details.url.includes('queryInboundOrderInfo')) {
        console.log('WMS: 已捕获入库单查询请求头（敏感字段不输出）');
      }
    }
    callback({ cancel: false, requestHeaders: details.requestHeaders });
  });

  // 监听页面跳转，仅记录是否经过了登录页
  wmsLoginWindow.webContents.on('did-navigate', (event, url) => {
    if (url.includes('passport') || url.includes('login') || url.includes('sso')) {
      console.log('WMS: 检测到登录页', url.substring(0, 80));
    }
  });

  // 页面加载完成后：自动填充账号密码 / 检测登录成功后自动关闭
  wmsLoginWindow.webContents.on('did-finish-load', async () => {
    const currentUrl = wmsLoginWindow.webContents.getURL();

    // 仅在 passport 登录页自动填充（跳过 WMS 自身的 /login 仓库选择页）
    if (currentUrl.includes('passport') && !currentUrl.includes('unionwms')) {
      if (wmsAutoFillCount >= WMS_MAX_AUTO_FILL) {
        console.log(`WMS: 自动填充已达上限(${WMS_MAX_AUTO_FILL}次)，停止自动填充，等待用户手动操作`);
        return;
      }
      if (!pendingWmsCredentials || !pendingWmsCredentials.username) return;
      wmsAutoFillCount++;
      const { username, password } = pendingWmsCredentials;
      const fillScript = `
        (function() {
          var tryFill = function() {
            var nameInput = document.getElementById('loginname') || document.querySelector('input[name="loginname"]') || document.querySelector('input[name="nloginname"]');
            var pwdInput = document.getElementById('nloginpwd') || document.querySelector('input[name="loginpwd"]') || document.querySelector('input[name="nloginpwd"]');
            if (nameInput && pwdInput) {
              var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              nativeInputValueSetter.call(nameInput, ${JSON.stringify(username)});
              nameInput.dispatchEvent(new Event('input', { bubbles: true }));
              nameInput.dispatchEvent(new Event('change', { bubbles: true }));
              nativeInputValueSetter.call(pwdInput, ${JSON.stringify(password)});
              pwdInput.dispatchEvent(new Event('input', { bubbles: true }));
              pwdInput.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
            return false;
          };
          if (!tryFill()) { setTimeout(tryFill, 500); }
          if (!tryFill()) { setTimeout(tryFill, 1500); }
        })();
      `;
      try {
        await wmsLoginWindow.webContents.executeJavaScript(fillScript);
        console.log('WMS 自动填充账号密码完成');
      } catch (e) {
        console.log('WMS 自动填充失败:', e.message);
      }
      return;
    }

    const wmsPageType = classifyWmsPageUrl(currentUrl);

    // /logon 只是仓库选择页，不能标记登录成功或导出 Cookie。
    if (wmsPageType === 'warehouse-selection') {
      wmsLoggedIn = false;
      activeWmsWarehouseName = '';
      activeWmsWarehouseNo = '';
      console.log('WMS: 已认证，等待用户选择并进入仓库...');
      return;
    }

    // 进入工作台后自动提取仓库、保存 Cookie，并隐藏窗口。
    if (wmsPageType === 'warehouse-workspace') {
      // 兜底按钮必须立即可见，不能等自动识别超时后才出现。
      await showWmsManualConfirmFallback(wmsLoginWindow, false);
      await attemptWmsWorkspaceFinalize(false);
    }
  });

  // 自动识别失败后，用户点击兜底按钮触发重新提取。
  wmsLoginWindow.on('page-title-updated', async (event, title) => {
    if (!String(title || '').startsWith('__YCHELPER_WMS_MANUAL_RETRY__')) return;
    event.preventDefault();
    if (!wmsLoginWindow || wmsLoginWindow.isDestroyed()) return;
    if (classifyWmsPageUrl(wmsLoginWindow.webContents.getURL()) !== 'warehouse-workspace') return;
    await attemptWmsWorkspaceFinalize(true);
  });

  // 拦截关闭：隐藏窗口而不是真正关闭（保留会话用于 API 调用）
  wmsLoginWindow.on('close', (event) => {
    if (!wmsIsQuitting) {
      event.preventDefault();
      wmsLoginWindow.hide();
    }
  });
}

// IPC: 打开 WMS 登录窗口

ipcMain.handle('open-wms-login', async (event, cred) => {
  pendingWmsCredentials = cred || null;
  // 延迟创建窗口，避免阻塞渲染进程
  setTimeout(() => createWmsLoginWindow(), 50);
});

// 打印出库：在新窗口中打开 WMS 出库处理页面（复用 WMS 分区实现免登录）
let wmsPrintWindow = null;
ipcMain.handle('open-wms-print-outbound', async () => {
  if (wmsPrintWindow && !wmsPrintWindow.isDestroyed()) {
    wmsPrintWindow.show();
    wmsPrintWindow.focus();
    return { success: true };
  }

  const wmsPartition = getWmsPartition();
  if (wmsRestorePromise) await wmsRestorePromise;
  const ses = session.fromPartition(wmsPartition);
  const existingCookies = await ses.cookies.get({});
  if (!wmsLoggedIn && existingCookies.length === 0) {
    return { success: false, error: '请先登录仓库端' };
  }

  wmsPrintWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    center: true,
    title: '打印出库 - WMS',
    webPreferences: {
      partition: wmsPartition,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  wmsPrintWindow.setMenuBarVisibility(false);
  wmsPrintWindow.loadURL('https://unionwms.jdl.com/default#/app-v/jwms-webview/outbound/orderProcess/orderProcessList');

  wmsPrintWindow.on('closed', () => {
    wmsPrintWindow = null;
  });

  console.log('打印出库: 已打开 WMS 出库处理窗口, 分区:', wmsPartition);
  return { success: true };
});

// 检查 WMS 是否已登录（供渲染进程查询，含分区名用于 webview）
ipcMain.handle('check-wms-session', async () => {
  // 打印出库只等待启动恢复，不重复调用验收查询验证 Cookie。
  if (wmsRestorePromise) await wmsRestorePromise;
  const wmsPartition = getWmsPartition();
  const ses = session.fromPartition(wmsPartition);
  const existingCookies = await ses.cookies.get({});
  return {
    loggedIn: wmsLoggedIn,
    hasCookies: existingCookies.length > 0,
    wmsLoggedIn,
    partition: wmsPartition,
    restoreStatus: wmsLastRestoreResult?.status || '',
    warehouseName: activeWmsWarehouseName,
    warehouseNo: activeWmsWarehouseNo
  };
});

ipcMain.handle('restore-wms-session', async () => {
  return restoreLastWmsSession({ force: true });
});

ipcMain.handle('get-wms-credentials', async () => {
  return storeGet('wmsCredentials', null);
});

ipcMain.handle('save-wms-credentials', async (event, cred) => {
  storeSet('wmsCredentials', cred);
  // 同步维护 wmsAccounts 列表，最近登录排最前，最多10个
  let accounts = storeGet('wmsAccounts', []);
  const existIdx = accounts.findIndex(a => a.username === cred.username);
  let savedAccount;
  if (existIdx >= 0) {
    // 已存在：更新密码，移到最前
    accounts[existIdx].password = cred.password;
    accounts[existIdx].lastLogin = Date.now();
    const updated = accounts.splice(existIdx, 1)[0];
    accounts.unshift(updated);
    savedAccount = updated;
  } else {
    // 新账号：创建新条目
    savedAccount = {
      id: require('crypto').randomUUID(),
      username: cred.username,
      password: cred.password,
      lastLogin: Date.now()
    };
    accounts.unshift(savedAccount);
  }
  if (accounts.length > 10) accounts = accounts.slice(0, 10);
  storeSet('wmsAccounts', accounts);
  return savedAccount;
});

// WMS 多账号管理
ipcMain.handle('get-wms-accounts', async () => {
  return storeGet('wmsAccounts', []);
});

ipcMain.handle('save-wms-account', async (event, account) => {
  let list = storeGet('wmsAccounts', []);
  if (account.id) {
    const idx = list.findIndex(a => a.id === account.id);
    if (idx >= 0) {
      list[idx] = {
        ...list[idx],
        username: account.username,
        password: account.password,
        warehouseName: account.warehouseName || list[idx].warehouseName,
        warehouseNo: account.warehouseNo || list[idx].warehouseNo
      };
    }
  } else {
    if (list.length >= 20) {
      return { success: false, error: '最多保存20个仓库端账号' };
    }
    account.id = crypto.randomUUID();
    list.push(account);
  }
  storeSet('wmsAccounts', list);
  return { success: true, list };
});

ipcMain.handle('delete-wms-account', async (event, id) => {
  let list = storeGet('wmsAccounts', []);
  list = list.filter(a => a.id !== id);
  storeSet('wmsAccounts', list);

  // 删除 cookie 文件和 session 分区
  cookieManager.deleteCookieFile('wms', id);
  await cookieManager.clearPartition(cookieManager.getPartitionName('wms', id));

  if (activeWmsAccountId === id) {
    activeWmsAccountId = '';
    wmsLoggedIn = false;
    wmsLastRestoreResult = null;
  }

  return { success: true, list };
});

ipcMain.handle('switch-wms-account', async (event, account) => {
  if (!account || !account.id) {
    return { success: false, error: '无效的仓库端账号' };
  }

  // 销毁旧的 WMS 窗口
  if (wmsLoginWindow && !wmsLoginWindow.isDestroyed()) {
    wmsIsQuitting = true;
    wmsLoginWindow.destroy();
    wmsLoginWindow = null;
    wmsIsQuitting = false;
  }

  activeWmsAccountId = account.id;
  activeWmsWarehouseName = account.warehouseName || '';
  activeWmsWarehouseNo = account.warehouseNo || '';
  wmsLoggedIn = false;
  wmsLastRestoreResult = null;
  storeSet('lastWmsAccountId', account.id);

  // 尝试从 cookie 文件恢复
  if (cookieManager.validateCookieFile('wms', account.id)) {
    const restored = await restoreLastWmsSession({ force: true });
    return {
      success: true,
      loggedIn: restored.loggedIn,
      needLogin: !restored.loggedIn,
      restoreStatus: restored.status,
      warehouseName: restored.warehouseName || '',
      warehouseNo: restored.warehouseNo || ''
    };
  }

  return { success: true, loggedIn: false, needLogin: true };
});

ipcMain.handle('get-wms-location', async () => {
  return storeGet('wmsLocation', '');
});

ipcMain.handle('save-wms-location', async (event, loc) => {
  storeSet('wmsLocation', loc);
});

// IPC: 查询 WMS 登录状态（仅内存状态，每次启动默认未登录）
ipcMain.handle('get-wms-login-status', async () => {
  return wmsLoggedIn;
});

// WMS API 通用 HMAC 签名请求
async function wmsApiCall(apiPath, body) {
  const bodyStr = JSON.stringify(body);
  const HMAC_KEY = 'wms6';
  const HMAC_USERNAME = 'wms6';
  const LOP_DN = 'w6-stream.jdl.cn';

  const md5Content = crypto.createHash('md5').update(bodyStr).digest('hex');
  const xDate = new Date().toUTCString();
  const localNow = new Date();
  const timestamp = `${localNow.getFullYear()}-${String(localNow.getMonth() + 1).padStart(2, '0')}-${String(localNow.getDate()).padStart(2, '0')} ${String(localNow.getHours()).padStart(2, '0')}:${String(localNow.getMinutes()).padStart(2, '0')}:${String(localNow.getSeconds()).padStart(2, '0')}`;

  const authData = `X-Date: ${xDate}\nmd5-content: ${md5Content}`;
  const authSig = crypto.createHmac('sha1', HMAC_KEY).update(authData).digest('base64');
  const sigData = xDate + md5Content;
  const standaloneSig = crypto.createHmac('sha1', HMAC_KEY).update(sigData).digest('base64');

  const wmsSession = session.fromPartition(getWmsPartition());
  let token = '';
  try {
    const cookies = await wmsSession.cookies.get({ name: 'thor' });
    if (cookies.length > 0) token = cookies[0].value;
  } catch (e) {}

  if (!token) {
    throw createWmsApiError('auth', 'WMS Token 缺失，登录状态已失效');
  }

  const apiUrl = `https://api-w6.jdl.com${apiPath}`;
  let response;
  try {
    response = await wmsSession.fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Accept': 'application/json, text/plain, */*',
        'Authorization': `hmac username="${HMAC_USERNAME}", algorithm="hmac-sha1", headers="X-Date md5-content", signature="${authSig}"`,
        'X-Date': xDate,
        'md5-content': md5Content,
        'timestamp': timestamp,
        'signature': standaloneSig,
        'algorithm': 'HMacSHA1',
        'Token': token,
        'LOP-DN': LOP_DN,
        'Referer': 'https://unionwms.jdl.com/',
        'Origin': 'https://unionwms.jdl.com'
      },
      body: bodyStr
    });
  } catch (err) {
    throw createWmsApiError('network', `WMS 网络请求失败: ${err.message}`);
  }

  let text;
  try {
    text = await response.text();
  } catch (err) {
    throw createWmsApiError('network', `WMS 响应读取失败: ${err.message}`, response.status);
  }
  console.log(`WMS API [${apiPath}] [${response.status}]:`, text.substring(0, 500));
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    const kind = response.status === 401 || response.status === 403 ? 'auth' : 'service';
    throw createWmsApiError(kind, `WMS 返回了无法解析的响应 (HTTP ${response.status})`, response.status);
  }

  const classification = classifyWmsApiResponse(response.status, data, text);
  if (classification.kind === 'auth') {
    throw createWmsApiError('auth', classification.message, response.status, data);
  }
  if (response.status < 200 || response.status >= 300) {
    throw createWmsApiError('service', classification.message, response.status, data);
  }
  return data;
}

async function queryWmsOrders(warehouseNo, { allowUnverified = false } = {}) {
  try {
    if (!allowUnverified && !wmsLoggedIn) {
      return { success: false, failureType: 'not_logged_in', error: 'WMS 尚未通过服务器验证，请先恢复或重新登录', orders: [] };
    }

    const now = new Date();
    const startDate = new Date(now);
    startDate.setDate(startDate.getDate() - 30);
    const formatDate = (d, time) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day} ${time}`;
    };

    const payload = {
      conditionQueryList: [
        { column: 'inbound_status', value: ['20', '30', '40', '50', '60'], type: 'in', isJson: false },
        { column: 'create_time', value: formatDate(startDate, '00:00:00'), type: 'ge', isJson: false },
        { column: 'create_time', value: formatDate(now, '23:59:59'), type: 'le', isJson: false }
      ],
      pageNum: 1,
      pageSize: 100,
      probe_anchor_warehouseNo: warehouseNo || ''
    };

    console.log('WMS 查询入库单据:', JSON.stringify(payload).substring(0, 300));
    const data = await wmsApiCall('/receiving/orderCenter/queryInboundOrderInfo', payload);

    if (data.success === true) {
      const resultValue = data.resultValue && typeof data.resultValue === 'object'
        ? data.resultValue
        : {};
      const list = Array.isArray(resultValue.list) ? resultValue.list : [];
      const orders = list.map(item => ({
        id: item.id,
        inboundNo: item.inboundNo || '',
        uuid: item.uuid || '',
        inboundStatus: item.inboundStatus,
        inboundStatusName: item.inboundStatusName || '',
        inboundTypeName: item.inboundTypeName || '',
        supplierName: item.supplierName || '',
        ownerName: item.ownerName || '',
        expectedQty: item.expectedQty || 0,
        receivedQty: item.receivedQty || 0,
        warehouseNo: item.warehouseNo || warehouseNo || '',
        createTime: item.createTime || ''
      }));
      console.log('WMS 查询成功: ' + orders.length + ' 条入库单据');
      return { success: true, orders, total: parseInt(resultValue.total) || orders.length };
    }

    const classification = classifyWmsApiResponse(200, data);
    return {
      success: false,
      failureType: classification.kind === 'auth' ? 'auth' : 'service',
      error: getWmsResponseMessage(data, '查询失败'),
      orders: []
    };
  } catch (err) {
    console.error('WMS 查询入库单据异常:', err.message);
    return {
      success: false,
      failureType: err.wmsFailureType || 'service',
      error: err.message,
      orders: []
    };
  }
}

// IPC: 查询 WMS 入库单据
ipcMain.handle('wms-query-orders', async (event, { warehouseNo } = {}) => {
  const result = await queryWmsOrders(warehouseNo);
  if (!result.success && result.failureType === 'auth') {
    const account = getActiveWmsAccount();
    await clearInvalidWmsSessionAndOpenLogin(account);
    wmsLastRestoreResult = {
      status: 'auth_failed',
      loggedIn: false,
      loginOpened: true,
      error: result.error,
      orders: []
    };
    result.loginOpened = true;
  }
  return result;
});

// IPC: 一键验收单个入库单
ipcMain.handle('wms-accept-order', async (event, { inboundNo, warehouseNo, locationNo }) => {
  try {
    if (!wmsLoggedIn) {
      return { success: false, error: 'WMS 未登录或会话已失效' };
    }

    console.log(`WMS 验收: ${inboundNo}, 储位: ${locationNo}`);

    // Step 1: 扫描订单
    const scanResult = await wmsApiCall('/receiving/scan/scanOrder', {
      navigatorNo: inboundNo,
      receivingType: 7,
      scanCodeType: 'NAVIGATION_NUMBER',
      probe_anchor_warehouseNo: warehouseNo
    });
    if (!scanResult.success) {
      return { success: false, error: `扫描订单失败: ${scanResult.resultMessage || '未知错误'}` };
    }

    // Step 2: 分页获取全部可验收明细
    let allItems = [];
    let pageNum = 1;
    let hasMore = true;
    while (hasMore) {
      const detailResult = await wmsApiCall('/receiving/entire/order/queryCanReceivingDetail', {
        pageNum,
        pageSize: 100,
        receivingType: 7,
        navigatorNo: inboundNo,
        inboundNo: inboundNo,
        filterIdList: [],
        locationNo: '',
        probe_anchor_warehouseNo: warehouseNo
      });
      if (!detailResult.success || !detailResult.resultValue) {
        return { success: false, error: `查询明细失败(第${pageNum}页): ${detailResult.resultMessage || '未知错误'}` };
      }
      const list = detailResult.resultValue.list || [];
      allItems = allItems.concat(list);
      hasMore = detailResult.resultValue.hasNextPage;
      pageNum++;
    }

    console.log(`WMS 验收: ${inboundNo} 共 ${allItems.length} 个SKU`);
    if (allItems.length === 0) {
      console.log(`WMS 验收: ${inboundNo} 当前无可验收明细（可能正在被其他人操作），跳过`);
      return { success: true, count: 0, skipped: true };
    }

    // Step 3: 构建批量提交数据
    const submitList = allItems.map(item => ({
      navigatorNo: item.navigatorNo,
      qty: item.qty,
      detailId: item.detailId,
      sku: item.sku,
      isvSku: item.isvSku,
      skuName: item.skuName,
      skuLevel: item.skuLevel || '100',
      skuLevelName: item.skuLevelName || '良品',
      packCode: item.packCode,
      receivingType: item.receivingType || 7,
      inboundStockType: item.inboundStockType || 'ENTIRE_ORDER_RECEIVING',
      needQa: item.needQa || false,
      receivedQty: item.receivedQty || 0,
      skuExtendProperty: typeof item.skuExtendProperty === 'string'
        ? item.skuExtendProperty
        : JSON.stringify(item.skuExtendProperty || {}),
      locationNo: locationNo,
      containerLevel: '1',
      receivedRemark: '',
      locationType: '1'
    }));

    // Step 4: 分批提交验收（API 限制每批最多 100 条，同一订单内顺序提交避免锁冲突）
    const BATCH_SIZE = 100;
    let totalSuccess = 0;
    let totalFail = 0;
    const failMessages = [];

    // 将 submitList 拆分为多个批次
    const batches = [];
    for (let i = 0; i < submitList.length; i += BATCH_SIZE) {
      batches.push(submitList.slice(i, i + BATCH_SIZE));
    }
    console.log(`WMS 验收: ${inboundNo} 共 ${batches.length} 批，顺序提交`);

    // 逐批顺序提交（同一订单并发会导致 WMS "其他人正在操作中" 锁冲突）
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      console.log(`WMS 验收: ${inboundNo} 提交第 ${batchIdx + 1}/${batches.length} 批 (${batch.length} 条)`);
      try {
        const submitResult = await wmsApiCall('/receiving/entire/order/batchSubmit', {
          scanReceivingSubmitDtoList: batch,
          openLocationValidation: true,
          probe_anchor_warehouseNo: warehouseNo
        });

        if (submitResult.success) {
          if (Array.isArray(submitResult.resultValue)) {
            for (let vi = 0; vi < submitResult.resultValue.length; vi++) {
              const item = submitResult.resultValue[vi];
              if (item.state === false) {
                totalFail++;
                const failedSku = batch[vi];
                const skuInfo = failedSku ? `SKU=${failedSku.sku || failedSku.isvSku || '?'}(${failedSku.skuName || '未知'})` : `index=${vi}`;
                const msg = item.failedMessage || '未知错误';
                failMessages.push(`${skuInfo}: ${msg}`);
                console.warn(`[WMS验收] SKU失败: ${skuInfo}, 原因: ${msg}`);
              } else {
                totalSuccess++;
              }
            }
          } else {
            totalSuccess += batch.length;
          }
        } else {
          totalFail += batch.length;
          failMessages.push(submitResult.resultMessage || '批次提交失败');
        }
      } catch (err) {
        totalFail += batch.length;
        failMessages.push(err.message || '批次请求异常');
      }
    }

    console.log(`WMS 验收: ${inboundNo} 完成, 成功=${totalSuccess}, 失败=${totalFail}`);
    if (totalFail === 0) {
      return { success: true, count: allItems.length };
    } else if (totalSuccess > 0) {
      return { success: true, count: totalSuccess, failCount: totalFail, warning: failMessages.join('; ') };
    } else {
      return { success: false, error: failMessages.join('; ') };
    }
  } catch (err) {
    if (err.wmsFailureType === 'auth') {
      await clearInvalidWmsSessionAndOpenLogin(getActiveWmsAccount());
      wmsLastRestoreResult = {
        status: 'auth_failed',
        loggedIn: false,
        loginOpened: true,
        error: err.message,
        orders: []
      };
    }
    console.error('WMS 验收异常:', err.message);
    return { success: false, error: err.message };
  }
});

// ========== IPC: 异常订单处理 ==========

// 查询异常订单中心列表（真实API）
async function fetchBillExceptionList({ csrfToken, sellerNo, deptNo, deptName, billNo, sellerBillNo, exceptionStatus, soYear, soSource, page, pageSize }) {
  const iDisplayStart = ((page || 1) - 1) * (pageSize || 20);
  const iDisplayLength = pageSize || 20;

  const aoData = JSON.stringify([
    {"name":"sEcho","value":page || 1},
    {"name":"iColumns","value":17},
    {"name":"sColumns","value":",,,,,,,,,,,,,,,,"},
    {"name":"iDisplayStart","value":iDisplayStart},
    {"name":"iDisplayLength","value":iDisplayLength},
    {"name":"mDataProp_0","value":0},{"name":"bSortable_0","value":false},
    {"name":"mDataProp_1","value":"billNo"},{"name":"bSortable_1","value":false},
    {"name":"mDataProp_2","value":"sellerBillNo"},{"name":"bSortable_2","value":false},
    {"name":"mDataProp_3","value":"billTypeStr"},{"name":"bSortable_3","value":false},
    {"name":"mDataProp_4","value":"exceptionCodeStr"},{"name":"bSortable_4","value":false},
    {"name":"mDataProp_5","value":"exceptionDesc"},{"name":"bSortable_5","value":false},
    {"name":"mDataProp_6","value":"exceptionStatusStr"},{"name":"bSortable_6","value":false},
    {"name":"mDataProp_7","value":"shopName"},{"name":"bSortable_7","value":false},
    {"name":"mDataProp_8","value":"sellerName"},{"name":"bSortable_8","value":false},
    {"name":"mDataProp_9","value":"warehouseName"},{"name":"bSortable_9","value":false},
    {"name":"mDataProp_10","value":"deptName"},{"name":"bSortable_10","value":false},
    {"name":"mDataProp_11","value":"handlerGroupStr"},{"name":"bSortable_11","value":false},
    {"name":"mDataProp_12","value":"createTime"},{"name":"bSortable_12","value":false},
    {"name":"mDataProp_13","value":"updateTime"},{"name":"bSortable_13","value":false},
    {"name":"mDataProp_14","value":"partnerName"},{"name":"bSortable_14","value":false},
    {"name":"mDataProp_15","value":"businessType"},{"name":"bSortable_15","value":false},
    {"name":"mDataProp_16","value":16},{"name":"bSortable_16","value":false},
    {"name":"iSortCol_0","value":12},
    {"name":"sSortDir_0","value":"desc"},
    {"name":"iSortingCols","value":1}
  ]);

  const params = new URLSearchParams();
  params.set('csrfToken', csrfToken);
  params.set('billType', '');
  params.set('sellerNo', sellerNo);
  params.set('deptNo', deptNo || '');
  params.set('deptName', deptName || '');
  params.set('sellerBillNo', sellerBillNo || '');
  params.set('billNo', billNo || '');
  params.set('exceptionCodeStr', '');
  params.set('exceptionStatus', exceptionStatus || '1');
  params.set('createTimeBegin', '');
  params.set('soYear', soYear || String(new Date().getFullYear()));
  params.set('spCreateTime', '');
  params.set('soSource', soSource || '');
  params.set('handlerGroup', '');
  params.set('shipperNo', '');
  params.set('businessType', '');
  params.set('warehouseId', '');
  params.set('aoData', aoData);

  const url = `https://o.jdl.com/billexception/queryBillExceptionListNew.do?rand=${Math.random()}`;
  const response = await getMerchantSession().fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': 'https://o.jdl.com',
      'Referer': 'https://o.jdl.com/billexception/gotoBillExceptionPage.do'
    },
    body: params.toString()
  });

  const text = await response.text();
  return JSON.parse(text);
}

// 查询异常订单中心列表（soExceptionCentre）
async function fetchSoExceptionList({ csrfToken, soNo, spSoNo, soYear, page, pageSize }) {
  const iDisplayStart = ((page || 1) - 1) * (pageSize || 20);
  const iDisplayLength = pageSize || 20;

  const aoData = JSON.stringify([
    {"name":"sEcho","value":page || 1},
    {"name":"iColumns","value":14},
    {"name":"sColumns","value":",,,,,,,,,,,,,"},
    {"name":"iDisplayStart","value":iDisplayStart},
    {"name":"iDisplayLength","value":iDisplayLength},
    {"name":"mDataProp_0","value":"id"},{"name":"bSortable_0","value":false},
    {"name":"mDataProp_1","value":""},{"name":"bSortable_1","value":false},
    {"name":"mDataProp_2","value":"soNo"},{"name":"bSortable_2","value":true},
    {"name":"mDataProp_3","value":"spSoNo"},{"name":"bSortable_3","value":true},
    {"name":"mDataProp_4","value":"deptName"},{"name":"bSortable_4","value":true},
    {"name":"mDataProp_5","value":"shopName"},{"name":"bSortable_5","value":true},
    {"name":"mDataProp_6","value":"warehouseName"},{"name":"bSortable_6","value":true},
    {"name":"mDataProp_7","value":"errType"},{"name":"bSortable_7","value":true},
    {"name":"mDataProp_8","value":"errStatus"},{"name":"bSortable_8","value":true},
    {"name":"mDataProp_9","value":"errReason"},{"name":"bSortable_9","value":true},
    {"name":"mDataProp_10","value":"spCreateTime"},{"name":"bSortable_10","value":true},
    {"name":"mDataProp_11","value":"pauseTime"},{"name":"bSortable_11","value":true},
    {"name":"mDataProp_12","value":"soMark"},{"name":"bSortable_12","value":true},
    {"name":"mDataProp_13","value":""},{"name":"bSortable_13","value":false},
    {"name":"iSortCol_0","value":2},
    {"name":"sSortDir_0","value":"desc"},
    {"name":"iSortingCols","value":1}
  ]);

  const params = new URLSearchParams();
  params.set('csrfToken', csrfToken);
  params.set('soNo', soNo || '');
  params.set('spSoNo', spSoNo || '');
  params.set('soSource', '');
  params.set('spId', '');
  params.set('deptId', '');
  params.set('shopId', '');
  params.set('warehouseId', '');
  params.set('spCreateTime', '');
  params.set('createTime', '');
  params.set('aoData', aoData);
  params.set('pauseTime', '');
  params.set('errType', '');
  params.set('soMergeMark', '');
  params.set('soYear', soYear || String(new Date().getFullYear()));
  params.set('consigneeMobile', '');

  const url = `https://o.jdl.com/soExceptionCentre/querySoExceptionList.do?rand=${Math.random()}`;
  const response = await getMerchantSession().fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': 'https://o.jdl.com',
      'Referer': 'https://o.jdl.com/soExceptionCentre/gotoSoExceptionQuery.do'
    },
    body: params.toString()
  });

  const text = await response.text();
  return JSON.parse(text);
}

// 时间归一化：毫秒时间戳或格式化字符串 → 毫秒数
function normalizeToTimestamp(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val < 1e12 ? val * 1000 : val;
  if (/^\d{10,13}$/.test(String(val))) {
    const n = Number(val);
    return n < 1e12 ? n * 1000 : n;
  }
  const d = new Date(String(val).replace(/-/g, '/'));
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

ipcMain.handle('query-abnormal-orders', async (event, { merchantName, deptName, orderNo, shopName, year, source, page, pageSize }) => {
  try {
    const csrfToken = storeGet('csrfToken', '');
    const sellerId = storeGet('sellerId', '');
    const sellerNo = sellerId ? `CCP00${sellerId}` : '';

    if (!csrfToken || !sellerNo) {
      return { success: false, error: '未登录或登录信息已过期，请重新登录', orders: [], total: 0 };
    }

    console.log('查询异常订单:', JSON.stringify({ sellerNo, deptName, orderNo, year, source, page, pageSize }));

    // 根据订单号判断查询字段
    let billNo = '', sellerBillNo = '', soNo = '', spSoNo = '';
    if (orderNo) {
      if (orderNo.toUpperCase().startsWith('CSL') || orderNo.toUpperCase().startsWith('CDB')) {
        billNo = orderNo;
        soNo = orderNo;
      } else {
        sellerBillNo = orderNo;
        spSoNo = orderNo;
      }
    }

    const soYear = year || String(new Date().getFullYear());
    const qPage = page || 1;
    const qPageSize = pageSize || 20;

    // billexception 字段映射函数
    function mapBillExOrders(data) {
      if (!data || !data.aaData) return [];
      return data.aaData.map(item => ({
        id: item.id,
        billNo: item.billNo || '',
        sellerBillNo: item.sellerBillNo || '',
        deptName: item.deptName || '',
        shopName: item.shopName || '',
        exceptionCodeStr: item.exceptionCodeStr || '',
        exceptionDesc: item.exceptionDesc || '',
        handlerAction: item.handlerAction || '',
        createTime: item.createTime || '',
        exceptionCode: item.exceptionCode || '',
        exceptionStatus: item.exceptionStatus,
        handlerGroup: item.handlerGroup || '',
        handlerGroupStr: item.handlerGroupStr || '',
        billType: item.billType || '',
        billTypeStr: item.billTypeStr || '',
        sellerName: item.sellerName || '',
        partnerName: item.partnerName || '',
        businessType: item.businessType || '',
        updateTime: item.updateTime || '',
        warehouseName: item.warehouseName || '',
        exceptionStatusStr: item.exceptionStatusStr || '',
        _source: '异常中心'
      }));
    }

    // soExceptionCentre 字段映射函数
    function mapSoExOrders(data) {
      if (!data || !data.aaData) return [];
      return data.aaData.map(item => ({
        id: item.id,
        billNo: item.soNo || '',
        sellerBillNo: item.spSoNo || '',
        deptName: item.deptName || '',
        shopName: item.shopName || '',
        exceptionCodeStr: item.errType || '',
        exceptionDesc: item.errReason || '',
        handlerAction: '',
        createTime: item.pauseTime || '',
        exceptionCode: item.errTypeNo || '',
        exceptionStatus: item.errStatus === '异常' ? 1 : 2,
        handlerGroup: '',
        handlerGroupStr: '',
        billType: '',
        billTypeStr: '',
        sellerName: '',
        partnerName: '',
        businessType: item.businessType || '',
        updateTime: '',
        warehouseName: item.warehouseName || '',
        exceptionStatusStr: item.errStatus || '',
        _source: '异常订单中心',
        _soNo: item.soNo || '',
        _errTypeNo: item.errTypeNo || ''
      }));
    }

    let allOrders = [];
    let billExCount = 0;
    let soExCount = 0;

    if (source === 'billexception') {
      // 仅查异常中心
      const data = await fetchBillExceptionList({
        csrfToken, sellerNo, deptNo: '', deptName: deptName || '',
        billNo, sellerBillNo, exceptionStatus: '1',
        soYear, soSource: '', page: qPage, pageSize: qPageSize
      });
      if (!data || !data.aaData) {
        return { success: false, error: '异常中心接口返回数据异常', orders: [], total: 0 };
      }
      allOrders = mapBillExOrders(data);
      billExCount = data.iTotalRecords || data.iTotalDisplayRecords || allOrders.length;
      soExCount = 0;

    } else if (source === 'soExceptionCentre') {
      // 仅查异常订单中心
      const data = await fetchSoExceptionList({
        csrfToken, soNo, spSoNo, soYear, page: qPage, pageSize: qPageSize
      });
      if (!data || !data.aaData) {
        return { success: false, error: '异常订单中心接口返回数据异常', orders: [], total: 0 };
      }
      allOrders = mapSoExOrders(data);
      billExCount = 0;
      soExCount = data.iTotalRecords || data.iTotalDisplayRecords || allOrders.length;

    } else {
      // 全部：并发查两个 API
      const [billExResult, soExResult] = await Promise.allSettled([
        fetchBillExceptionList({
          csrfToken, sellerNo, deptNo: '', deptName: deptName || '',
          billNo, sellerBillNo, exceptionStatus: '1',
          soYear, soSource: '', page: qPage, pageSize: qPageSize
        }),
        fetchSoExceptionList({
          csrfToken, soNo, spSoNo, soYear, page: qPage, pageSize: qPageSize
        })
      ]);

      let billExOrders = [];
      let soExOrders = [];

      if (billExResult.status === 'fulfilled' && billExResult.value && billExResult.value.aaData) {
        billExOrders = mapBillExOrders(billExResult.value);
        billExCount = billExResult.value.iTotalRecords || billExResult.value.iTotalDisplayRecords || billExOrders.length;
      } else {
        console.error('异常中心查询失败:', billExResult.reason || '数据异常');
      }

      if (soExResult.status === 'fulfilled' && soExResult.value && soExResult.value.aaData) {
        soExOrders = mapSoExOrders(soExResult.value);
        soExCount = soExResult.value.iTotalRecords || soExResult.value.iTotalDisplayRecords || soExOrders.length;
      } else {
        console.error('异常订单中心查询失败:', soExResult.reason || '数据异常');
      }

      // 合并后按时间降序排序，截取 pageSize 条
      allOrders = [...billExOrders, ...soExOrders].sort((a, b) => {
        return normalizeToTimestamp(b.createTime) - normalizeToTimestamp(a.createTime);
      }).slice(0, qPageSize);
    }

    // 店铺名称前端过滤
    let filteredOrders = allOrders;
    if (shopName) {
      filteredOrders = allOrders.filter(o => o.shopName && o.shopName.includes(shopName));
    }

    const total = billExCount + soExCount;
    console.log(`异常订单查询完成: 异常中心${billExCount}条, 异常订单中心${soExCount}条, 合计${total}条` + (shopName ? `, 店铺过滤后${filteredOrders.length}条` : ''));

    return {
      success: true,
      orders: filteredOrders,
      total: shopName ? filteredOrders.length : total,
      billExCount,
      soExCount
    };
  } catch (err) {
    console.error('查询异常订单失败:', err.message);
    return { success: false, error: err.message, orders: [], total: 0 };
  }
});

// 处理异常订单（单条/批量）
// idAndbillTypes 格式: "{id}_{billType}_{exceptionCode}"，多条用逗号拼接
async function resumeBillException(csrfToken, idAndbillTypes) {
  const params = new URLSearchParams();
  params.set('csrfToken', csrfToken);
  params.set('idAndbillTypes', idAndbillTypes);

  const url = `https://o.jdl.com/billexception/batchResumeException.do?rand=${Math.random()}`;
  const response = await getMerchantSession().fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': 'https://o.jdl.com',
      'Referer': 'https://o.jdl.com/billexception/gotoBillExceptionPage.do'
    },
    body: params.toString()
  });

  const text = await response.text();
  return JSON.parse(text);
}

// 处理异常订单中心的订单（soExceptionCentre）
async function resumeSoException(csrfToken, soExceptionNos, errType, disposeType, resumeReason) {
  const params = new URLSearchParams();
  params.set('csrfToken', csrfToken);
  params.set('soExceptionNos', soExceptionNos);
  params.set('errType', String(errType));
  params.set('disposeType', String(disposeType || 2));
  params.set('resumeReason', resumeReason || '');

  const url = `https://o.jdl.com/soExceptionCentre/batchResumeException.do?rand=${Math.random()}`;
  const response = await getMerchantSession().fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': 'https://o.jdl.com',
      'Referer': 'https://o.jdl.com/soExceptionCentre/gotoSoExceptionQuery.do'
    },
    body: params.toString()
  });

  const text = await response.text();
  return JSON.parse(text);
}

ipcMain.handle('handle-abnormal-order', async (event, { orders }) => {
  try {
    const csrfToken = storeGet('csrfToken', '');
    if (!csrfToken) {
      return { success: false, error: '未登录或登录信息已过期' };
    }

    if (!orders || orders.length === 0) {
      return { success: false, error: '未选择需要处理的订单' };
    }

    // 按来源分组
    const billExOrders = orders.filter(o => o._source === '异常中心');
    const soExOrders = orders.filter(o => o._source === '异常订单中心');

    const results = [];

    // 处理异常中心订单
    if (billExOrders.length > 0) {
      const idAndbillTypes = billExOrders.map(o => `${o.id}_${o.billType}_${o.exceptionCode}`).join(',');
      console.log(`处理异常中心订单: ${billExOrders.length} 条, idAndbillTypes=${idAndbillTypes}`);
      try {
        const result = await resumeBillException(csrfToken, idAndbillTypes);
        if (result.success) {
          results.push({ source: '异常中心', success: true, count: billExOrders.length, msg: result.tipMsg || '操作成功' });
        } else {
          results.push({ source: '异常中心', success: false, count: billExOrders.length, msg: result.tipMsg || result.message || '处理失败' });
        }
      } catch (e) {
        results.push({ source: '异常中心', success: false, count: billExOrders.length, msg: e.message });
      }
    }

    // 处理异常订单中心订单（按 errTypeNo 分组）
    if (soExOrders.length > 0) {
      const groupByErrType = {};
      soExOrders.forEach(o => {
        const key = o._errTypeNo || 'unknown';
        if (!groupByErrType[key]) groupByErrType[key] = [];
        groupByErrType[key].push(o);
      });

      for (const [errType, group] of Object.entries(groupByErrType)) {
        const soExceptionNos = group.map(o => o._soNo).filter(Boolean).join(',');
        if (!soExceptionNos) {
          results.push({ source: '异常订单中心', success: false, count: group.length, msg: '订单编号缺失' });
          continue;
        }
        console.log(`处理异常订单中心: ${group.length} 条, errType=${errType}, soNos=${soExceptionNos}`);
        try {
          const result = await resumeSoException(csrfToken, soExceptionNos, errType, 2, '');
          if (result.success) {
            results.push({ source: '异常订单中心', success: true, count: group.length, msg: result.tipMsg || '操作成功' });
          } else {
            results.push({ source: '异常订单中心', success: false, count: group.length, msg: result.tipMsg || result.message || '处理失败' });
          }
        } catch (e) {
          results.push({ source: '异常订单中心', success: false, count: group.length, msg: e.message });
        }
      }
    }

    // 汇总结果
    const allSuccess = results.every(r => r.success);
    const totalProcessed = results.reduce((sum, r) => sum + r.count, 0);
    const successCount = results.filter(r => r.success).reduce((sum, r) => sum + r.count, 0);

    if (allSuccess) {
      const msg = results.map(r => r.msg).join('；');
      console.log(`异常订单处理成功: ${totalProcessed} 条`);
      return { success: true, message: msg || `共 ${totalProcessed} 条处理成功` };
    } else if (successCount > 0) {
      const failMsgs = results.filter(r => !r.success).map(r => `${r.source}${r.count}条失败: ${r.msg}`);
      return { success: true, message: `${successCount}条成功，${failMsgs.join('；')}` };
    } else {
      const failMsgs = results.map(r => `${r.source}: ${r.msg}`);
      return { success: false, error: failMsgs.join('；') };
    }
  } catch (err) {
    console.error('异常订单处理异常:', err.message);
    return { success: false, error: err.message };
  }
});

// ========== IPC: 订阅系统 ==========

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('check-subscription', async (event, { jdUsername, departmentId, merchantName, departmentName }) => {
  return checkSubscription(jdUsername, departmentId, merchantName, departmentName);
});

ipcMain.handle('check-department-subscription', async (event, deptNo) => {
  if (!deptNo) return { valid: false, status: 'none' };
  return callApi('POST', '/api/auth/check-dept-subscription', {
    department_id: deptNo
  });
});

ipcMain.handle('generate-qrcode', async (event, text) => {
  return QRCode.toDataURL(text, { width: 280, margin: 2 });
});

ipcMain.handle('create-payment-order', async (event, paramsJson) => {
  const { jdUsername, tier, plan, inviteCode, departmentId } = JSON.parse(paramsJson);
  return callApi('POST', '/api/payment/create-order', {
    jd_username: jdUsername,
    department_id: departmentId || '',
    tier,
    plan,
    invite_code: inviteCode || null
  });
});

ipcMain.handle('query-payment-order', async (event, orderNo) => {
  try {
    const result = await callApi('GET', `/api/payment/query-order?order_no=${orderNo}`, null);
    console.log('轮询订单状态:', orderNo, JSON.stringify(result));
    return result;
  } catch (err) {
    console.error('轮询订单异常:', orderNo, err.message);
    return { error: err.message };
  }
});

ipcMain.handle('get-subscription-info', async () => {
  return storeGet('subscriptionInfo', null);
});

// 从主界面打开订阅/续费窗口
ipcMain.handle('open-subscription', async () => {
  const subInfo = storeGet('subscriptionInfo', {});
  const jdUsername = storeGet('credentials', {}).username || '';
  createSubscriptionWindow({
    jd_username: jdUsername,
    status: subInfo.status || 'expired',
    tier: subInfo.tier || 'basic',
    invite_code: subInfo.invite_code || '',
    is_first_payment: subInfo.is_first_payment || false,
    department_id: subInfo.department_id || '',
    department_name: subInfo.department_name || ''
  });
});

ipcMain.handle('get-device-id', async () => {
  return getDeviceId();
});

// 付费成功后重新检查订阅并进入主窗口
ipcMain.handle('payment-success-enter', async () => {
  const jdUsername = storeGet('credentials', {}).username || '';
  const userData = storeGet('userData', {});
  const departmentId = userData.selectedDeptId || userData.departmentId || '';
  const merchantName = userData.merchantName || '';
  const departmentName = userData.selectedDeptName || '';

  try {
    const subResult = await checkSubscription(jdUsername, departmentId, merchantName, departmentName);
    if (subResult.status === 'active' || subResult.status === 'trial') {
      currentSessionToken = subResult.session_token;
      storeSet('subscriptionInfo', {
        status: subResult.status,
        tier: subResult.tier || 'standard',
        invite_code: subResult.invite_code,
        days_remaining: subResult.days_remaining,
        subscription_end: subResult.subscription_end,
        trial_end: subResult.trial_end,
        is_first_payment: subResult.is_first_payment,
        department_id: departmentId,
        department_name: userData.selectedDeptName || ''
      });

      if (subscriptionWindow) {
        subscriptionWindow.close();
        subscriptionWindow = null;
      }
      createMainWindow();
      startHeartbeat();
      return { success: true };
    }
    return { success: false, error: '订阅状态未更新' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 事业部选择回调
ipcMain.on('select-department', (event, dept) => {
  if (deptSelectResolve) {
    deptSelectResolve(dept);
    deptSelectResolve = null;
  }
  if (departmentSelectWindow) {
    departmentSelectWindow.close();
    departmentSelectWindow = null;
  }
});
