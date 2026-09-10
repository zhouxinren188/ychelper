'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

assert.match(main, /const SHOP_ENVIRONMENT_CACHE_LIMIT = 3;/,
  '店铺查询环境缓存必须限制数量，避免隐藏页面无限占用内存');
assert.match(main, /const shopEnvironmentCache = new Map\(\);/,
  '不同店铺必须分别保存查询环境');
assert.match(main, /function stashActiveShopEnvironment\(\)[\s\S]*rememberShopEnvironment\(accountId, win, shopSffContextHeaders\)/,
  '切换店铺前必须保存当前店铺自己的窗口和签名环境');
assert.match(main, /function restoreShopEnvironment\(accountId\)[\s\S]*shopSffContextHeaders = cached\.contextHeaders \|\| null;/,
  '切回店铺时必须同时恢复该店铺自己的页面与签名环境');
assert.match(main, /targetAccountId === activeShopAccountId[\s\S]*environmentReused: true/,
  '重复选择同一店铺不得销毁已经准备好的查询环境');
assert.match(main, /stashActiveShopEnvironment\(\);[\s\S]*activeShopAccountId = targetAccountId;[\s\S]*restoreShopEnvironment\(targetAccountId\)/,
  '跨店铺切换必须先保存旧环境，再恢复目标店铺环境');
assert.match(main, /environmentReused && sessionCookies\.length === 0[\s\S]*destroyShopEnvironment\(targetAccountId\)/,
  '缓存环境缺少对应实时 Cookie 时必须立即作废');
assert.match(main, /if \(!shopLoggedIn\) destroyShopEnvironment\(queryAccountId\)/,
  '京东明确判定登录失效后必须销毁当前店铺旧环境');
assert.match(main, /updateActiveShopEnvironmentHeaders\(normalized, win\)/,
  '新捕获的签名上下文必须回写到当前店铺缓存');
assert.match(main, /destroyAllShopEnvironments\(\);[\s\S]*if \(shopLoginWindow/,
  '软件退出时必须销毁所有缓存的隐藏店铺窗口');

console.log('店铺独立查询环境缓存测试通过');
