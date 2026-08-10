const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const BASE_URL = 'http://150.158.54.108:3000';

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find(value => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

async function expectResponse(url, options, expectedStatus, label) {
  const response = await fetch(url, options);
  if (response.status !== expectedStatus) {
    throw new Error(`${label}: 期望 HTTP ${expectedStatus}，实际 ${response.status}`);
  }
  return response;
}

function compareVersions(left, right) {
  const leftParts = String(left).split('.').map(Number);
  const rightParts = String(right).split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function isValidChineseChangelog(value) {
  const text = String(value || '');
  return /[\u3400-\u9fff]/.test(text) && !/�|Ã|â€|åº—/.test(text);
}

function validateBlockmap(buffer, installerSize, label) {
  let parsed;
  try {
    parsed = JSON.parse(zlib.gunzipSync(buffer));
  } catch (err) {
    throw new Error(`${label} 不是有效的 gzip JSON blockmap: ${err.message}`);
  }
  if (String(parsed.version) !== '2' || !Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error(`${label} 的结构或版本无效`);
  }
  const mappedSize = parsed.files.reduce((fileTotal, file) => {
    if (!Array.isArray(file.sizes) || !Array.isArray(file.checksums)
      || file.sizes.length !== file.checksums.length) {
      throw new Error(`${label} 的块大小与校验列表不一致`);
    }
    return fileTotal + file.sizes.reduce((total, size) => total + Number(size || 0), 0);
  }, 0);
  if (mappedSize !== installerSize) {
    throw new Error(`${label} 映射大小 ${mappedSize} 与安装包大小 ${installerSize} 不一致`);
  }
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = arg('version', pkg.version);
  const baselines = (arg('baselines') || arg('baseline'))
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error('目标版本号无效');
  for (const baseline of baselines) {
    if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(baseline)) throw new Error(`基线版本号无效: ${baseline}`);
    if (compareVersions(version, baseline) <= 0) throw new Error(`目标版本 v${version} 必须高于基线 v${baseline}`);
  }

  const exeName = `ychelper-setup-${version}.exe`;
  const localLatestPath = path.join(DIST, 'latest.yml');
  const localExePath = path.join(DIST, exeName);
  const localBlockmapPath = `${localExePath}.blockmap`;
  if (!fs.existsSync(localLatestPath) || !fs.existsSync(localExePath) || !fs.existsSync(localBlockmapPath)) {
    throw new Error('本地缺少目标版本发布三件套，无法进行线上同源校验');
  }
  const localLatest = fs.readFileSync(localLatestPath, 'utf8');
  const localSha = (localLatest.match(/^sha512:\s*(.+)$/m) || [])[1];
  const localSize = fs.statSync(localExePath).size;

  const latestResponse = await expectResponse(`${BASE_URL}/latest.yml?verify=${Date.now()}`, { cache: 'no-store' }, 200, 'latest.yml');
  const latest = await latestResponse.text();
  if (!latest.includes(`version: ${version}`) || !latest.includes(exeName)) {
    throw new Error('latest.yml 未指向目标版本');
  }
  if (!localSha || !latest.includes(`sha512: ${localSha}`) || !latest.includes(`size: ${localSize}`)) {
    throw new Error('线上 latest.yml 的大小或 SHA-512 与本机构建结果不一致');
  }

  const remotePath = ((latest.match(/^path:\s*(.+)$/m) || [])[1] || '').trim();
  const expectedRemotePath = `api/update/file/${exeName}`;
  if (remotePath !== expectedRemotePath) throw new Error(`latest.yml 未使用多段 Range 端点: ${remotePath || '(空)'}`);
  const updaterExeUrl = new URL(remotePath, `${BASE_URL}/`).toString();
  const updaterBlockmapUrl = `${updaterExeUrl}.blockmap`;

  const exeHead = await expectResponse(`${BASE_URL}/${exeName}`, { method: 'HEAD', cache: 'no-store' }, 200, '完整包兜底安装包');
  const updaterExeHead = await expectResponse(updaterExeUrl, { method: 'HEAD', cache: 'no-store' }, 200, '差分更新安装包');
  const blockHead = await expectResponse(updaterBlockmapUrl, { method: 'HEAD', cache: 'no-store' }, 200, '最新版 blockmap');
  if (Number(exeHead.headers.get('content-length') || 0) <= 0) throw new Error('最新版安装包大小无效');
  if (Number(blockHead.headers.get('content-length') || 0) <= 0) throw new Error('最新版 blockmap 大小无效');
  if (Number(exeHead.headers.get('content-length')) !== localSize) throw new Error('线上安装包大小与本地不一致');
  if (Number(updaterExeHead.headers.get('content-length')) !== localSize) throw new Error('差分端点安装包大小与本地不一致');

  const remoteBlockmap = await expectResponse(`${updaterBlockmapUrl}?verify=${Date.now()}`, { cache: 'no-store' }, 200, '最新版 blockmap 内容');
  const remoteBlockmapBuffer = Buffer.from(await remoteBlockmap.arrayBuffer());
  if (!remoteBlockmapBuffer.equals(fs.readFileSync(localBlockmapPath))) {
    throw new Error('线上最新版 blockmap 与本机构建结果不一致');
  }
  validateBlockmap(remoteBlockmapBuffer, localSize, `v${version} blockmap`);

  const range = await expectResponse(`${BASE_URL}/${exeName}`, {
    headers: { Range: 'bytes=0-1023' },
    cache: 'no-store'
  }, 206, '断点续传');
  if (!/^bytes 0-1023\/\d+$/.test(range.headers.get('content-range') || '')) {
    throw new Error('断点续传 Content-Range 无效');
  }
  await range.arrayBuffer();

  const multiRange = await expectResponse(updaterExeUrl, {
    headers: { Range: 'bytes=0-31, 1024-1055' },
    cache: 'no-store'
  }, 206, '差分多段 Range');
  if (!/^multipart\/byteranges;\s*boundary=/i.test(multiRange.headers.get('content-type') || '')) {
    throw new Error('差分端点未返回 multipart/byteranges');
  }
  const multiRangeBody = Buffer.from(await multiRange.arrayBuffer());
  if (!multiRangeBody.includes(Buffer.from(`Content-Range: bytes 0-31/${localSize}`))
    || !multiRangeBody.includes(Buffer.from(`Content-Range: bytes 1024-1055/${localSize}`))) {
    throw new Error('差分端点返回的多段 Content-Range 不完整');
  }

  for (const baseline of baselines) {
    const baselineExeName = `ychelper-setup-${baseline}.exe`;
    const baselineExeHead = await expectResponse(`${BASE_URL}/${baselineExeName}`, { method: 'HEAD', cache: 'no-store' }, 200, `历史安装包 v${baseline}`);
    const baselineSize = Number(baselineExeHead.headers.get('content-length') || 0);
    if (baselineSize <= 0) throw new Error(`线上历史安装包 v${baseline} 大小无效`);

    // electron-updater 会把 latest.yml 中的新版本路径替换成当前版本，
    // 因此历史 blockmap 必须在同一个多段 Range 端点长期可访问。
    const baselineBlockUrl = `${BASE_URL}/api/update/file/${baselineExeName}.blockmap`;
    const baselineBlockResponse = await expectResponse(`${baselineBlockUrl}?verify=${Date.now()}`, { cache: 'no-store' }, 200, `历史 blockmap v${baseline}`);
    const baselineBlockBuffer = Buffer.from(await baselineBlockResponse.arrayBuffer());
    validateBlockmap(baselineBlockBuffer, baselineSize, `历史 blockmap v${baseline}`);

    const check = await expectResponse(`${BASE_URL}/api/update/full-check?version=${encodeURIComponent(baseline)}`, { cache: 'no-store' }, 200, '跨版本更新检测');
    const data = await check.json();
    const legacyFullFallbackDisabled = compareVersions(baseline, '1.0.67') < 0;
    if (!legacyFullFallbackDisabled && (!data.needUpdate || data.version !== version || !data.downloadUrl || !data.sha512 || !data.size || !data.changelog)) {
      throw new Error(`v${baseline} 跨版本检测元数据不完整或未指向 v${version}`);
    }
    if (!legacyFullFallbackDisabled && !isValidChineseChangelog(data.changelog)) {
      throw new Error('完整更新说明不是有效的 UTF-8 中文内容');
    }

    const loginCheck = await expectResponse(`${BASE_URL}/api/update/login-check?version=${encodeURIComponent(baseline)}`, { cache: 'no-store' }, 200, '登录页更新检测');
    const loginData = await loginCheck.json();
    if (!loginData.needUpdate || loginData.version !== version || !loginData.downloadUrl
      || loginData.sha512 !== localSha || Number(loginData.size) !== localSize || !loginData.changelog) {
      throw new Error(`v${baseline} 登录页跨版本更新元数据不完整或未指向 v${version}`);
    }
    if (!legacyFullFallbackDisabled && (loginData.downloadUrl !== data.downloadUrl
      || loginData.sha512 !== data.sha512 || Number(loginData.size) !== Number(data.size)
      || loginData.changelog !== data.changelog)) {
      throw new Error(`v${baseline} 登录页更新检测与完整更新检测元数据不一致`);
    }
  }

  console.log(`[线上发布校验通过] v${version}`);
  console.log('  ✓ latest.yml、exe、blockmap 与本机构建结果一致');
  console.log('  ✓ 安装包支持 HTTP Range 断点续传');
  console.log('  ✓ 差分更新端点支持 multipart/byteranges');
  if (baselines.length > 0) {
    console.log(`  ✓ ${baselines.map(item => `v${item}`).join('、')} 均可直接检测并升级到 v${version}`);
    console.log('  ✓ 所有历史 blockmap 均完整，full-check / login-check 元数据符合对应旧版策略');
  }
}

main().catch(err => {
  console.error(`[线上发布校验失败] ${err.message}`);
  process.exit(1);
});
