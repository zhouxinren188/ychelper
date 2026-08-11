const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

const HOT_VERSION_SLOT_LENGTH = 22;
const HOT_VERSION_SLOT_PATTERN = /const HOT_UPDATE_VERSION = ' {22}'\.trim\(\);/;
const ASAR_LOGIN_PATH = 'src\\login.html';

function buildHotUpdateLogin({ rootDir, version }) {
  const loginPath = path.join(rootDir, 'src', 'login.html');
  const asarPath = path.join(rootDir, 'dist', 'win-unpacked', 'resources', 'app.asar');
  if (!fs.existsSync(loginPath)) throw new Error(`登录页不存在: ${loginPath}`);
  if (!fs.existsSync(asarPath)) {
    throw new Error(`缺少完整基线 app.asar，请先构建当前完整版本: ${asarPath}`);
  }
  const sourcePackage = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const baselinePackage = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'));
  if (baselinePackage.version !== sourcePackage.version) {
    throw new Error(
      `完整基线 app.asar 版本 ${baselinePackage.version} 与 package.json ${sourcePackage.version} 不一致`
    );
  }
  if (!version.startsWith(`${sourcePackage.version}.`)) {
    throw new Error(`热更新 ${version} 不属于完整基线 ${sourcePackage.version}`);
  }
  if (Buffer.byteLength(version, 'utf8') > HOT_VERSION_SLOT_LENGTH) {
    throw new Error(`热更新版本号过长，最多 ${HOT_VERSION_SLOT_LENGTH} 字节`);
  }

  const source = fs.readFileSync(loginPath, 'utf8');
  const matches = source.match(new RegExp(HOT_VERSION_SLOT_PATTERN.source, 'g')) || [];
  if (matches.length !== 1) {
    throw new Error(`登录页必须包含且仅包含一个 ${HOT_VERSION_SLOT_LENGTH} 字节热更新版本槽`);
  }
  const paddedVersion = version.padEnd(HOT_VERSION_SLOT_LENGTH, ' ');
  const rendered = source.replace(
    HOT_VERSION_SLOT_PATTERN,
    `const HOT_UPDATE_VERSION = '${paddedVersion}'.trim();`
  );
  const renderedBuffer = Buffer.from(rendered, 'utf8');
  const baseline = asar.statFile(asarPath, ASAR_LOGIN_PATH);
  if (!baseline.unpacked || !Number.isSafeInteger(baseline.size) || baseline.size <= 0) {
    throw new Error('完整基线中的登录页 ASAR 元数据无效');
  }
  if (renderedBuffer.length > baseline.size) {
    throw new Error(
      `登录页 ${renderedBuffer.length} 字节超过 ASAR 基线 ${baseline.size} 字节，必须发布新的完整版本`
    );
  }

  return {
    baselineSize: baseline.size,
    buffer: Buffer.concat([
      renderedBuffer,
      Buffer.alloc(baseline.size - renderedBuffer.length, 0x20)
    ])
  };
}

module.exports = {
  HOT_VERSION_SLOT_LENGTH,
  buildHotUpdateLogin
};
