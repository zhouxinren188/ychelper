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
assert.match(html, /id="aoOpenCpBtn"[^>]*>进入CP端<\/button>/);
assert.match(css, /\.ao-portal-actions\s*\{[^}]*margin-left:\s*auto[^}]*display:\s*flex/s);
assert.match(renderer, /window\.electronAPI\.openMerchantWorkspace\(\)/);
assert.match(renderer, /window\.electronAPI\.openCpWorkspace\(\)/);
assert.match(preload, /openMerchantWorkspace:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('open-merchant-workspace'\)/);
assert.match(preload, /openCpWorkspace:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('open-cp-workspace'\)/);
assert.match(main, /const MERCHANT_WORKSPACE_URL = 'https:\/\/o\.jdl\.com';/);
assert.match(main, /const CP_WORKSPACE_URL = 'https:\/\/cp\.jdl\.com';/);
assert.match(main, /ipcMain\.handle\('open-merchant-workspace'/);
assert.match(main, /const target = jdPageWindow;/);
assert.match(main, /await target\.loadURL\(MERCHANT_WORKSPACE_URL\);/);
assert.match(main, /ipcMain\.handle\('open-cp-workspace'/);
assert.match(main, /const merchantPartition = getMerchantPartition\(\);/);
assert.match(main, /await target\.loadURL\(CP_WORKSPACE_URL\);/);
assert.match(main, /preservedJdPageWindow\.on\('close',[\s\S]*?event\.preventDefault\(\);[\s\S]*?preservedJdPageWindow\.hide\(\);/);

console.log('商家端入口测试通过：商家端与 CP 端入口共用当前账号会话，隐藏 o.jdl.com 窗口继续保持后台环境');
