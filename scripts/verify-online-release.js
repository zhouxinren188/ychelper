const fs = require('fs');
const path = require('path');

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

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = arg('version', pkg.version);
  const baseline = arg('baseline');
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error('目标版本号无效');
  if (baseline && !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(baseline)) throw new Error('基线版本号无效');

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

  const exeHead = await expectResponse(`${BASE_URL}/${exeName}`, { method: 'HEAD', cache: 'no-store' }, 200, '最新版安装包');
  const blockHead = await expectResponse(`${BASE_URL}/${exeName}.blockmap`, { method: 'HEAD', cache: 'no-store' }, 200, '最新版 blockmap');
  if (Number(exeHead.headers.get('content-length') || 0) <= 0) throw new Error('最新版安装包大小无效');
  if (Number(blockHead.headers.get('content-length') || 0) <= 0) throw new Error('最新版 blockmap 大小无效');
  if (Number(exeHead.headers.get('content-length')) !== localSize) throw new Error('线上安装包大小与本地不一致');

  const remoteBlockmap = await expectResponse(`${BASE_URL}/${exeName}.blockmap?verify=${Date.now()}`, { cache: 'no-store' }, 200, '最新版 blockmap 内容');
  const remoteBlockmapBuffer = Buffer.from(await remoteBlockmap.arrayBuffer());
  if (!remoteBlockmapBuffer.equals(fs.readFileSync(localBlockmapPath))) {
    throw new Error('线上最新版 blockmap 与本机构建结果不一致');
  }

  const range = await expectResponse(`${BASE_URL}/${exeName}`, {
    headers: { Range: 'bytes=0-1023' },
    cache: 'no-store'
  }, 206, '断点续传');
  if (!/^bytes 0-1023\/\d+$/.test(range.headers.get('content-range') || '')) {
    throw new Error('断点续传 Content-Range 无效');
  }
  await range.arrayBuffer();

  if (baseline) {
    const localBaselineExe = path.join(DIST, `ychelper-setup-${baseline}.exe`);
    const localBaselineBlockmap = `${localBaselineExe}.blockmap`;
    if (!fs.existsSync(localBaselineExe) || !fs.existsSync(localBaselineBlockmap)) {
      throw new Error(`本地缺少历史基线 v${baseline} 的 exe 或 blockmap`);
    }
    const baselineExeHead = await expectResponse(`${BASE_URL}/ychelper-setup-${baseline}.exe`, { method: 'HEAD' }, 200, `历史安装包 v${baseline}`);
    if (Number(baselineExeHead.headers.get('content-length')) !== fs.statSync(localBaselineExe).size) {
      throw new Error(`线上历史安装包 v${baseline} 大小与本地不一致`);
    }
    const baselineBlockResponse = await expectResponse(`${BASE_URL}/ychelper-setup-${baseline}.exe.blockmap?verify=${Date.now()}`, { cache: 'no-store' }, 200, `历史 blockmap v${baseline}`);
    const baselineBlockBuffer = Buffer.from(await baselineBlockResponse.arrayBuffer());
    if (!baselineBlockBuffer.equals(fs.readFileSync(localBaselineBlockmap))) {
      throw new Error(`线上历史 blockmap v${baseline} 与本地不一致`);
    }
    const check = await expectResponse(`${BASE_URL}/api/update/full-check?version=${encodeURIComponent(baseline)}`, { cache: 'no-store' }, 200, '跨版本更新检测');
    const data = await check.json();
    if (!data.needUpdate || data.version !== version || !data.downloadUrl || !data.sha512 || !data.size || !data.changelog) {
      throw new Error(`v${baseline} 跨版本检测元数据不完整或未指向 v${version}`);
    }
    if (!data.changelog.includes('自动更新') || /�|Ã|â€|åº—/.test(data.changelog)) {
      throw new Error('完整更新说明不是有效的 UTF-8 中文内容');
    }

    const loginCheck = await expectResponse(`${BASE_URL}/api/update/login-check?version=${encodeURIComponent(baseline)}`, { cache: 'no-store' }, 200, '登录页更新检测');
    const loginData = await loginCheck.json();
    if (!loginData.needUpdate || loginData.version !== version || loginData.downloadUrl !== data.downloadUrl
      || loginData.sha512 !== data.sha512 || Number(loginData.size) !== Number(data.size)
      || loginData.changelog !== data.changelog) {
      throw new Error('登录页更新检测与完整更新检测元数据不一致');
    }
  }

  console.log(`[线上发布校验通过] v${version}`);
  console.log('  ✓ latest.yml、exe、blockmap 与本机构建结果一致');
  console.log('  ✓ 安装包支持 HTTP Range 断点续传');
  if (baseline) {
    console.log(`  ✓ v${baseline} 可直接检测并升级到 v${version}`);
    console.log('  ✓ full-check / login-check 的版本、大小、SHA-512 和 UTF-8 更新内容一致');
  }
}

main().catch(err => {
  console.error(`[线上发布校验失败] ${err.message}`);
  process.exit(1);
});
