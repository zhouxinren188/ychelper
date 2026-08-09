const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

function fail(message) {
  throw new Error(`[发布文件校验失败] ${message}`);
}

function readArg(name) {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find(arg => arg.startsWith(prefix));
  return item ? item.slice(prefix.length) : '';
}

function yamlValue(source, key) {
  const match = source.match(new RegExp(`^${key}:\\s*['\"]?([^'\"\\r\\n]+)['\"]?\\s*$`, 'm'));
  return match ? match[1].trim() : '';
}

function sha512(filePath) {
  const hash = crypto.createHash('sha512');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('base64');
}

function verifyBlockmap(blockmapPath, installerSize) {
  let parsed;
  try {
    parsed = JSON.parse(zlib.gunzipSync(fs.readFileSync(blockmapPath)));
  } catch (err) {
    fail(`${path.basename(blockmapPath)} 不是有效的 gzip JSON blockmap: ${err.message}`);
  }

  if (String(parsed.version) !== '2' || !Array.isArray(parsed.files) || parsed.files.length === 0) {
    fail(`${path.basename(blockmapPath)} 结构或版本无效`);
  }

  const mappedSize = parsed.files.reduce((fileTotal, file) => {
    if (!Array.isArray(file.sizes) || !Array.isArray(file.checksums) || file.sizes.length !== file.checksums.length) {
      fail(`${path.basename(blockmapPath)} 的块大小与校验列表不一致`);
    }
    return fileTotal + file.sizes.reduce((total, size) => total + Number(size || 0), 0);
  }, 0);

  if (mappedSize !== installerSize) {
    fail(`${path.basename(blockmapPath)} 映射大小 ${mappedSize} 与安装包大小 ${installerSize} 不一致`);
  }
  return parsed.files.reduce((total, file) => total + file.sizes.length, 0);
}

function readBlockmap(blockmapPath) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(blockmapPath)));
}

function estimateDifferentialDownload(oldBlockmapPath, newBlockmapPath) {
  const oldMap = readBlockmap(oldBlockmapPath);
  const newMap = readBlockmap(newBlockmapPath);
  const reusable = new Map();
  for (const file of oldMap.files || []) {
    for (let index = 0; index < file.checksums.length; index += 1) {
      const checksum = file.checksums[index];
      if (!reusable.has(checksum)) reusable.set(checksum, Number(file.sizes[index] || 0));
    }
  }
  let total = 0;
  let download = 0;
  for (const file of newMap.files || []) {
    for (let index = 0; index < file.checksums.length; index += 1) {
      const size = Number(file.sizes[index] || 0);
      total += size;
      if (reusable.get(file.checksums[index]) !== size) download += size;
    }
  }
  return { download, total };
}

function verifyHistoricalVersion(version, newBlockmapPath) {
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) fail(`历史基线版本号无效: ${version}`);
  const exePath = path.join(DIST, `ychelper-setup-${version}.exe`);
  const blockmapPath = `${exePath}.blockmap`;
  if (!fs.existsSync(exePath)) fail(`缺少历史基线安装包 ${path.basename(exePath)}`);
  if (!fs.existsSync(blockmapPath)) fail(`缺少历史基线 blockmap ${path.basename(blockmapPath)}`);
  const size = fs.statSync(exePath).size;
  verifyBlockmap(blockmapPath, size);
  console.log(`  ✓ 历史基线 v${version}: exe + blockmap 完整`);
  const differential = estimateDifferentialDownload(blockmapPath, newBlockmapPath);
  const percent = differential.total > 0 ? differential.download / differential.total * 100 : 0;
  console.log(`  ✓ v${version} 预计差分下载: ${(differential.download / 1024 / 1024).toFixed(2)} MiB (${percent.toFixed(2)}%)`);
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = String(pkg.version || '');
  const requestedVersion = readArg('version');
  if (requestedVersion && requestedVersion !== version) {
    fail(`参数版本 ${requestedVersion} 与 package.json ${version} 不一致`);
  }

  const latestPath = path.join(DIST, 'latest.yml');
  const exeName = `ychelper-setup-${version}.exe`;
  const exePath = path.join(DIST, exeName);
  const blockmapPath = `${exePath}.blockmap`;
  for (const requiredPath of [latestPath, exePath, blockmapPath]) {
    if (!fs.existsSync(requiredPath)) fail(`缺少 ${path.basename(requiredPath)}`);
  }

  const latest = fs.readFileSync(latestPath, 'utf8');
  const latestVersion = yamlValue(latest, 'version');
  const latestPathValue = yamlValue(latest, 'path');
  const latestSha = yamlValue(latest, 'sha512');
  const sizeMatch = latest.match(/^\s*size:\s*(\d+)\s*$/m);
  const latestSize = sizeMatch ? Number(sizeMatch[1]) : 0;

  if (latestVersion !== version) fail(`latest.yml 版本 ${latestVersion || '(空)'} 与 package.json ${version} 不一致`);
  if (latestPathValue !== exeName) fail(`latest.yml path 必须为 ${exeName}`);

  const actualSize = fs.statSync(exePath).size;
  if (!actualSize || actualSize !== latestSize) fail(`安装包大小 ${actualSize} 与 latest.yml ${latestSize} 不一致`);
  const actualSha = sha512(exePath);
  if (actualSha !== latestSha) fail('安装包 SHA-512 与 latest.yml 不一致');
  const blockCount = verifyBlockmap(blockmapPath, actualSize);

  const baselines = (readArg('baseline') || process.env.YCHELPER_RELEASE_BASELINE || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  baselines.forEach(baseline => verifyHistoricalVersion(baseline, blockmapPath));

  console.log(`[发布文件校验通过] v${version}`);
  console.log(`  ✓ ${exeName}: ${actualSize} bytes`);
  console.log(`  ✓ SHA-512: ${actualSha}`);
  console.log(`  ✓ ${path.basename(blockmapPath)}: ${blockCount} blocks`);
  console.log('  ✓ latest.yml / exe / blockmap 三件套一致');
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
