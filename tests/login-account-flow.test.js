const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const loginHtml = fs.readFileSync(path.join(root, 'src', 'login.html'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src', 'js', 'renderer.js'), 'utf8');
const cookieManager = fs.readFileSync(path.join(root, 'src', 'js', 'cookieManager.js'), 'utf8');

assert.match(loginHtml, /const rememberPassword = rememberCheck\.checked/,
  '登录页必须读取“记住密码”选项');
assert.match(loginHtml, /await window\.electronAPI\.saveCredentials\([\s\S]*await window\.electronAPI\.openWebLogin/,
  '登录页必须先完成凭据保存，再打开登录窗口');
assert.match(loginHtml, /if \(!username\)[\s\S]*if \(!password\)/,
  '登录页必须校验账号和密码');

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
assert.doesNotMatch(main, /cookieImported: true[\s\S]{0,120}loggedIn: true/,
  '仅导入商家 Cookie 不得直接标记为已登录');

assert.match(preload, /returnToMerchantLogin/,
  'preload 必须暴露返回商家登录页接口');
assert.match(indexHtml, /id="merchantSwitchBtn"/,
  '主界面必须提供切换商家账号按钮');
assert.match(renderer, /returnToMerchantLogin\(\)/,
  '切换账号按钮必须接入主进程流程');

assert.match(main, /data\.lastShopAccountId = activeShopAccountId/,
  '店铺登录成功后必须保存最后活跃店铺 ID');
assert.match(main, /status: 'warehouse_missing'/,
  'WMS 恢复缺少仓库信息时不得标记已登录');
assert.match(main, /const timeoutId = setTimeout\(\(\) => controller\.abort\(\), 15000\)/,
  'WMS API 验证必须设置主动超时');
assert.match(cookieManager, /Cookie 加密不可用，已拒绝明文保存/,
  'Cookie 不得降级为明文保存');

console.log('登录、账号隔离与会话恢复契约测试通过');
