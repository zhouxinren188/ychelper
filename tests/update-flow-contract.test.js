const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const login = fs.readFileSync(path.join(root, 'src', 'login.html'), 'utf8');
const rules = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');

assert.match(main, /autoUpdater\.autoDownload\s*=\s*false/);
assert.match(main, /autoUpdater\.autoInstallOnAppQuit\s*=\s*false/);
assert.match(main, /autoUpdater\.disableDifferentialDownload\s*=\s*false/);
assert.match(main, /autoUpdater\.disableWebInstaller\s*=\s*true/);
assert.match(main, /await autoUpdater\.downloadUpdate\(\)/);
assert.match(main, /差分更新下载失败，立即切换完整包续传/);
assert.match(main, /Range:\s*`bytes=\$\{resumeOffset\}-`/);
assert.match(main, /scheduleAutomaticInstall\('autoUpdater'\)/);
assert.match(main, /scheduleAutomaticInstall\('localPath', savePath\)/);
assert.doesNotMatch(main, /60000[\s\S]{0,200}checkForFullUpdate/);

const startupBlock = main.match(/loginWindow\.webContents\.once\('did-finish-load'[\s\S]*?startPeriodicUpdateChecks\(\);/);
assert(startupBlock, '缺少启动更新检查流程');
assert(startupBlock[0].indexOf("sendUpdateProgress('checking'") < startupBlock[0].indexOf('loginWindow.show()'), '显示窗口前必须先切换为检查更新状态');
assert(startupBlock[0].indexOf('checkAndApplyAutomaticUpdate') < startupBlock[0].indexOf("sendUpdateProgress('none'"), '登录表单只能在完整更新检查结束后显示');

assert.match(login, /class="update-changelog"/);
assert.match(login, /document\.body\.classList\.add\('update-mode'\)/);
assert.match(login, /data\.bytesPerSecond/);
assert.match(login, /data\.etaSeconds/);
assert.match(rules, /latest\.yml/);
assert.match(rules, /\.blockmap/);
assert.match(rules, /跨版本/);

console.log('更新流程契约测试通过：启动顺序、差分下载、续传兜底、自动安装和更新内容展示均已覆盖');
