'use strict';

const fs = require('fs');
const path = require('path');

const DIFFERENTIAL_UPDATE_MODE = '差分更新';
const FULL_UPDATE_MODE = '完整更新';
const DIFFERENTIAL_FALLBACK_MESSAGE = '差分更新不可用，已自动切换完整安装包';
const MISSING_DIFFERENTIAL_BASE_MESSAGE = '本机缺少差分基础文件，已直接使用完整安装包';
const DIFFERENTIAL_FALLBACK_PATTERN = /cannot download differentially[\s\S]*fallback to full download/i;
const CURRENT_INSTALLER_FILE_NAME = 'installer.exe';

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

function hasUsableDifferentialBase(cacheDir) {
  if (typeof cacheDir !== 'string' || !cacheDir.trim()) return false;
  try {
    const stat = fs.statSync(path.join(cacheDir, CURRENT_INSTALLER_FILE_NAME));
    return stat.isFile() && stat.size > 0;
  } catch (_) {
    return false;
  }
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
  hasUsableDifferentialBase
};
