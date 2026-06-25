const { app, BrowserWindow, ipcMain, dialog, shell, session, net } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const AdmZip = require('adm-zip');
const excelGen = require('./src/js/excelGenerator');
let cookieManager = null;
try { cookieManager = require('./src/js/cookieManager'); } catch(e) { console.warn('[启动] cookieManager 模块缺失，热更新后将恢复'); }
let chromeShopQuery = null;
try { chromeShopQuery = require('./src/js/chrome-shop-query'); } catch(e) { console.warn('[启动] chrome-shop-query 模块缺失，店铺商品查询功能暂不可用，热更新后将恢复'); }

// 防止 stdout/stderr 管道断开时崩溃
process.stdout.on('error', (err) => { if (err.code === 'EPIPE') return; throw err; });
process.stderr.on('error', (err) => { if (err.code === 'EPIPE') return; throw err; });

// ========== 订阅系统配置 ==========
const API_BASE_URL = 'http://150.158.54.108:3000';
const APP_KEY = 'ychelper-client';
const APP_SECRET = 'ychelper_s3cret_k3y_2024_change_this'; // 需与服务端一致

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
        storeSet('subscriptionInfo', {
          ...subInfo,
          status: result.status,
          tier: result.tier || subInfo.tier || 'basic',
          days_remaining: result.days_remaining,
          subscription_end: result.subscription_end
        });
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
        nodeIntegration: true,
        contextIsolation: false
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

function loadStore() {
  try {
    if (fs.existsSync(storePath)) {
      return JSON.parse(fs.readFileSync(storePath, 'utf-8'));
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
    fs.writeFileSync(storePath, JSON.stringify(data, null, 2), 'utf-8');
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
let wmsIsLoggingIn = false;
let wmsHasSeenLoginPage = false;
let wmsLoggedIn = false; // 仅内存状态，不持久化
let wmsIsQuitting = false; // 标记应用正在退出
let isCheckingSubscription = false; // 标记正在检查订阅（防止窗口全关后退出）
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
      webviewTag: true
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
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('checking-for-update', () => {
  console.log('正在检查更新...');
});

autoUpdater.on('update-available', (info) => {
  console.log('发现新版本:', info.version);
  autoUpdaterActive = true;
  // 用热更新的进度通道显示 autoUpdater 下载状态
  sendUpdateProgress('downloading', { version: info.version, percent: 0 });
  // 60秒后如果还没下载完成，回退到服务器端检测
  setTimeout(() => {
    if (autoUpdaterActive && !fullUpdateChecked) {
      console.log('autoUpdater 下载超时，回退到服务器端检测');
      autoUpdaterActive = false;
      checkForFullUpdate();
    }
  }, 60000);
});

autoUpdater.on('update-not-available', () => {
  console.log('当前已是最新版本');
});

autoUpdater.on('download-progress', (progress) => {
  console.log(`下载进度: ${Math.round(progress.percent)}%`);
  // 用热更新的进度通道显示 autoUpdater 下载进度
  sendUpdateProgress('downloading', { percent: Math.round(progress.percent) });
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('更新下载完成:', info.version);
  fullUpdateChecked = true;
  autoUpdaterActive = false;
  // 通知渲染进程显示自定义更新弹窗
  const activeWindow = mainWindow || subscriptionWindow || loginWindow;
  if (activeWindow) {
    activeWindow.webContents.send('show-update-install', { version: info.version });
  } else {
    autoUpdater.quitAndInstall();
  }
});

autoUpdater.on('error', (err) => {
  console.log('自动更新错误:', err.message);
  // autoUpdater 失败时，重置标志并使用服务器端检测作为备选
  autoUpdaterActive = false;
  fullUpdateChecked = false;
  checkForFullUpdate();
});

// ========== 服务器端全量更新检测（不依赖GitHub） ==========
let fullUpdateChecked = false;
let autoUpdaterActive = false;

async function checkForFullUpdate() {
  if (fullUpdateChecked) return;
  if (autoUpdaterActive) return; // autoUpdater 正在下载，暂不干预
  fullUpdateChecked = true;

  try {
    const currentVersion = app.getVersion();
    const checkUrl = `${API_BASE_URL}/api/update/full-check?version=${currentVersion}`;
    const checkData = await new Promise((resolve, reject) => {
      const req = net.request(checkUrl);
      req.on('response', (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('解析响应失败')); }
        });
      });
      req.on('error', reject);
      req.end();
    });

    if (!checkData.needUpdate || !checkData.downloadUrl) {
      console.log('服务器端更新检测: 当前已是最新版本');
      return;
    }

    console.log('服务器端更新检测: 发现新版本', checkData.version);
    const activeWindow = mainWindow || subscriptionWindow || loginWindow;
    if (!activeWindow) return;

    // 静默下载安装包（不弹原生对话框）
    const downloadUrl = checkData.downloadUrl;
    const tempDir = app.getPath('temp');
    const filename = downloadUrl.split('/').pop() || `ychelper-setup-${checkData.version}.exe`;
    const savePath = path.join(tempDir, filename);

    // 通知渲染进程显示下载进度
    activeWindow.webContents.send('show-update-downloading', { version: checkData.version, changelog: checkData.changelog || '' });

    try {
      await new Promise((resolve, reject) => {
        const https = require('https');
        const http = require('http');
        const mod = downloadUrl.startsWith('https') ? https : http;

        const req = mod.get(downloadUrl, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            const redirectUrl = res.headers.location;
            const redirectMod = redirectUrl.startsWith('https') ? https : http;
            redirectMod.get(redirectUrl, downloadFile);
            return;
          }
          downloadFile(res);
        });

        function downloadFile(res) {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          const totalBytes = parseInt(res.headers['content-length'] || 0);
          let receivedBytes = 0;
          const fileStream = fs.createWriteStream(savePath);

          res.on('data', (chunk) => {
            receivedBytes += chunk.length;
            const pct = totalBytes ? Math.round(receivedBytes / totalBytes * 100) : 0;
            activeWindow.webContents.send('update-download-progress', { percent: pct });
          });

          res.pipe(fileStream);
          fileStream.on('finish', () => { fileStream.close(); resolve(); });
          fileStream.on('error', reject);
        }

        req.on('error', reject);
      });

      // 下载完成，通知渲染进程显示安装确认弹窗
      activeWindow.webContents.send('show-update-install', { version: checkData.version });

      // 记录安装包路径，供 confirm-update-install-by-path IPC 使用
      global._pendingUpdateInstaller = savePath;

    } catch (dlErr) {
      console.error('下载安装包失败:', dlErr.message);
      activeWindow.webContents.send('show-update-download-failed', { url: downloadUrl });
    }
  } catch (err) {
    console.log('服务器端更新检测失败:', err.message);
  }
}

// ========== 热更新（轻量级源文件更新） ==========

