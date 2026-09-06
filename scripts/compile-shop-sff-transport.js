'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'native', 'shop-sff-transport', 'ShopSffTransport.cs');
const OUTPUT_DIR = path.join(ROOT, 'native', 'shop-sff-transport', 'bin');
const OUTPUT = path.join(OUTPUT_DIR, 'ShopSffTransport.exe');
const CSC_CANDIDATES = [
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
];

function findCompiler() {
  const compiler = CSC_CANDIDATES.find(candidate => fs.existsSync(candidate));
  if (!compiler) throw new Error('未找到 Windows .NET Framework C# 编译器，无法生成店铺查询兼容传输模块');
  return compiler;
}

function needsCompile() {
  if (!fs.existsSync(OUTPUT)) return true;
  return fs.statSync(OUTPUT).mtimeMs < fs.statSync(SOURCE).mtimeMs;
}

function compile() {
  if (process.platform !== 'win32') throw new Error('店铺查询兼容传输模块只能在 Windows 上构建');
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  if (!needsCompile()) return OUTPUT;
  execFileSync(findCompiler(), [
    '/nologo',
    '/optimize+',
    '/target:exe',
    `/out:${OUTPUT}`,
    '/reference:System.dll',
    '/reference:System.Core.dll',
    '/reference:System.Web.Extensions.dll',
    SOURCE
  ], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  if (!fs.existsSync(OUTPUT) || fs.statSync(OUTPUT).size < 4096) {
    throw new Error('店铺查询兼容传输模块构建结果无效');
  }
  return OUTPUT;
}

if (require.main === module) {
  try {
    const output = compile();
    console.log(`[shop-sff-transport] ready: ${path.relative(ROOT, output)}`);
  } catch (error) {
    console.error(`[shop-sff-transport] build failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { compile, OUTPUT, SOURCE };
