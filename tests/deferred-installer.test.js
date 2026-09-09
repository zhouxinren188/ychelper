const assert = require('assert');
const { EventEmitter } = require('events');
const path = require('path');
const {
  DEFAULT_INSTALLER_ARGS,
  DEFAULT_LAUNCH_ATTEMPTS,
  DEFAULT_RETRY_INTERVAL_MS,
  launchInstallerAfterApplicationExit,
  launchInstallerBeforeApplicationExit,
  validateExecutableFile
} = require('../src/js/deferredInstaller');

const installerPath = 'C:\\Users\\Test User\\Downloads\\云仓助手 & 安装.exe';
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
assert.strictEqual(
  launchInstallerAfterApplicationExit,
  launchInstallerBeforeApplicationExit,
  'v1.0.83 hot bridge must preserve the function name used by the old main process'
);

function createChild(eventName, error = null) {
  const child = new EventEmitter();
  child.unrefCalled = false;
  child.unref = () => { child.unrefCalled = true; };
  process.nextTick(() => child.emit(eventName, error));
  return child;
}

(async () => {
  const spawnCalls = [];
  let launchedChild = null;
  const fakeSpawn = (file, args, options) => {
    spawnCalls.push({ file, args, options });
    if (spawnCalls.length === 1) {
      return createChild('error', new Error('temporary file lock'));
    }
    launchedChild = createChild('spawn');
    return launchedChild;
  };
  const delays = [];

  await launchInstallerBeforeApplicationExit({
    installerPath,
    launchAttempts: 2,
    retryIntervalMs: 25,
    fsImpl: existingFileSystem,
    spawnImpl: fakeSpawn,
    delayImpl: async milliseconds => { delays.push(milliseconds); }
  });

  assert.strictEqual(spawnCalls.length, 2, 'a transient launch error must be retried');
  assert.deepStrictEqual(delays, [25]);
  assert.deepStrictEqual(spawnCalls[1], {
    file: path.normalize(installerPath),
    args: [...DEFAULT_INSTALLER_ARGS],
    options: {
      detached: true,
      windowsHide: false,
      stdio: 'ignore'
    }
  });
  assert.strictEqual(launchedChild.unrefCalled, true);
  assert.strictEqual(DEFAULT_LAUNCH_ATTEMPTS, 15);
  assert.strictEqual(DEFAULT_RETRY_INTERVAL_MS, 1000);

  let attempts = 0;
  await assert.rejects(
    launchInstallerBeforeApplicationExit({
      installerPath,
      launchAttempts: 3,
      retryIntervalMs: 10,
      fsImpl: existingFileSystem,
      spawnImpl: () => {
        attempts += 1;
        return createChild('error', new Error('still locked'));
      },
      delayImpl: async () => {}
    }),
    /failed to start after 3 attempts: still locked/
  );
  assert.strictEqual(attempts, 3);

  console.log('deferred-installer tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