function sendUpdateProgress(stage, extra) {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.webContents.send('update-progress', { stage, ...extra });
  }
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
  const currentVersion = app.getVersion();
  console.log('热更新: 开始检查, 当前版本', currentVersion);

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
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('解析响应失败')); }
        });
      });
      req.on('error', reject);
      req.end();
    });

    if (!checkData.needUpdate) {
      console.log('热更新: 已是最新版本');
      sendUpdateProgress('none');

      // 即使没有热更新，也检查是否有全量更新（交给启动时的 checkForFullUpdate 处理，不在此弹窗）
      if (checkData.fullUpdate && checkData.fullUpdate.downloadUrl) {
        console.log('热更新检测: 发现全量更新', checkData.fullUpdate.version, '（交给启动检测处理）');
      }

      return false;
    }

    const newVersion = checkData.version;
    console.log('热更新: 发现新版本', newVersion);

    // 先显示窗口让用户看到更新进度
    if (loginWindow && !loginWindow.isDestroyed() && !loginWindow.isVisible()) {
      loginWindow.show();
    }
    sendUpdateProgress('downloading', { version: newVersion, percent: 0 });

    // 下载更新包
    const downloadUrl = `${API_BASE_URL}/api/update/download`;
    const tempDir = path.join(app.getPath('temp'), 'ychelper-update');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const zipPath = path.join(tempDir, `update-${newVersion}.zip`);

    await new Promise((resolve, reject) => {
      const req = net.request(downloadUrl);
      req.on('response', (response) => {
        const totalSize = parseInt(response.headers['content-length'] || '0', 10);
        let receivedSize = 0;
        const chunks = [];

        response.on('data', (chunk) => {
          chunks.push(chunk);
          receivedSize += chunk.length;
          if (totalSize > 0) {
            const percent = Math.round((receivedSize / totalSize) * 100);
            sendUpdateProgress('downloading', { version: newVersion, percent });
          }
        });

        response.on('end', () => {
          try {
            const buffer = Buffer.concat(chunks);
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
    sendUpdateProgress('installing');

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
    zip.extractAllTo(stagingDir, true);

    // 安全检查：阻止热更新覆盖主进程字节码文件
    const protectedFiles = ['main.js', 'main.jsc', 'preload.js', 'preload.jsc'];
    const zipEntries = zip.getEntries();
    for (const entry of zipEntries) {
      const entryName = path.basename(entry.entryName);
      if (protectedFiles.includes(entryName)) {
        console.warn(`热更新: ZIP 包含受保护文件 ${entry.entryName}，跳过此文件`);
        const targetPath = path.join(stagingDir, entry.entryName);
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
      }
    }

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

    // 验证更新是否生效：读取复制后的 package.json 确认版本号
    try {
      const copiedPkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf-8'));
      console.log('热更新: 验证复制后版本号:', copiedPkg.version);
      if (copiedPkg.version !== newVersion) {
        console.error(`热更新: 版本验证失败！期望 ${newVersion}，实际 ${copiedPkg.version}`);
        sendUpdateProgress('error');
        return false;
      }
    } catch (verifyErr) {
      console.error('热更新: 版本验证读取失败:', verifyErr.message);
    }

    // 清理临时文件
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      console.log('热更新: 清理临时文件失败（不影响使用）:', e.message);
    }

    console.log('热更新: 安装完成, 版本已更新到', newVersion);
    sendUpdateProgress('done');

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
  // 初始化 cookie 存储目录
  cookieManager.ensureCookieDir();

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

  // 等待登录页加载完成后，先检查热更新再显示窗口
  loginWindow.webContents.on('did-finish-load', async () => {
    try {
      const updated = await checkForHotUpdate();
      if (updated) {
        // 有更新，显示窗口让用户看到进度条
        if (loginWindow && !loginWindow.isDestroyed()) loginWindow.show();
        return;
      }
    } catch (e) {
      console.log('热更新检查异常:', e.message);
    }

    // 无更新，显示登录窗口
    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.show();

    // 延迟检查更新：autoUpdater + 服务器端检测双重保障
    setTimeout(() => {
      // 1. autoUpdater（GitHub 源）
      autoUpdater.checkForUpdatesAndNotify().catch(err => {
        console.log('GitHub更新检查失败:', err.message);
      });
      // 2. 3秒后如果 autoUpdater 未成功，用服务器端检测兜底
      setTimeout(() => {
        checkForFullUpdate();
      }, 3000);
    }, 5000);
  });
});

app.on('before-quit', () => {
  wmsIsQuitting = true;
  stopHeartbeat();
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
  app.quit();
});

// 渲染进程确认安装更新（autoUpdater）
ipcMain.on('confirm-update-install', () => {
  autoUpdater.quitAndInstall();
});

// 渲染进程确认安装更新（服务器下载的安装包）
ipcMain.on('confirm-update-install-by-path', () => {
  if (global._pendingUpdateInstaller) {
    shell.openPath(global._pendingUpdateInstaller);
    app.quit();
  }
});

// 渲染进程点击浏览器下载
ipcMain.on('open-external-download', (event, url) => {
  shell.openExternal(url);
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
          height: data.height
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
  let list = storeGet('shopAccounts', []);
  if (account.id) {
    // 编辑：更新现有
    const idx = list.findIndex(a => a.id === account.id);
    if (idx >= 0) {
      list[idx] = { ...list[idx], name: account.name, username: account.username, password: account.password, autoSend: !!account.autoSend };
    }
  } else {
    // 新增
    if (list.length >= 20) {
      return { success: false, error: '最多保存20个店铺账号' };
    }
    account.id = crypto.randomUUID();
    account.autoSend = !!account.autoSend;
    list.push(account);
  }
  storeSet('shopAccounts', list);
  return { success: true, list };
});

ipcMain.handle('delete-shop-account', async (event, id) => {
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
let shopSessionValidating = false;
let activeShopAccountId = ''; // 当前活跃的店铺账号ID
let shopPageWindow = null;           // 店铺后台浏览窗口
let shopCaptureActive = false;       // 店铺抓包状态
let shopCapturedCalls = new Map();   // 店铺抓包捕获的请求
let shopQueryInProgress = false;     // 自动查询任务锁

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

// 校验持久化的店铺session是否仍有效
async function validateShopSession() {
  if (shopLoggedIn) return { loggedIn: true, shopName: shopLoginName };
  if (shopSessionValidating) return { loggedIn: false, shopName: '', validating: true };

  // 如果没有活跃账号，无法校验
  if (!activeShopAccountId) {
    return { loggedIn: false, shopName: '' };
  }

  // 快速检查：cookie 文件是否有效
  if (!cookieManager.validateCookieFile('shop', activeShopAccountId)) {
    return { loggedIn: false, shopName: '' };
  }

  const shopPartition = getShopPartition();

  // 尝试从文件导入 cookie 到分区
  const shopSession = session.fromPartition(shopPartition);
  const cookies = await shopSession.cookies.get({ domain: 'jd.com' });
  if (cookies.length === 0) {
    // 分区无 cookie，尝试从文件恢复
    const imported = await cookieManager.importCookies(shopSession, 'shop', activeShopAccountId);
    if (!imported) {
      return { loggedIn: false, shopName: '' };
    }
  }

  shopSessionValidating = true;

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 1100, height: 750,
      show: false,
      webPreferences: {
        partition: shopPartition,
        nodeIntegration: false,
        contextIsolation: true
      }
    });
    win.setMenuBarVisibility(false);

    let resolved = false;
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      shopSessionValidating = false;
      resolve(result);
    };

    const timer = setTimeout(() => {
      win.destroy();
      finish({ loggedIn: false, shopName: '' });
    }, 15000);

    win.webContents.on('did-navigate', async (event, url) => {
      if (resolved) return;

      if (url.includes('passport') || url.includes('login')) {
        // session已失效，需要重新登录
        win.destroy();
        finish({ loggedIn: false, shopName: '' });
      } else if (url.includes('shop.jd.com')) {
        // session仍有效
        shopLoggedIn = true;
        shopLoginName = storeGet('lastShopName', '');

        // 验证完毕，销毁验证窗口（后续API调用由getOrCreateShopApiWindow按需创建）
        win.destroy();

        // 验证成功后重新导出 cookie（刷新文件）
        const ses = session.fromPartition(shopPartition);
        await cookieManager.exportCookies(ses, 'shop', activeShopAccountId);

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('shop-login-success', { shopName: shopLoginName });
        }

        finish({ loggedIn: true, shopName: shopLoginName });
      }
    });

    win.loadURL('https://shop.jd.com');
  });
}

