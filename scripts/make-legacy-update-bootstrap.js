/**
 * 为 v1.0.66 生成兼容桥接热补丁。
 *
 * v1.0.66 的主进程会自行下载完整安装包，但下载完成后的 IPC 事件在
 * 部分旧客户端中可能丢失。该补丁基于已经发布的旧版桥接 ZIP，仅给
 * login.html 增加一个与进度事件无关的安装轮询，不混入当前正式版 src/。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const AdmZip = require('adm-zip')
const { path7za } = require('7zip-bin')

const ROOT = path.join(__dirname, '..')
const DIST_DIR = path.join(ROOT, 'dist')
const LEGACY_BASE_VERSION = '1.0.66'
const DEFAULT_SOURCE_VERSION = '1.0.66.1'
const FALLBACK_MARKER = 'legacy-full-installer-fallback-v3'

function injectLegacyInstallerFallback(html, bridgeVersion = '1.0.68') {
  if (html.includes(FALLBACK_MARKER)) return html

  const scriptMarker = /<script>/i
  if (!scriptMarker.test(html)) {
    throw new Error('旧版 login.html 缺少预期的内联脚本')
  }

  // 必须放在原登录脚本最前面：即使后续旧代码发生运行时异常，轮询也已注册。
  const snippet = `/*${FALLBACK_MARKER}*/(function(){var o=document.getElementById('updateOverlay'),t=document.getElementById('updateTitle'),b=document.getElementById('updateBar'),s=document.getElementById('updateStatus'),f=function(){if(o)o.classList.add('active');try{var a=window.electronAPI;if(a&&a.confirmUpdateInstallByPath)a.confirmUpdateInstallByPath()}catch(e){}};f();if(t)t.textContent='正在准备兼容升级...';if(b)b.style.width='2%';if(s)s.textContent='v${bridgeVersion}';setInterval(f,500)})();`

  return html.replace(scriptMarker, match => `${match}${snippet}`)
}

function compactHtmlOutsideScript(html) {
  const match = html.match(/^([\s\S]*?<script>)([\s\S]*?)(<\/script>[\s\S]*)$/i)
  if (!match) throw new Error('旧版 login.html 结构无法压缩')

  function compactShell(value) {
    return value
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]+/gm, '')
      .replace(/\r?\n\s*\r?\n/g, '\n')
      .replace(/>\s+</g, '><')
  }

  return compactShell(match[1]) + match[2] + compactShell(match[3])
}

function fitToExactByteSize(html, exactBytes) {
  const size = Buffer.byteLength(html, 'utf8')
  if (size > exactBytes) {
    throw new Error(`桥接登录页 ${size} 字节，超过 ASAR 固定长度 ${exactBytes} 字节`)
  }
  const paddingSize = exactBytes - size
  if (paddingSize === 0) return html

  const closingIndex = html.lastIndexOf('</html>')
  if (closingIndex < 0) throw new Error('旧版 login.html 缺少 </html>')
  const padding = paddingSize >= 7
    ? `<!--${' '.repeat(paddingSize - 7)}-->`
    : ' '.repeat(paddingSize)
  return html.slice(0, closingIndex) + padding + html.slice(closingIndex)
}

function createConstrainedLoginHtml(originalHtml, bridgeVersion = '1.0.68') {
  const exactBytes = Buffer.byteLength(originalHtml, 'utf8')
  const injected = injectLegacyInstallerFallback(originalHtml, bridgeVersion)
  const compacted = compactHtmlOutsideScript(injected)
  return fitToExactByteSize(compacted, exactBytes)
}

function extractOriginalLogin(installerPath) {
  if (!fs.existsSync(installerPath)) throw new Error(`v1.0.66 安装包不存在: ${installerPath}`)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ychelper-v1066-login-'))
  try {
    execFileSync(path7za, [
      'x', installerPath, `-o${tempDir}`,
      'resources\\app.asar.unpacked\\src\\login.html', '-y'
    ], { stdio: 'ignore' })
    const loginPath = path.join(tempDir, 'resources', 'app.asar.unpacked', 'src', 'login.html')
    return fs.readFileSync(loginPath, 'utf8')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function buildLegacyBootstrap({
  sourcePath,
  outputPath,
  targetVersion,
  bridgeVersion = '1.0.68',
  originalLoginHtml
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

  if (!originalLoginHtml) throw new Error('必须提供 v1.0.66 安装包中的原始 login.html')
  const loginHtml = createConstrainedLoginHtml(originalLoginHtml, bridgeVersion)
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
  const installerPath = path.join(DIST_DIR, `ychelper-setup-${LEGACY_BASE_VERSION}.exe`)
  const originalLoginHtml = extractOriginalLogin(installerPath)
  const result = buildLegacyBootstrap({ sourcePath, outputPath, targetVersion, originalLoginHtml })
  console.log(`旧版桥接补丁已生成: ${result.outputPath} (${result.size} bytes)`)
}

module.exports = {
  FALLBACK_MARKER,
  buildLegacyBootstrap,
  createConstrainedLoginHtml,
  extractOriginalLogin,
  injectLegacyInstallerFallback
}
