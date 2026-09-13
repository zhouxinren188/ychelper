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
assert.match(main, /let merchantWorkspaceWindow = null;/);
assert.match(main, /merchantWorkspaceWindow = new BrowserWindow\(/);
assert.match(main, /const target = merchantWorkspaceWindow;/);
assert.match(main, /if \(shouldLoad[\s\S]*?await target\.loadURL\(MERCHANT_WORKSPACE_URL\);/);
assert.match(main, /if \(!target\.isMaximized\(\)\) target\.maximize\(\);\s*target\.show\(\);\s*target\.focus\(\);/,
  '用户进入商家端时窗口必须默认最大化');
assert.match(main, /ipcMain\.handle\('open-cp-workspace'/);
assert.match(main, /const merchantPartition = getMerchantPartition\(\);/);
assert.match(main, /await target\.loadURL\(CP_WORKSPACE_URL\);/);
assert.match(main, /if \(show\) \{[\s\S]*?target\.maximize\(\);[\s\S]*?target\.show\(\);[\s\S]*?target\.focus\(\);/,
  '用户进入CP端时窗口必须默认最大化，后台会话初始化不得显示窗口');
assert.match(main, /preservedJdPageWindow\.on\('close',[\s\S]*?event\.preventDefault\(\);[\s\S]*?preservedJdPageWindow\.hide\(\);/);
assert.match(preload, /cancelJdLabelRequest:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('cancel-jd-label-request'\)/);
assert.match(main, /const JD_LABEL_AJAX_TIMEOUT_MS = 30000;/);
assert.match(main, /const JD_LABEL_EXECUTION_TIMEOUT_MS = 35000;/);
assert.match(main, /timeout:\s*\$\{JD_LABEL_AJAX_TIMEOUT_MS\}/);
assert.match(main, /ipcMain\.handle\('cancel-jd-label-request'/);
assert.match(renderer, /cancelJdLabelRequest\(\)/);
assert.match(renderer, /if \(stopRequested \|\| result\.cancelled\) return;/);

console.log('商家端入口测试通过：商家端与 CP 端共享当前账号会话，但可见商家端与隐藏打标环境相互隔离');