async function createShopLoginWindow() {
  if (shopLoginWindow && !shopLoginWindow.isDestroyed()) {
    shopLoginWindow.destroy();
    shopLoginWindow = null;
  }

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

  shopLoginWindow.loadURL('https://shop.jd.com');

  // 自动填充凭据
  shopLoginWindow.webContents.on('did-finish-load', async () => {
    if (!shopLoginWindow || shopLoginWindow.isDestroyed()) return;
    const currentUrl = shopLoginWindow.webContents.getURL();
    // 仅在登录页面填充
    if (currentUrl.includes('passport') || currentUrl.includes('login')) {
      if (pendingShopCredentials && pendingShopCredentials.username) {
        const { username, password } = pendingShopCredentials;
        try {
          await shopLoginWindow.webContents.executeJavaScript(`
            (function() {
              var nameInput = document.getElementById('loginname') || document.querySelector('input[name="loginname"]') || document.querySelector('input[name="nloginname"]');
              var pwdInput = document.getElementById('nloginpwd') || document.querySelector('input[name="nloginpwd"]');
              if (nameInput) {
                var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeInputValueSetter.call(nameInput, ${JSON.stringify(username)});
                nameInput.dispatchEvent(new Event('input', { bubbles: true }));
                nameInput.dispatchEvent(new Event('change', { bubbles: true }));
              }
              if (pwdInput) {
                var nativeInputValueSetter2 = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeInputValueSetter2.call(pwdInput, ${JSON.stringify(password)});
                pwdInput.dispatchEvent(new Event('input', { bubbles: true }));
                pwdInput.dispatchEvent(new Event('change', { bubbles: true }));
              }
            })();
          `);
          console.log('店铺登录: 已自动填充凭据');
        } catch (e) {
          console.log('店铺登录: 自动填充失败:', e.message);
        }
      }
    }
  });

  // 登录成功检测
  shopLoginWindow.webContents.on('did-navigate', async (event, url) => {
    if (!shopLoginWindow || shopLoginWindow.isDestroyed()) return;
    console.log('店铺登录: 导航到', url);
    // 登录成功后URL会跳转到 shop.jd.com 的管理页面（非 passport/login）
    if (url.includes('shop.jd.com') && !url.includes('passport') && !url.includes('login')) {
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

        // 关闭登录窗口（cookies已持久化在分区和文件中）
        if (shopLoginWindow && !shopLoginWindow.isDestroyed()) {
          shopLoginWindow.destroy();
          shopLoginWindow = null;
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

  shopLoginWindow.on('closed', () => {
    shopLoginWindow = null;
  });
}

ipcMain.handle('open-shop-login', async (event, cred) => {
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

// 批量检查所有店铺账号的 cookie 有效性
ipcMain.handle('check-shop-accounts-status', async () => {
  const accounts = storeGet('shopAccounts', []);
  const statusMap = {};
  for (const account of accounts) {
    statusMap[account.id] = cookieManager.validateCookieFile('shop', account.id);
  }
  // 当前活跃且已登录的店铺一定在线
  if (activeShopAccountId && shopLoggedIn) {
    statusMap[activeShopAccountId] = true;
  }
  return { statusMap, activeAccountId: activeShopAccountId };
});

// 切换店铺账号（尝试从 cookie 文件恢复，免登录）
ipcMain.handle('switch-shop-account', async (event, account) => {
  if (!account || !account.id) {
    return { success: false, error: '无效的店铺账号' };
  }

  // 先销毁旧的 shop 窗口
  if (shopLoginWindow && !shopLoginWindow.isDestroyed()) {
    shopLoginWindow.destroy();
    shopLoginWindow = null;
  }

  // 切换活跃账号
  activeShopAccountId = account.id;
  shopLoggedIn = false;
  shopLoginName = '';
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
        return { success: true, loggedIn: true, shopName: result.shopName };
      }
    }
  }

  // cookie 无效或验证失败，需要重新登录
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
  const offscreen = options.offscreen === true;   // 离屏模式：窗口实际创建并 show，但在屏幕外
  const forceNew = options.forceNew === true;      // 强制重建窗口（清除旧上下文）

  // 强制重建：销毁旧窗口
  if (forceNew && shopPageWindow && !shopPageWindow.isDestroyed()) {
    console.log('[店铺] 强制重建窗口，销毁旧实例');
    shopPageWindow.destroy();
    shopPageWindow = null;
  }

  if (shopPageWindow && !shopPageWindow.isDestroyed()) {
    return shopPageWindow;
  }

  const shopPartition = getShopPartition();

  // 离屏模式：清除旧的指纹缓存数据（保留 cookie 登录态）
  if (offscreen) {
    try {
      const ses = session.fromPartition(shopPartition);
      await ses.clearStorageData({
        storages: ['localstorage', 'indexdb', 'websql', 'cachestorage', 'serviceworkers']
      });
      console.log('[店铺] 已清除指纹缓存数据（保留cookie）');
    } catch (e) {
      console.warn('[店铺] 清除缓存失败:', e.message);
    }
  }

  shopPageWindow = new BrowserWindow({
    width: 1300, height: 850,
    // 离屏模式：实际 show 窗口但放在屏幕外，避免 Chromium 对隐藏窗口的 JS 节流
    // 隐藏窗口会导致 requestAnimationFrame 限制为1fps、Timer节流、visibilityState='hidden'
    show: offscreen ? true : shouldShow,
    ...(offscreen ? { x: -20000, y: -20000, skipTaskbar: true } : {}),
    title: '店铺后台 - ' + (shopLoginName || ''),
    webPreferences: {
      partition: shopPartition,
      nodeIntegration: false,
      contextIsolation: false,
      preload: path.join(__dirname, 'src', 'js', 'shop-preload.js')
    }
  });

  // 覆盖 User-Agent，去除 Electron 和应用名标识
  const defaultUA = shopPageWindow.webContents.getUserAgent();
  const cleanUA = defaultUA
    .replace(/\s*Electron\/[\d.]+/g, '')
    .replace(/\s*cloud-warehouse-assistant\/[\d.]+/g, '')
    .replace(/\s*ychelper\/[\d.]+/g, '');
  shopPageWindow.webContents.setUserAgent(cleanUA);

  // 清理 Sec-CH-UA 系列 HTTP 请求头（去除 Electron 品牌标识）
  const shopSession = shopPageWindow.webContents.session;
  shopSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = Object.assign({}, details.requestHeaders);
    // Sec-CH-UA 和 Sec-CH-UA-Full-Version-List 中包含 "Electron";v="xx" 品牌
    const chHeaders = ['Sec-CH-UA', 'sec-ch-ua', 'Sec-CH-UA-Full-Version-List', 'sec-ch-ua-full-version-list'];
    for (const h of chHeaders) {
      if (headers[h]) {
        // 移除 "Electron";v="xx" 和 "cloud-warehouse-assistant";v="xx" 等品牌
        headers[h] = headers[h]
          .replace(/,?\s*"Electron";\s*v="[^"]*"/gi, '')
          .replace(/,?\s*"cloud-warehouse-assistant";\s*v="[^"]*"/gi, '')
          .replace(/,?\s*"ychelper";\s*v="[^"]*"/gi, '')
          .replace(/^,\s*/, ''); // 清理开头可能残留的逗号
      }
    }
    callback({ requestHeaders: headers });
  });

  console.log('[店铺] 窗口已创建 (UA+Client Hints已清理)');

  // 注意：不拦截 gia.jd.com 等风控脚本 —— h5st SDK 需要其指纹数据生成签名
  // 拦截会导致 h5st token 缺少指纹 → 服务端检测到异常 → 返回"未经授权"错误

  // 导航到店铺首页（由用户自行导航到具体页面）
  shopPageWindow.loadURL('https://shop.jd.com/');

  shopPageWindow.on('closed', () => {
    if (shopCaptureActive) {
      shopCaptureActive = false;
      shopCapturedCalls.clear();
    }
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
 * 从抓包数据中提取商品列表
 * 查找 queryValidProductList 和 querySkuList 响应，组合解析
 */
function parseGoodsFromCaptures(capturedEntries) {
  // 找最后一个 queryValidProductList 响应
  let productListBody = null;
  for (let i = capturedEntries.length - 1; i >= 0; i--) {
    const entry = capturedEntries[i];
    if (entry.url && entry.url.includes('queryValidProductList') && entry.responseBody) {
      productListBody = entry.responseBody;
      break;
    }
  }

  if (!productListBody) return null;

  // 收集所有 querySkuList 响应，构建 skuMap
  const skuMap = new Map();
  for (const entry of capturedEntries) {
    if (entry.url && entry.url.includes('querySkuList') && entry.responseBody) {
      try {
        const skuJson = JSON.parse(entry.responseBody);
        if (skuJson.code === 200 && skuJson.data) {
          const skuItems = skuJson.data.data || skuJson.data;
          if (Array.isArray(skuItems)) {
            for (const sku of skuItems) {
              const pid = String(sku.productId || sku.product_id || sku.spuId || '');
              if (pid) {
                if (!skuMap.has(pid)) skuMap.set(pid, []);
                skuMap.get(pid).push(sku);
              }
            }
          }
        }
      } catch(e) {}
    }
  }

  console.log(`[店铺商品] 抓包数据中找到 queryValidProductList, SKU展开数据: ${skuMap.size} 个商品`);
  return parseProductListResponse(productListBody, skuMap);
}

/**
 * CDP 响应捕获：等待 queryValidProductList 的网络响应
 * @param {BrowserWindow} win
 * @param {number} timeoutMs
 * @returns {Promise<{body: string, totalCount: number} | null>}
 */
function captureProductListResponse(win, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const pending = new Map();
    let done = false;

    const handler = (event, method, p) => {
      if (done) return;

      if (method === 'Network.requestWillBeSent') {
        if ((p.type === 'XHR' || p.type === 'Fetch') &&
            p.request && p.request.url && p.request.url.includes('queryValidProductList')) {
          pending.set(p.requestId, true);
          console.log(`[店铺商品] CDP 捕获到 queryValidProductList 请求 id=${p.requestId}`);
        }
      }

      if (method === 'Network.loadingFinished' && pending.has(p.requestId)) {
        win.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: p.requestId })
          .then(({ body, base64Encoded }) => {
            if (done) return;
            done = true;
            cleanup();
            const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf-8') : body;
            let totalCount = 0;
            try {
              const j = JSON.parse(text);
              totalCount = (j.data && j.data.totalCount) || 0;
            } catch(e) {}
            console.log(`[店铺商品] CDP 获取响应体 ${text.length} 字符, totalCount=${totalCount}`);
            console.log(`[店铺商品] 响应内容: ${text.substring(0, 500)}`);
            resolve({ body: text, totalCount });
          })
          .catch((err) => {
            console.warn(`[店铺商品] CDP 获取响应体失败:`, err.message);
          });
      }

      if (method === 'Network.loadingFailed' && pending.has(p.requestId)) {
        console.warn(`[店铺商品] CDP 请求加载失败: ${p.errorText || '未知错误'}`);
        done = true;
        cleanup();
        resolve(null);
      }
    };

    function cleanup() {
      win.webContents.debugger.removeListener('message', handler);
      clearTimeout(timer);
    }

    win.webContents.debugger.on('message', handler);
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        cleanup();
        console.warn('[店铺商品] CDP 响应捕获超时');
        resolve(null);
      }
    }, timeoutMs);
  });
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

