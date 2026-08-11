'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const DIFFERENTIAL_UPDATE_MODE = '差分更新';
const FULL_UPDATE_MODE = '完整更新';
const DIFFERENTIAL_FALLBACK_MESSAGE = '差分更新不可用，已自动切换完整安装包';
const MISSING_DIFFERENTIAL_BASE_MESSAGE = '本机差分基础缓存不完整或版本不匹配，已直接使用完整安装包';
const DIFFERENTIAL_FALLBACK_PATTERN = /cannot download differentially[\s\S]*fallback to full download/i;
const CURRENT_INSTALLER_FILE_NAME = 'installer.exe';
const CURRENT_BLOCKMAP_FILE_NAME = 'current.blockmap';
const PENDING_DIRECTORY_NAME = 'pending';
const UPDATE_INFO_FILE_NAME = 'update-info.json';
const INSTALLER_FILE_PATTERN = /^ychelper-setup-(\d+\.\d+\.\d+(?:\.\d+)?)\.exe$/;
const SHA512_BASE64_PATTERN = /^[A-Za-z0-9+/]{86}==$/;

function clampPercent(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function formatLogValue(value) {
  if (value instanceof Error) return value.stack || value.message || String(value);
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch (_) {
    try {
      return String(value);
    } catch (_) {
      return '[无法格式化的更新日志]';
    }
  }
}

function getBlockmapInstallerSize(blockmapPath) {
  const compressed = fs.readFileSync(blockmapPath);
  const blockmap = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
  if (!blockmap || !Array.isArray(blockmap.files) || blockmap.files.length === 0) {
    throw new Error('blockmap files are missing');
  }

  let expectedSize = 0;
  for (const file of blockmap.files) {
    const offset = Number(file && file.offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Array.isArray(file.sizes)) {
      throw new Error('blockmap file entry is invalid');
    }
    let fileSize = 0;
    for (const rawSize of file.sizes) {
      const size = Number(rawSize);
      if (!Number.isSafeInteger(size) || size <= 0) {
        throw new Error('blockmap chunk size is invalid');
      }
      fileSize += size;
      if (!Number.isSafeInteger(fileSize)) throw new Error('blockmap size is unsafe');
    }
    expectedSize = Math.max(expectedSize, offset + fileSize);
  }
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
    throw new Error('blockmap installer size is invalid');
  }
  return expectedSize;
}

function isDifferentialBasePairUsable(cacheDir) {
  if (typeof cacheDir !== 'string' || !cacheDir.trim()) return false;
  try {
    const installerPath = path.join(cacheDir, CURRENT_INSTALLER_FILE_NAME);
    const blockmapPath = path.join(cacheDir, CURRENT_BLOCKMAP_FILE_NAME);
    const stat = fs.statSync(installerPath);
    return stat.isFile()
      && stat.size > 0
      && stat.size === getBlockmapInstallerSize(blockmapPath);
  } catch (_) {
    return false;
  }
}

function computeFileSha512Sync(filePath) {
  const hash = crypto.createHash('sha512');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('base64');
}

function getRuntimeAppVersion() {
  try {
    const electron = require('electron');
    return electron && electron.app && typeof electron.app.getVersion === 'function'
      ? String(electron.app.getVersion())
      : '';
  } catch (_) {
    return '';
  }
}

function repairDifferentialBaseFromPendingUpdateSync(cacheDir, currentVersion) {
  if (typeof cacheDir !== 'string' || !cacheDir.trim()) {
    return { repaired: false, reason: 'invalid-cache-directory' };
  }
  if (typeof currentVersion !== 'string' || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(currentVersion)) {
    return { repaired: false, reason: 'invalid-current-version' };
  }

  const pendingDir = path.join(cacheDir, PENDING_DIRECTORY_NAME);
  const updateInfoPath = path.join(pendingDir, UPDATE_INFO_FILE_NAME);
  try {
    const infoStat = fs.statSync(updateInfoPath);
    if (!infoStat.isFile() || infoStat.size <= 0 || infoStat.size > 64 * 1024) {
      return { repaired: false, reason: 'invalid-update-info' };
    }
    const updateInfo = JSON.parse(fs.readFileSync(updateInfoPath, 'utf8'));
    const fileName = typeof updateInfo.fileName === 'string' ? path.basename(updateInfo.fileName) : '';
    const fileMatch = INSTALLER_FILE_PATTERN.exec(fileName);
    if (!fileMatch || fileMatch[1] !== currentVersion || fileName !== updateInfo.fileName) {
      return { repaired: false, reason: 'pending-version-mismatch' };
    }
    if (!SHA512_BASE64_PATTERN.test(String(updateInfo.sha512 || ''))) {
      return { repaired: false, reason: 'invalid-pending-checksum' };
    }

    const pendingInstallerPath = path.join(pendingDir, fileName);
    const pendingBlockmapPath = path.join(pendingDir, CURRENT_BLOCKMAP_FILE_NAME);
    const pendingInstallerStat = fs.statSync(pendingInstallerPath);
    if (!pendingInstallerStat.isFile()
      || pendingInstallerStat.size <= 0
      || pendingInstallerStat.size !== getBlockmapInstallerSize(pendingBlockmapPath)
      || computeFileSha512Sync(pendingInstallerPath) !== updateInfo.sha512) {
      return { repaired: false, reason: 'invalid-pending-pair' };
    }

    const installerPath = path.join(cacheDir, CURRENT_INSTALLER_FILE_NAME);
    const blockmapPath = path.join(cacheDir, CURRENT_BLOCKMAP_FILE_NAME);
    if (isDifferentialBasePairUsable(cacheDir)
      && computeFileSha512Sync(installerPath) === updateInfo.sha512
      && zlib.gunzipSync(fs.readFileSync(blockmapPath)).equals(
        zlib.gunzipSync(fs.readFileSync(pendingBlockmapPath))
      )) {
      return { repaired: false, reason: 'base-already-current' };
    }

    const suffix = `.repair-${process.pid}-${Date.now()}`;
    const installerTempPath = `${installerPath}${suffix}`;
    const blockmapTempPath = `${blockmapPath}${suffix}`;
    try {
      fs.copyFileSync(pendingInstallerPath, installerTempPath);
      fs.copyFileSync(pendingBlockmapPath, blockmapTempPath);
      fs.rmSync(installerPath, { force: true });
      fs.renameSync(installerTempPath, installerPath);
      fs.rmSync(blockmapPath, { force: true });
      fs.renameSync(blockmapTempPath, blockmapPath);
    } finally {
      fs.rmSync(installerTempPath, { force: true });
      fs.rmSync(blockmapTempPath, { force: true });
    }

    if (!isDifferentialBasePairUsable(cacheDir)
      || computeFileSha512Sync(installerPath) !== updateInfo.sha512) {
      return { repaired: false, reason: 'repair-validation-failed' };
    }
    return { repaired: true, version: currentVersion, size: pendingInstallerStat.size };
  } catch (error) {
    return { repaired: false, reason: 'repair-failed', error };
  }
}

