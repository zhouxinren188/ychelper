const { app, BrowserWindow, ipcMain, dialog, shell, session, net } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const excelGen = require('./src/js/excelGenerator');

// 防止 stdout/stderr 管道断开时崩溃
process.stdout.on('error', (err) => { if (err.code === 'EPIPE') return; throw err; });
process.stderr.on('error', (err) => { if (err.code === 'EPIPE') return; throw err; });

// 简易本地存储（JSON 文件）
const storePath = path.join(app.getPath('userData'), 'config.json');

function loadStore() {
  try {
    if (fs.existsSync(storePath)) {
      return JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return {};
}

function saveStore(data) {
  fs.writeFileSync(storePath, JSON.stringify(data, null, 2), 'utf-8');
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

let loginWindow = null;
let webLoginWindow = null;
let mainWindow = null;
let isLoggingIn = false; // 防止重复处理登录
let wmsLoginWindow = null;
let wmsIsLoggingIn = false;
let wmsHasSeenLoginPage = false;
let wmsLoggedIn = false; // 仅内存状态，不持久化
let wmsIsQuitting = false; // 标记应用正在退出
let pendingCredentials = null; // 待自动填充的凭据（商家端）
let pendingWmsCredentials = null; // 待自动填充的凭据（WMS端）

function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 400,
    height: 400,
    resizable: false,
    frame: false,
    center: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  loginWindow.loadFile(path.join(__dirname, 'src', 'login.html'));

  loginWindow.on('closed', () => {
    loginWindow = null;
    if (!mainWindow && !webLoginWindow) {
      app.quit();
    }
  });
}

function createWebLoginWindow() {
  webLoginWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    center: true,
    title: '京东物流 - 登录',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  isLoggingIn = false;
  webLoginWindow.loadURL('https://o.jdl.com');

  // 监听页面跳转，检测登录状态
  webLoginWindow.webContents.on('did-navigate', async (event, url) => {
    await checkLoginStatus(url);
  });
  webLoginWindow.webContents.on('did-navigate-in-page', async (event, url) => {
    await checkLoginStatus(url);
  });

  // 页面加载完成后自动填充账号密码
  webLoginWindow.webContents.on('did-finish-load', async () => {
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
    webLoginWindow = null;
    if (!mainWindow && !loginWindow) {
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
    await new Promise(resolve => setTimeout(resolve, 2000));

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

      // 解析店铺数据
      let shopList = [];
      if (apiData.shopData) {
        shopList = apiData.shopData.aaData || apiData.shopData.data || (Array.isArray(apiData.shopData) ? apiData.shopData : []);
        if (Array.isArray(shopList) && shopList.length > 0) {
          userData.shops = shopList.map(s => ({
            shopId: s.shopNo || s.shopId || s.id || '',
            spShopNo: s.spShopNo || '',
            shopName: s.shopName || s.name || ''
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
        }
      }

      // 解析供应商数据
      if (apiData.supplierData) {
        const supplierList = apiData.supplierData.aaData || apiData.supplierData.data || [];
        if (Array.isArray(supplierList)) {
          userData.suppliers = supplierList.map(s => ({
            supplierId: s.supplierNo || '',
            supplierName: s.supplierName || ''
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
        shopCount: userData.shops.length,
        supplierCount: userData.suppliers.length,
        warehouseCount: userData.warehouses.length,
        sellerId: apiData.sellerId || '(未获取)'
      }));
    } else {
      console.error('API数据获取失败:', apiData?.error || '未知错误');
    }

    storeSet('userData', userData);

    // 关闭登录相关窗口，打开主窗口
    if (webLoginWindow) {
      webLoginWindow.close();
      webLoginWindow = null;
    }
    if (loginWindow) {
      loginWindow.close();
      loginWindow = null;
    }
    createMainWindow();
  } catch (err) {
    console.error('登录处理失败:', err);
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
            params.set('iDisplayLength', '1000');
            params.set('aoData', '0,1000');

            const shopResp = await fetch('https://o.jdl.com/shop/queryShopList.do', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: params.toString()
            });
            shopData = await shopResp.json();
          } catch (e) {
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
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
    // 主窗口关闭时销毁隐藏的 WMS 窗口
    wmsIsQuitting = true;
    if (wmsLoginWindow && !wmsLoginWindow.isDestroyed()) {
      wmsLoginWindow.destroy();
      wmsLoginWindow = null;
    }
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
  if (mainWindow) {
    mainWindow.webContents.send('update-status', { status: 'downloading', version: info.version });
  }
});

autoUpdater.on('update-not-available', () => {
  console.log('当前已是最新版本');
});

autoUpdater.on('download-progress', (progress) => {
  console.log(`下载进度: ${Math.round(progress.percent)}%`);
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('更新下载完成:', info.version);
  if (mainWindow) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '更新提示',
      message: `新版本 ${info.version} 已下载完成，重启应用后生效。`,
      buttons: ['立即重启', '稍后重启']
    }).then(result => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  }
});

autoUpdater.on('error', (err) => {
  console.log('自动更新错误:', err.message);
});

app.whenReady().then(() => {
  // 清除旧的持久化 wmsLoggedIn（已改为内存管理）
  const store = loadStore();
  if (store.wmsLoggedIn !== undefined) {
    delete store.wmsLoggedIn;
    saveStore(store);
  }
  createLoginWindow();

  // 启动后 10 秒检查更新（避免影响启动速度）
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(err => {
      console.log('检查更新失败:', err.message);
    });
  }, 10000);
});

app.on('before-quit', () => {
  wmsIsQuitting = true;
});

app.on('window-all-closed', () => {
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

// ========== IPC: 登录 ==========

ipcMain.handle('open-web-login', async (event, cred) => {
  pendingCredentials = cred || null;
  createWebLoginWindow();
});

ipcMain.handle('get-credentials', async () => {
  return storeGet('credentials', null);
});

ipcMain.handle('save-credentials', async (event, cred) => {
  storeSet('credentials', cred);
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

ipcMain.handle('get-modes', async () => {
  return storeGet('modes', []);
});

ipcMain.handle('save-mode', async (event, mode) => {
  const modes = storeGet('modes', []);
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
  const modes = storeGet('modes', []);
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

  const content = fs.readFileSync(result.filePaths[0], 'utf-8');
  return content;
});

// ========== IPC: Excel 生成 ==========

// 初始化输出目录（使用桌面下的"云仓助手输出"文件夹）
app.whenReady().then(() => {
  const outputDir = path.join(app.getPath('desktop'), '云仓助手输出');
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
  const outputDir = path.join(app.getPath('desktop'), '云仓助手输出');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  shell.openPath(outputDir);
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

  const response = await session.defaultSession.fetch(fullUrl, {
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

          const response = await session.defaultSession.fetch(url, {
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

    const response = await session.defaultSession.fetch('https://o.jdl.com/goodsStockConfig/batchSaveSetting.do', {
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
    const csrfToken = storeGet('csrfToken', '');
    const url = action === 'on'
      ? 'https://o.jdl.com/shopGoods/batchOnShopGoods.do'
      : 'https://o.jdl.com/shopGoods/checkBatchOffShopGoods.do';
    const label = action === 'on' ? '启用' : '停用';

    const params = new URLSearchParams();
    params.set('csrfToken', csrfToken);
    params.set('ids', JSON.stringify(ids));

    console.log(`批量${label}店铺商品: ${ids.length}个, ids=${JSON.stringify(ids).substring(0, 200)}`);

    const response = await session.defaultSession.fetch(url, {
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
    console.log(`批量${label}店铺商品响应:`, text.substring(0, 500));

    try {
      const data = JSON.parse(text);
      return { success: response.ok, data };
    } catch (e) {
      return { success: response.ok, data: text };
    }
  } catch (err) {
    console.error('批量启用/停用店铺商品异常:', err.message);
    return { success: false, error: err.message };
  }
});

// ========== 批量启用/停用商品主数据 ==========
ipcMain.handle('batch-toggle-master-data', async (event, { ids, action }) => {
  try {
    const csrfToken = storeGet('csrfToken', '');
    const url = action === 'on'
      ? 'https://o.jdl.com/goods/batchOnGoods.do'
      : 'https://o.jdl.com/goods/checkBatchOffGoods.do';
    const label = action === 'on' ? '启用' : '停用';

    const params = new URLSearchParams();
    params.set('csrfToken', csrfToken);
    params.set('ids', JSON.stringify(ids));

    console.log(`批量${label}商品主数据: ${ids.length}个, ids=${JSON.stringify(ids).substring(0, 200)}`);

    const response = await session.defaultSession.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': 'https://o.jdl.com',
        'Referer': 'https://o.jdl.com/goods/goodsList.do'
      },
      body: params.toString()
    });

    const text = await response.text();
    console.log(`批量${label}商品主数据响应:`, text.substring(0, 500));

    try {
      const data = JSON.parse(text);
      return { success: response.ok, data };
    } catch (e) {
      return { success: response.ok, data: text };
    }
  } catch (err) {
    console.error('批量启用/停用商品主数据异常:', err.message);
    return { success: false, error: err.message };
  }
});

// ========== WMS 仓库端 - 验收上架 ==========

function createWmsLoginWindow() {
  if (wmsLoginWindow) {
    wmsLoginWindow.show();
    wmsLoginWindow.focus();
    return;
  }

  wmsLoginWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    center: true,
    show: false,
    title: 'WMS 仓库管理',
    webPreferences: {
      partition: 'persist:wms',
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
  wmsLoginWindow.loadURL('https://unionwms.jdl.com');

  // 监听 WMS 页面的所有 POST 请求，捕获实际 API 调用的完整 headers
  const wmsSession = session.fromPartition('persist:wms');
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

    // 如果在登录页，尝试自动填充
    if (currentUrl.includes('passport') || currentUrl.includes('login')) {
      if (!pendingWmsCredentials || !pendingWmsCredentials.username) return;
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

    // 如果已经过登录页且当前在 WMS 主页，说明登录成功，自动提取仓库名后关闭窗口
    if (wmsHasSeenLoginPage && !wmsLoggedIn && currentUrl.includes('unionwms.jdl.com')) {
      console.log('WMS: 检测到已进入仓库主页，自动提取信息并关闭窗口');
      wmsLoggedIn = true;

      // 等待页面渲染完成后提取仓库名称
      setTimeout(async () => {
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
          if (mainWindow) {
            mainWindow.webContents.send('wms-login-success', { warehouseName: warehouseName || '' });
          }
        } catch (err) {
          console.log('WMS 获取仓库名称失败:', err.message);
          if (mainWindow) {
            mainWindow.webContents.send('wms-login-success', { warehouseName: '' });
          }
        }
        // 自动隐藏 WMS 窗口
        wmsLoginWindow.hide();
      }, 2000);
    }
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

ipcMain.handle('get-wms-credentials', async () => {
  return storeGet('wmsCredentials', null);
});

ipcMain.handle('save-wms-credentials', async (event, cred) => {
  storeSet('wmsCredentials', cred);
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

  const wmsSession = session.fromPartition('persist:wms');
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
        { column: 'inbound_status', value: ['20', '30', '40'], type: 'in', isJson: false },
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
      if (!detailResult.success || !detailResult.resultValue || !detailResult.resultValue.list) {
        return { success: false, error: `查询明细失败(第${pageNum}页): ${detailResult.resultMessage || '未知错误'}` };
      }
      allItems = allItems.concat(detailResult.resultValue.list);
      hasMore = detailResult.resultValue.hasNextPage;
      pageNum++;
    }

    console.log(`WMS 验收: ${inboundNo} 共 ${allItems.length} 个SKU`);
    if (allItems.length === 0) {
      return { success: false, error: '该订单没有可验收的明细' };
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

    // Step 4: 分批提交验收（API 限制每批最多 100 条）
    const BATCH_SIZE = 100;
    let totalSuccess = 0;
    let totalFail = 0;
    const failMessages = [];

    for (let i = 0; i < submitList.length; i += BATCH_SIZE) {
      const batch = submitList.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(submitList.length / BATCH_SIZE);
      console.log(`WMS 验收: ${inboundNo} 提交第 ${batchNum}/${totalBatches} 批 (${batch.length} 条)`);

      const submitResult = await wmsApiCall('/receiving/entire/order/batchSubmit', {
        scanReceivingSubmitDtoList: batch,
        openLocationValidation: true,
        probe_anchor_warehouseNo: warehouseNo
      });

      if (submitResult.success) {
        // 检查每个明细的提交结果
        if (Array.isArray(submitResult.resultValue)) {
          for (const item of submitResult.resultValue) {
            if (item.state === false) {
              totalFail++;
              failMessages.push(item.failedMessage || '未知错误');
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
    }

    console.log(`WMS 验收: ${inboundNo} 完成, 成功=${totalSuccess}, 失败=${totalFail}`);
    if (totalFail === 0) {
      return { success: true, count: allItems.length };
    } else if (totalSuccess > 0) {
      return { success: true, count: totalSuccess, failCount: totalFail, warning: failMessages.slice(0, 3).join('; ') };
    } else {
      return { success: false, error: failMessages.slice(0, 3).join('; ') };
    }
  } catch (err) {
    console.error('WMS 验收异常:', err.message);
    return { success: false, error: err.message };
  }
});
