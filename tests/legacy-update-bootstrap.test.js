const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const AdmZip = require('adm-zip')
const {
  FALLBACK_MARKER,
  buildLegacyBootstrap,
  createConstrainedLoginHtml,
  injectLegacyInstallerFallback
} = require('../scripts/make-legacy-update-bootstrap')

const inputHtml = `<html>
<head><style>/* removable ${' '.repeat(3200)} */body { color: #333; }</style></head>
<body><div id="updateOverlay"><span id="updateTitle"></span><span id="updateBar"></span><span id="updateStatus"></span></div>
  <script>
    window.originalLoginCode = true;
  </script>
</body>
</html>
`
const injected = createConstrainedLoginHtml(inputHtml)
assert.match(injected, new RegExp(FALLBACK_MARKER))
assert.match(injected, /setInterval\(f,500\)/)
assert.match(injected, /f=function\(\)\{if\(o\)o\.classList\.add\('active'\)/)
assert.match(injected, /confirmUpdateInstallByPath\(\)/)
assert.strictEqual(Buffer.byteLength(injected), Buffer.byteLength(inputHtml), '桥接页必须与 ASAR 原始长度完全一致')
assert(injected.indexOf(FALLBACK_MARKER) < injected.indexOf('window.originalLoginCode'), '兜底必须先于旧登录脚本执行')
assert.strictEqual(injectLegacyInstallerFallback(injected), injected, '重复注入必须保持幂等')

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ychelper-legacy-bootstrap-'))
try {
  const sourcePath = path.join(tempDir, 'update-1.0.66.1.zip')
  const outputPath = path.join(tempDir, 'update-1.0.66.3.zip')
  const sourceZip = new AdmZip()
  sourceZip.addFile('package.json', Buffer.from('{"name":"cloud-warehouse-assistant","version":"1.0.66.1"}\n'))
  sourceZip.addFile('src/login.html', Buffer.from(inputHtml))
  sourceZip.addFile('src/unchanged.txt', Buffer.from('keep-me'))
  sourceZip.writeZip(sourcePath)

  buildLegacyBootstrap({ sourcePath, outputPath, targetVersion: '1.0.66.3', originalLoginHtml: inputHtml })
  const outputZip = new AdmZip(outputPath)
  const outputPackage = JSON.parse(outputZip.readAsText('package.json'))
  assert.strictEqual(outputPackage.version, '1.0.66.3')
  assert.match(outputZip.readAsText('src/login.html'), new RegExp(FALLBACK_MARKER))
  assert.strictEqual(Buffer.byteLength(outputZip.readAsText('src/login.html')), Buffer.byteLength(inputHtml))
  assert.strictEqual(outputZip.readAsText('src/unchanged.txt'), 'keep-me')
  assert.strictEqual(outputZip.getEntry('main.js'), null, '桥接补丁不得包含主进程源码')
  assert.strictEqual(outputZip.getEntry('preload.js'), null, '桥接补丁不得覆盖 preload')
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
}

console.log('legacy-update-bootstrap tests passed')
