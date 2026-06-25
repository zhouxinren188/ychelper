/**
 * 热更新打包脚本（仅 src/ 渲染层）
 * 用法: node scripts/make-hot-update.js [version]
 *
 * 参数：
 *   [version]   版本号，默认取 package.json
 *
 * 注意：热更新仅包含 src/ 目录文件，主进程变更必须走全量发布（npm run build）
 */

const path = require('path')
const fs = require('fs')
const AdmZip = require('adm-zip')

const ROOT = path.join(__dirname, '..')
const DIST_DIR = path.join(ROOT, 'dist')

// 从命令行参数或 package.json 读取版本
const args = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
let version = args[0] || pkg.version

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('版本号格式错误，应为 x.y.z，当前:', version)
  process.exit(1)
}

console.log('=== 云仓助手热更新打包 ===')
console.log('版本:', version)
console.log('类型: src/ 渲染层仅（主进程变更需全量发布）')

// 1. 确认 src 目录存在
const srcDir = path.join(ROOT, 'src')
if (!fs.existsSync(srcDir)) {
  console.error('错误: src/ 目录不存在')
  process.exit(1)
}

// 2. 打包 zip
console.log('\n[1/3] 打包 zip...')
if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true })

const zip = new AdmZip()

// 添加 src/ 目录（保持目录结构）
zip.addLocalFolder(srcDir, 'src')

// 添加 package.json（版本号检测需要）
zip.addLocalFile(path.join(ROOT, 'package.json'))

const zipFilename = `update-${version}.zip`
const zipPath = path.join(DIST_DIR, zipFilename)
zip.writeZip(zipPath)

const zipSize = fs.statSync(zipPath).size
console.log(`\n打包完成: ${zipPath} (${(zipSize / 1024).toFixed(1)} KB)`)

// 3. 列出 ZIP 内容
console.log('\n[2/3] ZIP 内容:')
const entries = zip.getEntries()
entries.forEach(entry => {
  if (!entry.isDirectory) {
    console.log(`  ${entry.entryName} (${(entry.header.size / 1024).toFixed(1)} KB)`)
  }
})

console.log('\n[3/3] 完成！')
console.log('\n上传方式:')
console.log('  1. 管理后台: http://150.158.54.108:3000/admin → 热更新管理')
console.log('  2. curl 命令:')
console.log(`     curl -X POST http://150.158.54.108:3000/api/update/upload -H "x-admin-password: 密码" -F "file=@${zipPath}" -F "version=${version}" -F "changelog=渲染层热更新"`)
