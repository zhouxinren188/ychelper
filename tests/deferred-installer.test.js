const assert = require('assert');
const { EventEmitter } = require('events');
const path = require('path');
const {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  buildDeferredInstallerCommand,
  launchInstallerAfterApplicationExit,
  validateExecutableFile
} = require('../src/js/deferredInstaller');

const installerPath = 'C:\\Users\\Test User\\Downloads\\云仓助手 & 安装.exe';
const applicationPath = 'C:\\Users\\Test User\\Programs\\cloud-warehouse-assistant\\云仓助手.exe';
const powershellPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const existingFileSystem = {
  statSync() {
    return { isFile: () => true };
  }
};

assert.strictEqual(
  validateExecutableFile(installerPath, 'installer', existingFileSystem),
  path.normalize(installerPath)
);
assert.throws(
  () => validateExecutableFile('setup.exe', 'installer', existingFileSystem),
  /path must be absolute/
);
assert.throws(
  () => validateExecutableFile('C:\\Temp\\setup.zip', 'installer', existingFileSystem),
  /must be an exe file/
);

const encodedCommand = buildDeferredInstallerCommand({
  installerPath,
  applicationPath,
  parentPid: 24680
});
const command = Buffer.from(encodedCommand, 'base64').toString('utf16le');
assert.match(command, /\$parentPid=24680/);
assert.match(command, new RegExp(`AddMilliseconds\\(${DEFAULT_WAIT_TIMEOUT_MS}\\)`));
assert.match(command, new RegExp(`Start-Sleep -Milliseconds ${DEFAULT_POLL_INTERVAL_MS}`));
assert.match(command, /Test-YcHelperRunning/);
assert.match(command, /Start-Process -FilePath \$installer/);
assert(!command.includes(installerPath), 'installer path must not be interpolated into PowerShell source');
assert(!command.includes(applicationPath), 'application path must not be interpolated into PowerShell source');
assert(command.indexOf('if (Test-YcHelperRunning) { exit 2 }') < command.indexOf('Start-Process -FilePath $installer'));

let spawned = null;
let unrefCalled = false;
const fakeSpawn = (file, args, options) => {
  spawned = { file, args, options };
  const child = new EventEmitter();
  child.unref = () => { unrefCalled = true; };
  process.nextTick(() => child.emit('spawn'));
  return child;
};

(async () => {
  await launchInstallerAfterApplicationExit({
    installerPath,
    applicationPath,
    parentPid: 24680,
    powershellPath,
    fsImpl: existingFileSystem,
    spawnImpl: fakeSpawn
  });

  assert(spawned);
  assert.strictEqual(spawned.file, path.normalize(powershellPath));
  assert.deepStrictEqual(spawned.options, {
    detached: true,
    windowsHide: true,
    stdio: 'ignore'
  });
  assert(spawned.args.includes('-EncodedCommand'));
  assert.strictEqual(spawned.args[spawned.args.indexOf('-EncodedCommand') + 1], encodedCommand);
  assert.strictEqual(unrefCalled, true);

  console.log('deferred-installer tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