/**
 * 通过 XHR 拦截器 + CDP 响应捕获自动查询店铺商品
 * preload 脚本中的拦截器在 h5st 签名之前修改请求体
 * CDP Debugger 捕获签名后的完整响应
 */
async function queryShopGoodsDirect(params) {
  if (shopQueryInProgress) {
    return { success: false, error: '已有查询任务在进行中，请等待完成' };
  }
  shopQueryInProgress = true;
  let win = null;

  try {
    // === Chrome 优先模式：使用真实 Chrome 浏览器绕过 h5st 指纹检测 ===
    const chromePath = chromeShopQuery ? chromeShopQuery.findChromeExecutable() : null;
    if (chromePath) {
      console.log('[店铺商品] 检测到 Chrome，使用外部浏览器模式:', chromePath);
      try {
        // 从 Electron shop session 获取当前 cookies
        const shopSes = session.fromPartition(getShopPartition());
        let shopCookies = await shopSes.cookies.get({});
        if (shopCookies.length === 0 && activeShopAccountId) {
          console.warn('[店铺商品] shop session 无 cookie，尝试从文件恢复');
          await cookieManager.importCookies(shopSes, 'shop', activeShopAccountId);
          shopCookies = await shopSes.cookies.get({});
        }
        if (shopCookies.length === 0) {
          console.warn('[店铺商品] 无可用 cookie，回退到 Electron 模式');
        } else {
          const result = await chromeShopQuery.queryShopGoodsWithChrome(
            params, shopCookies, parseProductListResponse
          );
          shopQueryInProgress = false;
          return result;
        }
      } catch (chromeErr) {
        console.error('[店铺商品] Chrome 模式失败，回退 Electron:', chromeErr.message);
        // fall through 到原有 Electron 逻辑
      }
    } else {
      console.log('[店铺商品] 未检测到 Chrome，使用内置浏览器模式');
    }

    // === 原有 Electron 模式（回退） ===

    // 1. 参数映射
    const statusMap = { '在售': '4', '下架': '5', '待售': '2' };
    const queryParams = {
      pageNum: 1,
      pageSize: 100,
      productState: statusMap[params.goodsStatus] || '4',
      dateFrom: params.dateFrom || '',
      dateTo: params.dateTo || ''
    };
    console.log('[店铺商品] 开始自动查询, params:', JSON.stringify(queryParams));

    // 2. 获取/创建窗口（离屏模式：实际渲染但不可见，避免 Chromium 节流）
    // forceNew: 每次查询重建窗口 + 清除指纹缓存，确保 h5st 生成全新指纹
    win = await ensureShopPageWindow({ offscreen: true, forceNew: true });
    if (!win || win.isDestroyed()) {
      return { success: false, error: '店铺后台窗口无法创建' };
    }

    // 3. 等待 shop.jd.com 首页完全加载（指纹脚本在此页初始化）
    console.log('[店铺商品] 等待首页加载完成...');
    await new Promise((resolve) => {
      const onLoad = () => { clearTimeout(t); resolve(); };
      win.webContents.once('did-finish-load', onLoad);
      const t = setTimeout(() => {
        win.webContents.removeListener('did-finish-load', onLoad);
        console.log('[店铺商品] 首页加载超时，继续');
        resolve();
      }, 15000);
    });

    // 额外等待：让 JD 指纹采集脚本（gia/jdtdm/h5st）充分执行
    console.log('[店铺商品] 等待指纹脚本初始化 (3s)...');
    await new Promise(r => setTimeout(r, 3000));

    // 检测登录过期（首页可能跳转到登录页）
    if (await detectLoginExpired(win)) {
      shopLoggedIn = false;
      return { success: false, error: '店铺登录已过期，请重新登录店铺后台' };
    }

    // 4. 附加 CDP Debugger
    try { win.webContents.debugger.attach('1.3'); } catch(e) { /* 可能已附加 */ }
    await win.webContents.debugger.sendCommand('Network.enable');

    // 5. 商品列表查询：注册 dom-ready 参数注入 + CDP 捕获 + 导航
    const captureP = captureProductListResponse(win, 30000);
    const injectP = injectQueryParams(win, queryParams);

    const targetUrl = 'https://wares-jdm.jd.com/ware/wareList?activeTab=OnsaleWare&businessModel=0';
    console.log('[店铺商品] 导航到商品列表页');
    win.loadURL(targetUrl);

    // 等待参数注入完成
    await injectP;

    // 6. 等待页面加载完成
    await new Promise((r) => {
      if (!win.webContents.isLoading()) return r();
      const onFinish = () => { clearTimeout(t); r(); };
      win.webContents.once('did-finish-load', onFinish);
      const t = setTimeout(() => {
        win.webContents.removeListener('did-finish-load', onFinish);
        r();
      }, 20000);
    });

    // 检测登录过期
    if (await detectLoginExpired(win)) {
      shopLoggedIn = false;
      return { success: false, error: '店铺登录已过期，请重新登录店铺后台' };
    }

    // 7. 等待商品列表 API 响应
    const firstResp = await captureP;
    if (!firstResp) {
      return { success: false, error: '获取商品列表超时，页面可能未正常加载或被京东安全拦截' };
    }

    // 检测 code:601 (反自动化检测) 和 code:312 (h5st 签名失败)
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
    } catch(e) {}

    // 8. 解析首页
    let parsed = parseProductListResponse(firstResp.body, new Map());
    if (!parsed.success) {
      return { success: false, error: parsed.error || '商品列表解析失败' };
    }

    const allGoods = [...parsed.goods];
    const totalCount = firstResp.totalCount || allGoods.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / queryParams.pageSize));
    console.log(`[店铺商品] 第1/${totalPages}页, 本页${parsed.goods.length}条, 总计${totalCount}条`);

    // 9. 分页处理
    for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
      queryParams.pageNum = pageNum;

      // 页间延迟，降低风控概率
      await new Promise(r => setTimeout(r, 800 + Math.random() * 700));

      // 检查窗口是否被用户关闭
      if (!win || win.isDestroyed()) {
        console.warn('[店铺商品] 窗口已关闭，终止分页');
        break;
      }

      const pgCapture = captureProductListResponse(win, 30000);
      const pgInject = injectQueryParams(win, queryParams);
      win.webContents.reload();
      await pgInject;

      // 等待页面加载
      await new Promise((r) => {
        if (!win.webContents.isLoading()) return r();
        const onFinish = () => { clearTimeout(t); r(); };
        win.webContents.once('did-finish-load', onFinish);
        const t = setTimeout(() => {
          win.webContents.removeListener('did-finish-load', onFinish);
          r();
        }, 20000);
      });

      if (await detectLoginExpired(win)) {
        shopLoggedIn = false;
        console.warn('[店铺商品] 分页过程中登录过期');
        break;
      }

      const pgResp = await pgCapture;
      if (!pgResp) {
        console.warn(`[店铺商品] 第${pageNum}页响应超时，终止分页`);
        break;
      }

      parsed = parseProductListResponse(pgResp.body, new Map());
      if (!parsed.success) {
        console.warn(`[店铺商品] 第${pageNum}页解析失败: ${parsed.error}`);
        break;
      }

      allGoods.push(...parsed.goods);
      console.log(`[店铺商品] 第${pageNum}/${totalPages}页, 本页${parsed.goods.length}条, 累计${allGoods.length}条`);
    }

    // 10. 客户端价格过滤
    let result = allGoods;
    const pMin = params.priceMin ? parseFloat(params.priceMin) : 0;
    const pMax = params.priceMax ? parseFloat(params.priceMax) : Infinity;
    if (pMin > 0 || pMax < Infinity) {
      result = allGoods.filter(g => g.price == null || (g.price >= pMin && g.price <= pMax));
    }

    const msg = totalPages > 1
      ? `共${totalPages}页, API返回${totalCount}条, 获取${allGoods.length}条`
      : undefined;

    console.log(`[店铺商品] 查询完成: ${result.length}条商品`);
    return { success: true, goods: result, total: result.length, message: msg };

  } catch (err) {
    console.error('[店铺商品] 查询异常:', err.message);
    return { success: false, error: err.message };

  } finally {
    shopQueryInProgress = false;
    // 重置页面参数
    try {
      if (win && !win.isDestroyed()) {
        await win.webContents.executeJavaScript('window.__ychelper_query_params__ = null;');
      }
    } catch(e) {}
  }
}

