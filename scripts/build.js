/**
 * build.js — 生产构建包装脚本
 *
 * 流程：编译字节码 → electron-builder → 恢复原文件
 * 确保无论构建成功或失败，源文件都会被恢复
 */

const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')

// 确定构建参数
const args = process.argv.slice(2)
const isDir = args.includes('--dir')
const buildCmd = isDir ? 'electron-builder --win --dir' : 'electron-builder --win'

async function main() {
  console.log('=== 云仓助手生产构建 ===\n')

  try {
    // 1. 编译字节码
    console.log('[1/3] 编译字节码...')
    execSync('node scripts/compile-bytecode.js', { cwd: ROOT, stdio: 'inherit' })

    // 2. 运行 electron-builder
    console.log('\n[2/3] 打包应用...')
    execSync(buildCmd, { cwd: ROOT, stdio: 'inherit' })

  } catch (err) {
    console.error('\n构建失败:', err.message)
  } finally {
    // 3. 无论成功或失败，恢复源文件
    console.log('\n[3/3] 恢复源文件...')
    restoreBackups()
  }
}

function restoreBackups() {
  const files = [
    { backup: 'main.js.backup', original: 'main.js' }
  ]

  // 同时清理生成的 .jsc 文件（避免提交到 git）
  const jscFiles = ['main.jsc']

  for (const { backup, original } of files) {
    const backupPath = path.join(ROOT, backup)
    const originalPath = path.join(ROOT, original)
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, originalPath)
      fs.unlinkSync(backupPath)
      console.log(`  ✓ 已恢复 ${original}`)
    }
  }

  for (const jsc of jscFiles) {
    const jscPath = path.join(ROOT, jsc)
    if (fs.existsSync(jscPath)) {
      fs.unlinkSync(jscPath)
      console.log(`  ✓ 已清理 ${jsc}`)
    }
  }
}

main().catch(err => {
  console.error('构建脚本错误:', err)
  restoreBackups()
  process.exit(1)
})
