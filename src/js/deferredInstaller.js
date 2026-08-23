const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_WAIT_TIMEOUT_MS = 90000;
const DEFAULT_POLL_INTERVAL_MS = 200;

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

function buildDeferredInstallerCommand({
  installerPath,
  applicationPath,
  parentPid,
  waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
}) {
  assertPositiveInteger(parentPid, 'parentPid');
  assertPositiveInteger(waitTimeoutMs, 'waitTimeoutMs');
  assertPositiveInteger(pollIntervalMs, 'pollIntervalMs');

  const installerBase64 = Buffer.from(installerPath, 'utf8').toString('base64');
  const applicationBase64 = Buffer.from(applicationPath, 'utf8').toString('base64');
  const script = [
    "$ErrorActionPreference='Stop'",
    `$installer=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${installerBase64}'))`,
    `$application=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${applicationBase64}'))`,
    `$parentPid=${parentPid}`,
    `$deadline=(Get-Date).AddMilliseconds(${waitTimeoutMs})`,
    'function Test-YcHelperRunning {',
    '  if (Get-Process -Id $parentPid -ErrorAction SilentlyContinue) { return $true }',
    '  $match=Get-Process -ErrorAction SilentlyContinue | Where-Object {',
    '    try { $_.Path -and [string]::Equals([IO.Path]::GetFullPath($_.Path),$application,[StringComparison]::OrdinalIgnoreCase) } catch { $false }',
    '  } | Select-Object -First 1',
    '  return $null -ne $match',
    '}',
    `while ((Test-YcHelperRunning) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds ${pollIntervalMs} }`,
    'if (Test-YcHelperRunning) { exit 2 }',
    'Start-Sleep -Milliseconds 500',
    'Start-Process -FilePath $installer'
  ].join('\r\n');

  return Buffer.from(script, 'utf16le').toString('base64');
}

function launchInstallerAfterApplicationExit({
  installerPath,
  applicationPath,
  parentPid = process.pid,
  waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  powershellPath = path.join(
    process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  ),
  fsImpl = fs,
  spawnImpl = spawn
}) {
  const safeInstallerPath = validateExecutableFile(installerPath, 'installer', fsImpl);
  const safeApplicationPath = validateExecutableFile(applicationPath, 'application', fsImpl);
  const safePowerShellPath = validateExecutableFile(powershellPath, 'PowerShell', fsImpl);
  const encodedCommand = buildDeferredInstallerCommand({
    installerPath: safeInstallerPath,
    applicationPath: safeApplicationPath,
    parentPid,
    waitTimeoutMs,
    pollIntervalMs
  });

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(safePowerShellPath, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-EncodedCommand',
        encodedCommand
      ], {
        detached: true,
        windowsHide: true,
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

module.exports = {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  buildDeferredInstallerCommand,
  launchInstallerAfterApplicationExit,
  validateExecutableFile
};