ipcMain.handle('shop-query-goods', async (event, params) => {
  console.log('[店铺商品] shop-query-goods 被调用, shopLoggedIn:', shopLoggedIn, 'params:', JSON.stringify(params));
  if (!shopLoggedIn) {
    return { success: false, error: '店铺未登录，请先登录店铺后台' };
  }

  try {
    return await queryShopGoodsDirect(params);
  } catch (err) {
    console.error('[店铺商品] 查询异常:', err.message);
    return { success: false, error: err.message };
  }
});

// ========== 店铺后台抓包工具 ==========

function handleShopDebuggerMessage(event, method, params) {
  if (!shopCaptureActive || !shopPageWindow || shopPageWindow.isDestroyed()) return;

  if (method === 'Network.requestWillBeSent') {
    const { requestId, request, type } = params;
    if (type === 'XHR' || type === 'Fetch') {
      shopCapturedCalls.set(requestId, {
        url: request.url,
        method: request.method,
        postData: request.postData || '',
        headers: request.headers || {},
        timestamp: new Date().toLocaleTimeString()
      });
      console.log(`[店铺抓包] >>> ${request.method} ${request.url.substring(0, 150)}`);
      if (request.postData) {
        console.log(`[店铺抓包]     Body: ${request.postData.substring(0, 1500)}`);
      }
    }
  }

  if (method === 'Network.loadingFinished') {
    const { requestId } = params;
    const entry = shopCapturedCalls.get(requestId);
    if (entry && shopPageWindow && !shopPageWindow.isDestroyed()) {
      shopPageWindow.webContents.debugger.sendCommand('Network.getResponseBody', { requestId })
        .then(({ body }) => {
          entry.responseBody = body;
          try {
            const json = JSON.parse(body);
            entry.responseParsed = true;
            const preview = JSON.stringify(json, null, 2);
            console.log(`[店铺抓包] <<< ${entry.url.substring(0, 150)}`);
            console.log(`[店铺抓包]     响应(${body.length}字符): ${preview.substring(0, 3000)}`);
          } catch(e) {
            console.log(`[店铺抓包] <<< ${entry.url.substring(0, 150)} (非JSON, ${body.length}字符)`);
          }
        })
        .catch(() => {
          console.log(`[店铺抓包] <<< ${entry.url.substring(0, 150)} (无法获取响应体)`);
        });
    }
  }
}