function hasUsableDifferentialBase(cacheDir, currentVersion = getRuntimeAppVersion()) {
  if (currentVersion) {
    const repairResult = repairDifferentialBaseFromPendingUpdateSync(cacheDir, currentVersion);
    if (repairResult.repaired) {
      console.log(`[自动更新] 已修复 v${repairResult.version} 差分基础缓存 (${repairResult.size} bytes)`);
    } else if (repairResult.reason === 'repair-failed') {
      console.warn('[自动更新] 差分基础缓存修复失败，将使用完整安装包:', repairResult.error?.message || 'unknown error');
    }
  }
  return isDifferentialBasePairUsable(cacheDir);
}

async function repairDifferentialBaseFromPendingUpdate(cacheDir, currentVersion) {
  return repairDifferentialBaseFromPendingUpdateSync(cacheDir, currentVersion);
}

function createUpdateDownloadState(options = {}) {
  const onFallback = typeof options.onFallback === 'function' ? options.onFallback : () => {};
  const resetDropThreshold = Math.max(5, Number(options.resetDropThreshold) || 10);
  const resetMinimumPreviousPercent = Math.max(10, Number(options.resetMinimumPreviousPercent) || 20);
  let mode = DIFFERENTIAL_UPDATE_MODE;
  let lastPercent = 0;
  let fallbackNotified = false;

  function reset(nextMode = DIFFERENTIAL_UPDATE_MODE) {
    mode = nextMode === FULL_UPDATE_MODE ? FULL_UPDATE_MODE : DIFFERENTIAL_UPDATE_MODE;
    lastPercent = 0;
    fallbackNotified = mode === FULL_UPDATE_MODE;
    return mode;
  }

  function switchToFullUpdate(source, detail = '') {
    const changed = mode !== FULL_UPDATE_MODE;
    mode = FULL_UPDATE_MODE;
    lastPercent = 0;
    if (!fallbackNotified) {
      fallbackNotified = true;
      try {
        onFallback({
          mode,
          source,
          detail,
          message: DIFFERENTIAL_FALLBACK_MESSAGE
        });
      } catch (_) {
        // 更新状态提示失败不得反过来中断 electron-updater 的全量回退。
      }
    }
    return changed;
  }

  function inspectUpdaterLog(...args) {
    const text = args.map(formatLogValue).join(' ');
    if (!DIFFERENTIAL_FALLBACK_PATTERN.test(text)) return false;
    switchToFullUpdate('updater-log', text);
    return true;
  }

  function handleProgress(progress = {}) {
    const percent = clampPercent(progress.percent);
    const droppedEnough = lastPercent >= resetMinimumPreviousPercent
      && percent <= lastPercent - resetDropThreshold;

    // electron-updater 在 Windows 上会吞掉差分异常并直接继续全量下载。
    // 日志文本未来若发生变化，明显的百分比重置仍可作为安全兜底。
    if (mode === DIFFERENTIAL_UPDATE_MODE && droppedEnough) {
      switchToFullUpdate('progress-reset', `${lastPercent}% -> ${percent}%`);
    }

    lastPercent = percent;
    return {
      ...progress,
      mode,
      percent
    };
  }

  return {
    getMode: () => mode,
    handleProgress,
    inspectUpdaterLog,
    reset,
    switchToFullUpdate
  };
}

module.exports = {
  DIFFERENTIAL_FALLBACK_MESSAGE,
  DIFFERENTIAL_UPDATE_MODE,
  FULL_UPDATE_MODE,
  MISSING_DIFFERENTIAL_BASE_MESSAGE,
  createUpdateDownloadState,
  getBlockmapInstallerSize,
  hasUsableDifferentialBase,
  repairDifferentialBaseFromPendingUpdate,
  repairDifferentialBaseFromPendingUpdateSync
};
