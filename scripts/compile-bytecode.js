/**
 * compile-bytecode.js — 将主进程和预加载脚本编译为 V8 字节码
 *
 * 用法: node scripts/compile-bytecode.js
 * 时机: 在 electron-builder 之前执行
 *
 * 保护范围:
 *   main.js    → main.jsc    (主进程全部代码)
 *   preload.js → preload.jsc (预加载脚本)
 *
 * 不编译:
 *   src/ 目录 — 需要支持热更新，保持明文
 *
 * 编译后 main.js/preload.js 被替换为引导加载器，直接加载内置 .jsc。
 * 热更新仅支持 src/，主进程始终运行 app.asar 内置的字节码。
 */

const bytenode = require('bytenode')
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')

const COMPILE_TARGETS = [
  {
    src: path.join(ROOT, 'main.js'),
    jsc: path.join(ROOT, 'main.jsc'),
    loaderName: 'main.js',
    backupName: 'main.js.backup'
  }
  // preload.js 不编译：Electron preload 上下文不支持 bytenode 引导加载器
  // preload 代码量少，保持明文即可
]

async function main() {
  console.log('[compile-bytecode] 开始字节码编译...')

  // 1. 验证源文件存在
  for (const target of COMPILE_TARGETS) {
    if (!fs.existsSync(target.src)) {
      console.error(`[compile-bytecode] 错误: 找不到 ${target.src}`)
      process.exit(1)
    }
  }

  // 2. 备份原始文件
  for (const target of COMPILE_TARGETS) {
    fs.copyFileSync(target.src, path.join(ROOT, target.backupName))
    console.log(`[compile-bytecode] 已备份 ${target.loaderName} → ${target.backupName}`)
  }

  try {
    // 3. 编译字节码
    for (const target of COMPILE_TARGETS) {
      console.log(`[compile-bytecode] 编译 ${target.loaderName} ...`)

      try {
        await bytenode.compileFile({
          filename: target.src,
          electron: true,
          compileAsModule: true,
          createLoader: 'commonjs',
          loaderFilename: target.loaderName
        })
      } catch (err) {
        console.error(`[compile-bytecode] 编译失败: ${target.src}`)
        console.error(err)
        // 恢复备份
        restoreBackups()
        process.exit(1)
      }

      // 4. 验证 .jsc 文件
      if (!fs.existsSync(target.jsc)) {
        console.error(`[compile-bytecode] 错误: 编译后未生成 ${target.jsc}`)
        restoreBackups()
        process.exit(1)
      }

      const jscSize = fs.statSync(target.jsc).size
      if (jscSize === 0) {
        console.error(`[compile-bytecode] 错误: ${target.jsc} 大小为 0`)
        restoreBackups()
        process.exit(1)
      }

      console.log(`[compile-bytecode] ✓ ${path.relative(ROOT, target.jsc)} (${(jscSize / 1024).toFixed(1)} KB)`)

      // 5. 替换为引导加载器
      const bootstrapCode = `// 引导加载器 — 由 compile-bytecode.js 自动生成
// 热更新仅支持 src/，主进程始终加载内置 .jsc 字节码
require('bytenode')
module.exports = require('./${path.basename(target.jsc)}')
`
      fs.writeFileSync(target.src, bootstrapCode, 'utf-8')
      console.log(`[compile-bytecode] ✓ ${target.loaderName} 已替换为引导加载器`)
    }

    console.log('[compile-bytecode] 字节码编译完成!')
  } catch (err) {
    console.error('[compile-bytecode] 未预期的错误:', err)
    restoreBackups()
    process.exit(1)
  }
}

function restoreBackups() {
  console.log('[compile-bytecode] 恢复备份文件...')
  for (const target of COMPILE_TARGETS) {
    const backupPath = path.join(ROOT, target.backupName)
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, target.src)
      fs.unlinkSync(backupPath)
      console.log(`[compile-bytecode] 已恢复 ${target.loaderName}`)
    }
  }
}

// 如果不是被其他脚本 require，则直接运行
if (require.main === module) {
  main().catch(err => {
    console.error('[compile-bytecode] 未预期的错误:', err)
    restoreBackups()
    process.exit(1)
  })
}

module.exports = { main, restoreBackups, COMPILE_TARGETS }