// 打开店铺后台页面
ipcMain.handle('open-shop-page', async () => {
  if (!shopLoggedIn) {
    return { success: false, error: '店铺未登录，请先登录店铺后台' };
  }

  try {
    const win = await ensureShopPageWindow();
    // 可能是从离屏模式（自动查询）创建的窗口，需要移回屏幕内
    const bounds = win.getBounds();
    if (bounds.x < -10000 || bounds.y < -10000) {
      win.setPosition(100, 100);
    }
    win.show();
    win.focus();
    console.log('[店铺] 已打开店铺后台窗口');
    return { success: true };
  } catch (e) {
    console.error('[店铺] 打开失败:', e.message);
    return { success: false, error: e.message };
  }
});

// 开始店铺抓包
ipcMain.handle('start-shop-capture', async () => {
  if (!shopPageWindow || shopPageWindow.isDestroyed()) {
    return { success: false, error: '请先打开店铺后台' };
  }

  try {
    try { shopPageWindow.webContents.debugger.attach('1.3'); } catch(e) { /* 已附加 */ }
    await shopPageWindow.webContents.debugger.sendCommand('Network.enable');

    shopCapturedCalls.clear();
    shopCaptureActive = true;

    shopPageWindow.webContents.debugger.removeListener('message', handleShopDebuggerMessage);
    shopPageWindow.webContents.debugger.on('message', handleShopDebuggerMessage);

    shopPageWindow.show();
    shopPageWindow.focus();

    console.log('\n==================================================');
    console.log('[店铺抓包] 抓包已启动');
    console.log('[店铺抓包] 请在店铺后台导航到商品列表页面，执行操作后点击停止');
    console.log('==================================================\n');

    return { success: true };
  } catch (e) {
    console.error('[店铺抓包] 启动失败:', e.message);
    return { success: false, error: e.message };
  }
});

// 停止店铺抓包
ipcMain.handle('stop-shop-capture', async () => {
  shopCaptureActive = false;

  if (shopPageWindow && !shopPageWindow.isDestroyed()) {
    try {
      shopPageWindow.webContents.debugger.removeListener('message', handleShopDebuggerMessage);
      shopPageWindow.webContents.debugger.detach();
    } catch(e) {}
  }

  await new Promise(r => setTimeout(r, 500));

  const results = [];
  for (const [id, entry] of shopCapturedCalls) {
    results.push({
      url: entry.url,
      method: entry.method,
      postData: entry.postData,
      responseBody: entry.responseBody || '',
      timestamp: entry.timestamp
    });
  }

  console.log('\n==================================================');
  console.log(`[店铺抓包] 抓包已停止，共捕获 ${results.length} 个请求`);
  console.log('==================================================');

  shopCapturedCalls.clear();
  return { success: true, count: results.length, requests: results };
});

