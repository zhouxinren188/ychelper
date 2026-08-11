const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const asar = require('@electron/asar');
const { JSDOM } = require('jsdom');
const { buildHotUpdateLogin } = require('../scripts/hot-update-login');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const loginHtml = fs.readFileSync(path.join(root, 'src', 'login.html'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src', 'js', 'renderer.js'), 'utf8');
const cookieManager = fs.readFileSync(path.join(root, 'src', 'js', 'cookieManager.js'), 'utf8');
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

assert.match(loginHtml, /const rememberPassword = rememberCheck\.checked/,
  '登录页必须读取“记住密码”选项');
assert.match(loginHtml, /await window\.electronAPI\.saveCredentials\([\s\S]*await window\.electronAPI\.openWebLogin/,
  '登录页必须先完成凭据保存，再打开登录窗口');
assert.match(loginHtml, /if \(!username\)[\s\S]*if \(!password\)/,
  '登录页必须校验账号和密码');
assert.match(loginHtml, /id="loginVersion">当前版本<\/div>/,
  '登录与更新界面必须提供当前版本号位置');
assert.match(loginHtml, /callElectronApi\('getAppVersion',[\s\S]{0,300}当前版本 v/,
  '登录页必须隔离异常并显示当前软件版本号');
assert.match(loginHtml, /callElectronApi\('getCredentials',[\s\S]{0,260}usernameInput\.value/,
  '版本接口失败不得阻断已保存账号和密码的恢复');
assert.doesNotMatch(loginHtml, /\b(?:const|let|class)\s+electronAPI\b/,
  '登录页不得声明与 contextBridge 注入对象 electronAPI 同名的全局词法变量');
assert.doesNotMatch(loginHtml, /body\.update-mode \.login-app-version/,
  '进入更新模式后不得隐藏当前软件版本号');

assert.match(main, /系统安全存储不可用，已拒绝以明文保存账号和配置/,
  '配置存储不得在安全存储不可用时降级为明文');
assert.match(main, /if \(storeReadBlocked\) return false;/,
  '配置无法解密时必须阻止覆盖原文件');
assert.match(main, /data\.csrfToken = profile\.csrfToken \|\| '';/,
  '切换商家账号时必须覆盖或清空 CSRF Token');
assert.match(main, /data\.sellerId = profile\.sellerId \|\| '';/,
  '切换商家账号时必须覆盖或清空 sellerId');
assert.match(main, /const identityVerified = !!\(/,
  '商家端进入后台后必须执行身份接口验证');
assert.match(main, /webLoginWindow = new BrowserWindow\(\{[\s\S]{0,220}show: false/,
  '商家端窗口必须默认隐藏，避免工作台页面闪现');
assert.match(main, /did-start-navigation[\s\S]{0,500}webLoginWindow\.hide\(\)/,
  '从登录页进入工作台时必须在导航开始阶段隐藏窗口');
assert.match(main, /if \(isMerchantLoginPageUrl\(url\)\)[\s\S]{0,260}webLoginWindow\.show\(\)/,
  '只有商家登录页才应主动显示窗口');
assert.match(main, /requiresInteractiveVerification[\s\S]{0,900}webLoginWindow\.show\(\)/,
  '检测到滑块或安全验证时必须重新显示商家端窗口');
assert.doesNotMatch(main, /cookieImported: true[\s\S]{0,120}loggedIn: true/,
  '仅导入商家 Cookie 不得直接标记为已登录');

assert.doesNotMatch(preload, /returnToMerchantLogin|return-to-merchant-login/,
  'preload 不应继续暴露已删除的切换事业部接口');
assert.doesNotMatch(indexHtml, /merchantSwitchBtn|切换事业部/,
  '主界面不应继续显示切换事业部按钮');
assert.doesNotMatch(renderer, /returnToMerchantLogin|merchantSwitchBtn/,
  '渲染进程不应保留切换事业部按钮逻辑');
assert.doesNotMatch(main, /ipcMain\.handle\('return-to-merchant-login'/,
  '主进程不应保留无调用方的切换事业部 IPC');

assert.match(main, /data\.lastShopAccountId = activeShopAccountId/,
  '店铺登录成功后必须保存最后活跃店铺 ID');
assert.match(main, /status: 'warehouse_missing'/,
  'WMS 恢复缺少仓库信息时不得标记已登录');
assert.match(main, /const timeoutId = setTimeout\(\(\) => controller\.abort\(\), 15000\)/,
  'WMS API 验证必须设置主动超时');
assert.match(cookieManager, /Cookie 加密不可用，已拒绝明文保存/,
  'Cookie 不得降级为明文保存');

async function verifyHotLoginRuntime() {
  const hotVersion = `${packageVersion}.1`;
  const hotLogin = buildHotUpdateLogin({ rootDir: root, version: hotVersion });
  assert.strictEqual(hotLogin.buffer.length, hotLogin.baselineSize,
    '热更新登录页必须与完整基线 ASAR 记录长度完全一致');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ychelper-hot-login-'));
  const resourcesDir = path.join(tempRoot, 'resources');
  const tempAsar = path.join(resourcesDir, 'app.asar');
  const tempLogin = path.join(resourcesDir, 'app.asar.unpacked', 'src', 'login.html');
  fs.mkdirSync(path.dirname(tempLogin), { recursive: true });
  fs.copyFileSync(path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar'), tempAsar);
  fs.writeFileSync(tempLogin, hotLogin.buffer);
  const loginReadThroughAsar = asar.extractFile(tempAsar, 'src\\login.html');
  assert.strictEqual(loginReadThroughAsar.length, hotLogin.baselineSize,
    '通过当前完整版本 ASAR 头读取热更新登录页时不得发生截断');

  const electronAPI = new Proxy({
    getAppVersion: () => Promise.reject(new Error('模拟版本接口异常')),
    getCredentials: () => Promise.resolve({
      username: 'remembered-user',
      password: 'remembered-password',
      rememberPassword: true
    }),
    getCredentialList: () => Promise.resolve([])
  }, {
    get(target, property) {
      return property in target ? target[property] : () => {};
    }
  });
  try {
    const dom = new JSDOM(loginReadThroughAsar.toString('utf8'), {
      runScripts: 'dangerously',
      beforeParse(window) {
        Object.defineProperty(window, 'electronAPI', {
          value: electronAPI,
          configurable: false,
          writable: false
        });
      }
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(dom.window.document.getElementById('loginVersion').textContent, `当前版本 v${hotVersion}`);
    assert.strictEqual(dom.window.document.getElementById('username').value, 'remembered-user');
    assert.strictEqual(dom.window.document.getElementById('password').value, 'remembered-password');
    assert.strictEqual(dom.window.document.getElementById('rememberCheck').checked, true);
    dom.window.close();
  } finally {
    asar.uncache(tempAsar);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

verifyHotLoginRuntime()
  .then(() => console.log('登录、账号隔离与会话恢复契约测试通过'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
