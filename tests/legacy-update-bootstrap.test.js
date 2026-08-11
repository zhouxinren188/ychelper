const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const AdmZip = require('adm-zip')
const {
  FALLBACK_MARKER,
  buildLegacyBootstrap,
  injectLegacyInstallerFallback
} = require('../scripts/make-legacy-update-bootstrap')

const inputHtml = '<html>\n<body>\n  <script>\n  </script>\n</body>\n</html>\n'
const injected = injectLegacyInstallerFallback(inputHtml)
assert.match(injected, new RegExp(FALLBACK_MARKER))
assert.match(injected, /setInterval\(function\(\)/)
assert.match(injected, /confirmUpdateInstallByPath\(\)/)
assert.strictEqual(injectLegacyInstallerFallback(injected), injected, '重复注入必须保持幂等')

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ychelper-legacy-bootstrap-'))
try {
  const sourcePath = path.join(tempDir, 'update-1.0.66.1.zip')
  const outputPath = path.join(tempDir, 'update-1.0.66.2.zip')
  const sourceZip = new AdmZip()
  sourceZip.addFile('package.json', Buffer.from('{"name":"cloud-warehouse-assistant","version":"1.0.66.1"}\n'))
  sourceZip.addFile('src/login.html', Buffer.from(inputHtml))
  sourceZip.addFile('src/unchanged.txt', Buffer.from('keep-me'))
  sourceZip.writeZip(sourcePath)

  buildLegacyBootstrap({ sourcePath, outputPath, targetVersion: '1.0.66.2' })
  const outputZip = new AdmZip(outputPath)
  const outputPackage = JSON.parse(outputZip.readAsText('package.json'))
  assert.strictEqual(outputPackage.version, '1.0.66.2')
  assert.match(outputZip.readAsText('src/login.html'), new RegExp(FALLBACK_MARKER))
  assert.strictEqual(outputZip.readAsText('src/unchanged.txt'), 'keep-me')
  assert.strictEqual(outputZip.getEntry('main.js'), null, '桥接补丁不得包含主进程源码')
  assert.strictEqual(outputZip.getEntry('preload.js'), null, '桥接补丁不得覆盖 preload')
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
}

console.log('legacy-update-bootstrap tests passed')