// 导出 SKU TXT 文件
ipcMain.handle('export-sku-txt', async (event, { skus, shopName }) => {
  try {
    const appDir = app.isPackaged ? app.getPath('documents') : __dirname;
    const outputDir = path.join(appDir, '云仓助手输出');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const now = new Date();
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const fileName = `SKU_${shopName || '店铺'}_${dateStr}.txt`;
    const filePath = path.join(outputDir, fileName);
    fs.writeFileSync(filePath, skus.join('\n'), 'utf-8');
    return { success: true, filePath, fileName };
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

// 获取当前 WMS 的 session 分区名
function getWmsPartition() {
  if (activeWmsAccountId) {
    return cookieManager.getPartitionName('wms', activeWmsAccountId);
  }
  return 'persist:wms'; // 兼容旧版
}

async function createWmsLoginWindow() {
  if (wmsLoginWindow) {
    wmsLoginWindow.show();
    wmsLoginWindow.focus();
    return;
  }

  // 确定当前 WMS 分区（基于 pendingWmsCredentials 的 ID）
  const accountId = pendingWmsCredentials ? pendingWmsCredentials.id || '' : '';
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
      nodeIntegration: false,
      webSecurity: false
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

  wmsIsLoggingIn = false;
  wmsHasSeenLoginPage = false;
  let wmsAutoFillCount = 0; // 自动填充计数器，防止无限循环
  const WMS_MAX_AUTO_FILL = 2; // 最多自动填充2次
  wmsLoginWindow.loadURL('https://unionwms.jdl.com');

  // 监听 WMS 页面的所有 POST 请求，捕获实际 API 调用的完整 headers
  const wmsSession = session.fromPartition(wmsPartition);
  let capturedWmsHeaders = null;
  wmsSession.webRequest.onBeforeSendHeaders({ urls: ['*://api-w6.jdl.com/*'] }, (details, callback) => {
    if (details.method === 'POST') {
      console.log('WMS 网络请求:', details.method, details.url.substring(0, 120));
      // 捕获 queryInboundOrderInfo 的完整请求头
      if (details.url.includes('queryInboundOrderInfo')) {
        capturedWmsHeaders = { ...details.requestHeaders };
        console.log('WMS 捕获请求头:', JSON.stringify(capturedWmsHeaders));
      }
    }
    callback({ cancel: false, requestHeaders: details.requestHeaders });
  });

  // 监听页面跳转，仅记录是否经过了登录页
  wmsLoginWindow.webContents.on('did-navigate', (event, url) => {
    if (url.includes('passport') || url.includes('login') || url.includes('sso')) {
      wmsHasSeenLoginPage = true;
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

    // 如果已经过登录页且当前在 WMS 主页，说明登录成功（仓库选择页，不注入按钮）
    if (wmsHasSeenLoginPage && !wmsLoggedIn && currentUrl.includes('unionwms.jdl.com')) {
      console.log('WMS: 登录成功，等待用户选择仓库...');
      wmsLoggedIn = true;
    }

    // 已登录且页面导航（用户选完仓库进入主页后），注入按钮+引导
    else if (wmsLoggedIn && !wmsLoginWindow.isDestroyed() && currentUrl.includes('unionwms.jdl.com')) {
      setTimeout(() => {
        if (!wmsLoginWindow || wmsLoginWindow.isDestroyed()) return;
        wmsLoginWindow.webContents.executeJavaScript(`
          (function() {
            if (document.getElementById('ychelper-wms-confirm-btn')) return;
            // 注入引导动画样式
            if (!document.getElementById('ychelper-guide-style')) {
              var style = document.createElement('style');
              style.id = 'ychelper-guide-style';
              style.textContent = '@keyframes ychelper-pulse{0%{box-shadow:0 4px 12px rgba(24,144,255,0.4)}50%{box-shadow:0 4px 24px rgba(24,144,255,0.8),0 0 0 10px rgba(24,144,255,0.12)}100%{box-shadow:0 4px 12px rgba(24,144,255,0.4)}}@keyframes ychelper-bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}@keyframes ychelper-fadein{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}';
              document.head.appendChild(style);
            }
            var btn = document.createElement('div');
            btn.id = 'ychelper-wms-confirm-btn';
            btn.innerHTML = '<span style="font-size:15px;">\\u2714 \\u6211\\u5df2\\u8fdb\\u5165\\u4ed3\\u5e93</span>';
            btn.style.cssText = 'position:fixed;bottom:30px;right:30px;z-index:999999;'
              + 'background:linear-gradient(135deg,#1890ff,#096dd9);color:#fff;'
              + 'padding:12px 28px;border-radius:8px;cursor:pointer;'
              + 'box-shadow:0 4px 12px rgba(24,144,255,0.4);font-family:sans-serif;'
              + 'transition:transform 0.2s;user-select:none;'
              + 'animation:ychelper-pulse 2s infinite;';
            btn.onmouseenter = function() {
              btn.style.transform = 'scale(1.05)';
            };
            btn.onmouseleave = function() {
              btn.style.transform = 'scale(1)';
            };
            btn.onclick = function() {
              btn.innerHTML = '<span style="font-size:15px;">\\u6b63\\u5728\\u83b7\\u53d6\\u4ed3\\u5e93\\u4fe1\\u606f...</span>';
              btn.style.pointerEvents = 'none';
              btn.style.opacity = '0.7';
              btn.style.animation = 'none';
              var g = document.getElementById('ychelper-wms-guide');
              if (g) g.remove();
              document.title = '__YCHELPER_WMS_CONFIRM__';
            };
            document.body.appendChild(btn);
            // 引导提示气泡
            if (!document.getElementById('ychelper-wms-guide')) {
              var guide = document.createElement('div');
              guide.id = 'ychelper-wms-guide';
              guide.style.cssText = 'position:fixed;bottom:85px;right:18px;z-index:999999;'
                + 'background:#fff;color:#333;padding:12px 18px;border-radius:10px;'
                + 'box-shadow:0 4px 16px rgba(0,0,0,0.15);font-size:14px;font-family:sans-serif;'
                + 'animation:ychelper-bounce 1.8s infinite,ychelper-fadein 0.5s;'
                + 'white-space:nowrap;line-height:1.5;border:1px solid #e8e8e8;';
              guide.innerHTML = '\\u2193 \\u8bf7\\u70b9\\u51fb\\u4e0b\\u65b9\\u84dd\\u8272\\u6309\\u94ae\\u786e\\u8ba4\\u8fdb\\u5165\\u4ed3\\u5e93';
              var arrow = document.createElement('div');
              arrow.style.cssText = 'position:absolute;bottom:-8px;right:50px;width:0;height:0;'
                + 'border-left:8px solid transparent;border-right:8px solid transparent;'
                + 'border-top:8px solid #fff;filter:drop-shadow(0 2px 2px rgba(0,0,0,0.08));';
              guide.appendChild(arrow);
              document.body.appendChild(guide);
            }
          })()
        `).catch(() => {});
      }, 1500);
    }
  });

  // 监听按钮点击（通过 document.title 变化检测）
  wmsLoginWindow.on('page-title-updated', async (event, title) => {
    if (title !== '__YCHELPER_WMS_CONFIRM__') return;
    event.preventDefault(); // 不更新窗口标题栏
    console.log('WMS: 用户确认已进入仓库，提取信息...');

    try {
      const warehouseName = await wmsLoginWindow.webContents.executeJavaScript(`
        (function() {
          var el = document.querySelector('.warehouse-name')
            || document.querySelector('.header-warehouse')
            || document.querySelector('[class*="warehouse"] span')
            || document.querySelector('[class*="Warehouse"] span');
          if (el) return el.textContent.trim();
          try {
            var stored = localStorage.getItem('warehouseName') || localStorage.getItem('warehouse_name');
            if (stored) return stored;
          } catch(e) {}
          var all = document.querySelectorAll('span, div, a');
          for (var i = 0; i < all.length; i++) {
            var t = all[i].textContent.trim();
            if (t && t.includes('仓') && t.length < 30 && t.length > 2 && !t.includes('入库') && !t.includes('仓库管理')) {
              return t;
            }
          }
          return '';
        })()
      `);
      console.log('WMS 仓库名称:', warehouseName);

      // 登录成功后导出 cookie 到文件
      if (activeWmsAccountId) {
        const ses = session.fromPartition(getWmsPartition());
        await cookieManager.exportCookies(ses, 'wms', activeWmsAccountId);
        storeSet('lastWmsAccountId', activeWmsAccountId);

      }

      if (mainWindow) {
        mainWindow.webContents.send('wms-login-success', { warehouseName: warehouseName || '' });
      }
    } catch (err) {
      console.log('WMS 获取仓库名称失败:', err.message);
      if (mainWindow) {
        mainWindow.webContents.send('wms-login-success', { warehouseName: '' });
      }
    }
    // 隐藏窗口
    wmsLoginWindow.hide();
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

  // 检查 WMS 分区是否有有效 cookie
  const ses = session.fromPartition(wmsPartition);
  const existingCookies = await ses.cookies.get({});
  if (existingCookies.length === 0) {
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
  const wmsPartition = getWmsPartition();
  const ses = session.fromPartition(wmsPartition);
  const existingCookies = await ses.cookies.get({});
  return { loggedIn: existingCookies.length > 0, wmsLoggedIn, partition: wmsPartition };
});

ipcMain.handle('get-wms-credentials', async () => {
  return storeGet('wmsCredentials', null);
});

ipcMain.handle('save-wms-credentials', async (event, cred) => {
  storeSet('wmsCredentials', cred);
  // 同步维护 wmsAccounts 列表，最近登录排最前，最多10个
  let accounts = storeGet('wmsAccounts', []);
  const existIdx = accounts.findIndex(a => a.username === cred.username);
  if (existIdx >= 0) {
    // 已存在：更新密码，移到最前
    accounts[existIdx].password = cred.password;
    accounts[existIdx].lastLogin = Date.now();
    const updated = accounts.splice(existIdx, 1)[0];
    accounts.unshift(updated);
  } else {
    // 新账号：创建新条目
    accounts.unshift({
      id: require('crypto').randomUUID(),
      username: cred.username,
      password: cred.password,
      lastLogin: Date.now()
    });
  }
  if (accounts.length > 10) accounts = accounts.slice(0, 10);
  storeSet('wmsAccounts', accounts);
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
      list[idx] = { ...list[idx], username: account.username, password: account.password, warehouseName: account.warehouseName || list[idx].warehouseName };
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
  wmsLoggedIn = false;
  storeSet('lastWmsAccountId', account.id);

  // 尝试从 cookie 文件恢复
  if (cookieManager.validateCookieFile('wms', account.id)) {
    const ses = session.fromPartition(getWmsPartition());
    const imported = await cookieManager.importCookies(ses, 'wms', account.id);
    if (imported) {
      wmsLoggedIn = true;
      return { success: true, loggedIn: true };
    }
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

  const apiUrl = `https://api-w6.jdl.com${apiPath}`;
  const response = await wmsSession.fetch(apiUrl, {
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

  const text = await response.text();
  console.log(`WMS API [${apiPath}] [${response.status}]:`, text.substring(0, 500));
  return JSON.parse(text);
}

// IPC: 查询 WMS 入库单据
ipcMain.handle('wms-query-orders', async (event, { warehouseNo }) => {
  try {
    if (!wmsLoginWindow || wmsLoginWindow.isDestroyed()) {
      return { success: false, error: 'WMS 未登录或会话已失效，请重新登录', orders: [] };
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

    if (data.success && data.resultValue) {
      const list = data.resultValue.list || [];
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
        warehouseNo: item.warehouseNo || '',
        createTime: item.createTime || ''
      }));
      console.log('WMS 查询成功: ' + orders.length + ' 条入库单据');
      return { success: true, orders, total: parseInt(data.resultValue.total) || orders.length };
    }

    return { success: false, error: data.resultMessage || data.error_response?.zh_desc || '查询失败', orders: [] };
  } catch (err) {
    console.error('WMS 查询入库单据异常:', err.message);
    return { success: false, error: err.message, orders: [] };
  }
});

// IPC: 一键验收单个入库单
ipcMain.handle('wms-accept-order', async (event, { inboundNo, warehouseNo, locationNo }) => {
  try {
    if (!wmsLoginWindow || wmsLoginWindow.isDestroyed()) {
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

// ========== 网络抓包工具（用于发现异常订单API） ==========

let networkCaptureActive = false;
let capturedApiCalls = new Map();
let captureTargetWindow = null;

function handleDebuggerMessage(event, method, params) {
  if (!networkCaptureActive || !captureTargetWindow || captureTargetWindow.isDestroyed()) return;

  if (method === 'Network.requestWillBeSent') {
    const { requestId, request, type } = params;
    // 只捕获 XHR/Fetch 类型的 .do 接口请求
    if ((type === 'XHR' || type === 'Fetch') && request.url.includes('.do')) {
      capturedApiCalls.set(requestId, {
        url: request.url,
        method: request.method,
        postData: request.postData || '',
        timestamp: new Date().toLocaleTimeString()
      });
      console.log(`\n[抓包] >>> ${request.method} ${request.url}`);
      if (request.postData) {
        console.log(`[抓包]     Body: ${request.postData.substring(0, 1500)}`);
      }
    }
  }

  if (method === 'Network.loadingFinished') {
    const { requestId } = params;
    const entry = capturedApiCalls.get(requestId);
    if (entry && captureTargetWindow && !captureTargetWindow.isDestroyed()) {
      captureTargetWindow.webContents.debugger.sendCommand('Network.getResponseBody', { requestId })
        .then(({ body }) => {
          entry.responseBody = body;
          try {
            const json = JSON.parse(body);
            entry.responseParsed = true;
            console.log(`[抓包] <<< ${entry.url}`);
            const preview = JSON.stringify(json, null, 2);
            console.log(`[抓包]     响应(${body.length}字符): ${preview.substring(0, 3000)}`);
            if (preview.length > 3000) console.log(`[抓包]     ... 已截断，完整内容请查看停止抓包后的汇总`);
          } catch(e) {
            console.log(`[抓包] <<< ${entry.url} (非JSON, ${body.length}字符)`);
          }
        })
        .catch(() => {
          console.log(`[抓包] <<< ${entry.url} (无法获取响应体)`);
        });
    }
  }
}

ipcMain.handle('start-network-capture', async () => {
  const win = jdPageWindow;
  if (!win || win.isDestroyed()) {
    return { success: false, error: '请先登录京东物流后台' };
  }

  try {
    // 附加调试器（忽略已附加的情况）
    try { win.webContents.debugger.attach('1.3'); } catch(e) { /* 已附加 */ }

    await win.webContents.debugger.sendCommand('Network.enable');

    capturedApiCalls.clear();
    networkCaptureActive = true;
    captureTargetWindow = win;

    // 移除旧监听再添加新的
    win.webContents.debugger.removeListener('message', handleDebuggerMessage);
    win.webContents.debugger.on('message', handleDebuggerMessage);

    // 显示JD后台窗口
    win.show();
    win.focus();

    console.log('\n==================================================');
    console.log('[抓包] 网络抓包已启动');
    console.log('[抓包] 请在JD后台页面导航到异常订单/异常订单中心页面');
    console.log('[抓包] 执行查询操作后，点击"停止抓包"查看结果');
    console.log('==================================================\n');

    return { success: true };
  } catch (e) {
    console.error('[抓包] 启动失败:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('stop-network-capture', async () => {
  networkCaptureActive = false;

  if (captureTargetWindow && !captureTargetWindow.isDestroyed()) {
    try {
      captureTargetWindow.webContents.debugger.removeListener('message', handleDebuggerMessage);
      captureTargetWindow.webContents.debugger.detach();
    } catch(e) {}
  }
  captureTargetWindow = null;

  // 等待一下让最后的响应完成
  await new Promise(r => setTimeout(r, 500));

  const results = [];
  for (const [id, entry] of capturedApiCalls) {
    results.push({
      url: entry.url,
      method: entry.method,
      postData: entry.postData,
      responseBody: entry.responseBody || '',
      timestamp: entry.timestamp
    });
  }

  // 在控制台输出完整汇总
  console.log('\n==================================================');
  console.log(`[抓包] 抓包已停止，共捕获 ${results.length} 个API请求`);
  console.log('==================================================');
  results.forEach((r, i) => {
    console.log(`\n────── 请求 ${i + 1} ──────`);
    console.log(`时间: ${r.timestamp}`);
    console.log(`URL:  ${r.url}`);
    console.log(`方法: ${r.method}`);
    if (r.postData) console.log(`参数: ${r.postData}`);
    if (r.responseBody) {
      try {
        const json = JSON.parse(r.responseBody);
        console.log(`响应: ${JSON.stringify(json, null, 2).substring(0, 5000)}`);
      } catch(e) {
        console.log(`响应: ${r.responseBody.substring(0, 5000)}`);
      }
    }
  });
  console.log('\n==================================================\n');

  capturedApiCalls.clear();
  return { success: true, count: results.length, requests: results };
});

// ========== IPC: 订阅系统 ==========

ipcMain.handle('get-app-version', () => app.getVersion());

// 查询功能开关
ipcMain.handle('get-feature-flags', async () => {
  try {
    const result = await callApi('GET', '/api/feature-flags');
    return result;
  } catch (e) {
    return {};
  }
});

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
