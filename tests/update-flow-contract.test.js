const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const login = fs.readFileSync(path.join(root, 'src', 'login.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src', 'js', 'renderer.js'), 'utf8');
const rules = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
const hotBuild = fs.readFileSync(path.join(root, 'scripts', 'make-hot-update.js'), 'utf8');
const onlineVerifier = fs.readFileSync(path.join(root, 'scripts', 'verify-online-release.js'), 'utf8');

assert.match(main, /autoUpdater\.autoDownload\s*=\s*false/);
assert.match(main, /autoUpdater\.autoInstallOnAppQuit\s*=\s*false/);
assert.match(main, /autoUpdater\.disableDifferentialDownload\s*=\s*false/);
assert.match(main, /autoUpdater\.disableWebInstaller\s*=\s*true/);
assert.match(main, /await autoUpdater\.downloadUpdate\(\)/);
assert.match(main, /差分更新下载失败，立即切换完整包续传/);
assert.match(main, /createUpdateDownloadState/);
assert.match(main, /autoUpdater\.logger\s*=\s*\{/);
assert.match(main, /autoUpdaterDownloadState\.inspectUpdaterLog/);
assert.match(main, /autoUpdaterDownloadState\.handleProgress/);
assert.match(main, /inspectDifferentialBase/);
assert.match(main, /hasUsableDifferentialBase/);
assert.match(main, /本机缺少 installer\.exe，跳过差分下载/);
assert.match(main, /mode:\s*normalizedProgress\.mode/);
assert.match(main, /mode:\s*'完整更新'/);
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
assert.match(login, /body\.update-mode \.update-bar-wrap[\s\S]{0,220}flex:\s*0 0 8px/,
  '独立更新页的进度条必须保持为固定高度横线，不能被纵向 flex 拉伸');
assert.match(login, /data\.bytesPerSecond/);
assert.match(login, /data\.etaSeconds/);
assert.match(login, /if \(data\.mode\) details\.push\(data\.mode\)/);
assert.match(renderer, /data\.message[\s\S]{0,180}正在下载 v/,
  '运行中更新窗口必须显示差分回退提示');
assert.match(renderer, /if \(data\.mode\) details\.push\(data\.mode\)/,
  '运行中更新窗口必须显示差分或完整更新模式');
assert.match(rules, /latest\.yml/);
assert.match(rules, /\.blockmap/);
assert.match(rules, /跨版本/);
assert.match(rules, /十几个版本/);
assert.match(rules, /multipart\/byteranges/);
assert.match(rules, /--baselines=/);
assert.match(rules, /所有三段正式版本号 `X\.Y\.Z` 都必须发布完整安装包/);
assert.match(rules, /旧用户启动时必须先升级到该完整版本并重启/);
assert.match(rules, /1\.0\.66 旧客户端兼容桥接/);
assert.match(rules, /update-1\.0\.66\.1\.zip/);
assert.match(rules, /完整包兜底必须固定返回 v1\.0\.68/);
assert.match(rules, /Restart-Service -Name "YchelperServer" -Force/);
assert.match(rules, /powershell -NoProfile -EncodedCommand/);
assert.match(hotBuild, /三段正式版本必须发布完整安装包/);
assert.match(hotBuild, /必须基于当前完整版本/);
assert.match(onlineVerifier, /function isValidChineseChangelog/);
assert.match(onlineVerifier, /bootstrapData\.version !== '1\.0\.66\.1'/);
assert.match(onlineVerifier, /bridgeVersion !== '1\.0\.66'/);
assert.match(onlineVerifier, /legacy-bridge-repeat=/);
assert.match(onlineVerifier, /repeatedBridgeVersion !== '1\.0\.66'/);
assert.match(onlineVerifier, /cached-legacy-check/);
assert.match(onlineVerifier, /cached-legacy-download/);
assert.match(onlineVerifier, /cached-legacy-full-check/);
assert.match(onlineVerifier, /data\.version !== '1\.0\.68'/);
assert.match(onlineVerifier, /data\.bridge !== true/);
assert.doesNotMatch(onlineVerifier, /changelog\.includes\('自动更新'\)/,
  'UTF-8 中文校验不得依赖某个固定更新文案');

console.log('更新流程契约测试通过：启动顺序、差分下载、续传兜底、跨多版本、自动安装和更新内容展示均已覆盖');
