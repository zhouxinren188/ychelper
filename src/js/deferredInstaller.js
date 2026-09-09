const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_LAUNCH_ATTEMPTS = 15;
const DEFAULT_RETRY_INTERVAL_MS = 1000;
const DEFAULT_INSTALLER_ARGS = Object.freeze(['--updated', '--force-run']);

function assertPositiveInteger(value, fieldName) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
}

function validateExecutableFile(filePath, label, fsImpl = fs) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new Error(`${label} path must be absolute`);
  }
  if (path.extname(filePath).toLowerCase() !== '.exe') {
    throw new Error(`${label} must be an exe file`);
  }

  let stat;
  try {
    stat = fsImpl.statSync(filePath);
  } catch (_) {
    throw new Error(`${label} file does not exist`);
  }
  if (!stat || typeof stat.isFile !== 'function' || !stat.isFile()) {
    throw new Error(`${label} path is not a file`);
  }
  return path.normalize(filePath);
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function spawnDetachedInstaller(installerPath, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(installerPath, [...DEFAULT_INSTALLER_ARGS], {
        detached: true,
        windowsHide: false,
        stdio: 'ignore'
      });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    child.once('error', error => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}

async function launchInstallerBeforeApplicationExit({
  installerPath,
  launchAttempts = DEFAULT_LAUNCH_ATTEMPTS,
  retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS,
  fsImpl = fs,
  spawnImpl = spawn,
  delayImpl = delay
}) {
  assertPositiveInteger(launchAttempts, 'launchAttempts');
  assertPositiveInteger(retryIntervalMs, 'retryIntervalMs');

  const safeInstallerPath = validateExecutableFile(installerPath, 'installer', fsImpl);
  let lastError = null;

  for (let attempt = 1; attempt <= launchAttempts; attempt += 1) {
    try {
      await spawnDetachedInstaller(safeInstallerPath, spawnImpl);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < launchAttempts) {
        await delayImpl(retryIntervalMs);
      }
    }
  }

  const detail = lastError && lastError.message ? `: ${lastError.message}` : '';
  throw new Error(`installer failed to start after ${launchAttempts} attempts${detail}`);
}

module.exports = {
  DEFAULT_INSTALLER_ARGS,
  DEFAULT_LAUNCH_ATTEMPTS,
  DEFAULT_RETRY_INTERVAL_MS,
  launchInstallerAfterApplicationExit: launchInstallerBeforeApplicationExit,
  launchInstallerBeforeApplicationExit,
  spawnDetachedInstaller,
  validateExecutableFile
};
