'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'css', 'style.css'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src', 'js', 'renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

assert.match(html, /id="aoOpenMerchantBtn"[^>]*>进入商家端<\/button>/);
assert.match(css, /\.ao-open-merchant-btn\s*\{[^}]*margin-left:\s*auto/s);
assert.match(renderer, /window\.electronAPI\.openMerchantWorkspace\(\)/);
assert.match(preload, /openMerchantWorkspace:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('open-merchant-workspace'\)/);
assert.match(main, /const MERCHANT_WORKSPACE_URL = 'https:\/\/o\.jdl\.com';/);
assert.match(main, /ipcMain\.handle\('open-merchant-workspace'/);
assert.match(main, /const target = jdPageWindow;/);
assert.match(main, /await target\.loadURL\(MERCHANT_WORKSPACE_URL\);/);
assert.match(main, /preservedJdPageWindow\.on\('close',[\s\S]*?event\.preventDefault\(\);[\s\S]*?preservedJdPageWindow\.hide\(\);/);

console.log('商家端入口测试通过：按钮复用隐藏 o.jdl.com 会话窗口并在用户关闭时保持后台环境');
