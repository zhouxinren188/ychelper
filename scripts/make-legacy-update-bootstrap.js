/**
 * 为 v1.0.66 生成兼容桥接热补丁。
 *
 * v1.0.66 的主进程会自行下载完整安装包，但下载完成后的 IPC 事件在
 * 部分旧客户端中可能丢失。该补丁基于已经发布的旧版桥接 ZIP，仅给
 * login.html 增加一个与进度事件无关的安装轮询，不混入当前正式版 src/。
 */

const fs = require('fs')
const path = require('path')
const AdmZip = require('adm-zip')

const ROOT = path.join(__dirname, '..')
const DIST_DIR = path.join(ROOT, 'dist')
const LEGACY_BASE_VERSION = '1.0.66'
const DEFAULT_SOURCE_VERSION = '1.0.66.1'
const FALLBACK_MARKER = 'legacy-full-installer-fallback-v2'

function injectLegacyInstallerFallback(html, bridgeVersion = '1.0.68') {
  if (html.includes(FALLBACK_MARKER)) return html

  const closingMarker = /  <\/script>\r?\n<\/body>/
  if (!closingMarker.test(html)) {
    throw new Error('旧版 login.html 缺少预期的脚本结束标记')
  }

  const snippet = `

    // ${FALLBACK_MARKER}
    // v1.0.66 主进程已经具备下载安装包和启动安装程序的 IPC；这里不再
    // 依赖可能丢失的 show-update-install 事件，而是定时触发无副作用查询。
    (function startLegacyFullInstallerFallback() {
      var overlay = document.getElementById('updateOverlay');
      var title = document.getElementById('updateTitle');
      var bar = document.getElementById('updateBar');
      var status = document.getElementById('updateStatus');
      if (overlay) overlay.classList.add('active');
      if (title) title.textContent = '正在准备兼容升级...';
      if (bar) bar.style.width = '2%';
      if (status) status.textContent = 'v${bridgeVersion}';

      var attempts = 0;
      var maxAttempts = 1200; // 最长轮询 30 分钟，避免永久占用登录页。
      var timer = setInterval(function() {
        attempts += 1;
        if (attempts > maxAttempts) {
          clearInterval(timer);
          if (overlay) overlay.classList.remove('active');
          return;
        }
        try {
          if (window.electronAPI && window.electronAPI.confirmUpdateInstallByPath) {
            // 安装包尚未下载完成时旧主进程会直接忽略；下载完成后会启动安装。
            window.electronAPI.confirmUpdateInstallByPath();
          }
        } catch (error) {
          // 旧版兼容兜底不得影响登录页运行。
        }
      }, 1500);
    })();`

  return html.replace(closingMarker, (match) => `${snippet}\n${match}`)
}

function buildLegacyBootstrap({
  sourcePath,
  outputPath,
  targetVersion,
  bridgeVersion = '1.0.68'
}) {
  if (!/^1\.0\.66\.[1-9]\d*$/.test(targetVersion)) {
    throw new Error(`旧版桥接补丁版本必须是 ${LEGACY_BASE_VERSION}.N`)
  }
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`基础桥接包不存在: ${sourcePath}`)
  }

  const zip = new AdmZip(sourcePath)
  const loginEntry = zip.getEntry('src/login.html')
  const packageEntry = zip.getEntry('package.json')
  if (!loginEntry || !packageEntry) {
    throw new Error('基础桥接包必须包含 src/login.html 和 package.json')
  }

  const loginHtml = injectLegacyInstallerFallback(
    loginEntry.getData().toString('utf8'),
    bridgeVersion
  )
  const packageJson = JSON.parse(packageEntry.getData().toString('utf8'))
  packageJson.version = targetVersion

  zip.updateFile('src/login.html', Buffer.from(loginHtml, 'utf8'))
  zip.updateFile('package.json', Buffer.from(`${JSON.stringify(packageJson, null, 2)}\n`, 'utf8'))
  zip.writeZip(outputPath)

  return {
    outputPath,
    size: fs.statSync(outputPath).size,
    targetVersion
  }
}

if (require.main === module) {
  const targetVersion = process.argv[2] || ''
  const sourceVersion = process.argv[3] || DEFAULT_SOURCE_VERSION
  const sourcePath = path.join(DIST_DIR, `update-${sourceVersion}.zip`)
  const outputPath = path.join(DIST_DIR, `update-${targetVersion}.zip`)
  const result = buildLegacyBootstrap({ sourcePath, outputPath, targetVersion })
  console.log(`旧版桥接补丁已生成: ${result.outputPath} (${result.size} bytes)`)
}

module.exports = {
  FALLBACK_MARKER,
  buildLegacyBootstrap,
  injectLegacyInstallerFallback
}
