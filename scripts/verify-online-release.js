const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
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
  const latestResponse = await expectResponse(`${BASE_URL}/latest.yml?verify=${Date.now()}`, { cache: 'no-store' }, 200, 'latest.yml');
  const latest = await latestResponse.text();
  if (!latest.includes(`version: ${version}`) || !latest.includes(exeName)) {
    throw new Error('latest.yml 未指向目标版本');
  }

  const exeHead = await expectResponse(`${BASE_URL}/${exeName}`, { method: 'HEAD', cache: 'no-store' }, 200, '最新版安装包');
  const blockHead = await expectResponse(`${BASE_URL}/${exeName}.blockmap`, { method: 'HEAD', cache: 'no-store' }, 200, '最新版 blockmap');
  if (Number(exeHead.headers.get('content-length') || 0) <= 0) throw new Error('最新版安装包大小无效');
  if (Number(blockHead.headers.get('content-length') || 0) <= 0) throw new Error('最新版 blockmap 大小无效');

  const range = await expectResponse(`${BASE_URL}/${exeName}`, {
    headers: { Range: 'bytes=0-1023' },
    cache: 'no-store'
  }, 206, '断点续传');
  if (!/^bytes 0-1023\/\d+$/.test(range.headers.get('content-range') || '')) {
    throw new Error('断点续传 Content-Range 无效');
  }
  await range.arrayBuffer();

  if (baseline) {
    await expectResponse(`${BASE_URL}/ychelper-setup-${baseline}.exe`, { method: 'HEAD' }, 200, `历史安装包 v${baseline}`);
    await expectResponse(`${BASE_URL}/ychelper-setup-${baseline}.exe.blockmap`, { method: 'HEAD' }, 200, `历史 blockmap v${baseline}`);
    const check = await expectResponse(`${BASE_URL}/api/update/full-check?version=${encodeURIComponent(baseline)}`, { cache: 'no-store' }, 200, '跨版本更新检测');
    const data = await check.json();
    if (!data.needUpdate || data.version !== version || !data.downloadUrl || !data.sha512 || !data.size || !data.changelog) {
      throw new Error(`v${baseline} 跨版本检测元数据不完整或未指向 v${version}`);
    }
  }

  console.log(`[线上发布校验通过] v${version}`);
  console.log('  ✓ latest.yml、exe、blockmap 均可访问');
  console.log('  ✓ 安装包支持 HTTP Range 断点续传');
  if (baseline) console.log(`  ✓ v${baseline} 可直接检测并升级到 v${version}`);
}

main().catch(err => {
  console.error(`[线上发布校验失败] ${err.message}`);
  process.exit(1);
});
