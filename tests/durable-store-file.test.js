const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { saveRecoveryGenerations, writeFileDurably } = require('../durable-store-file');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ychelper-durable-store-'));

try {
  const targetPath = path.join(tempRoot, 'config.json');
  writeFileDurably(targetPath, 'first');
  assert.strictEqual(fs.readFileSync(targetPath, 'utf8'), 'first', '首次持久化内容应完整');

  const failingFs = Object.create(fs);
  failingFs.fsyncSync = () => { throw new Error('simulated power-loss boundary'); };
  assert.throws(
    () => writeFileDurably(targetPath, 'incomplete', { fsImpl: failingFs }),
    /simulated power-loss boundary/,
    '落盘失败必须向调用方报告'
  );
  assert.strictEqual(fs.readFileSync(targetPath, 'utf8'), 'first',
    '临时文件未完成落盘时不得替换原配置');
  assert.deepStrictEqual(
    fs.readdirSync(tempRoot).filter(name => name.endsWith('.tmp')),
    [],
    '失败后不得遗留临时文件'
  );

  const latestPath = path.join(tempRoot, 'config.latest');
  const previousPath = path.join(tempRoot, 'config.previous');
  const validateRaw = raw => raw.startsWith('valid:');
  saveRecoveryGenerations({ latestPath, previousPath, raw: 'valid:one', validateRaw });
  saveRecoveryGenerations({ latestPath, previousPath, raw: 'valid:two', validateRaw });
  assert.strictEqual(fs.readFileSync(latestPath, 'utf8'), 'valid:two', '最新快照应更新');
  assert.strictEqual(fs.readFileSync(previousPath, 'utf8'), 'valid:one', '上一代快照应保留');

  fs.writeFileSync(latestPath, '\0\0broken', 'utf8');
  saveRecoveryGenerations({ latestPath, previousPath, raw: 'valid:three', validateRaw });
  assert.strictEqual(fs.readFileSync(latestPath, 'utf8'), 'valid:three', '损坏快照应被新快照替换');
  assert.strictEqual(fs.readFileSync(previousPath, 'utf8'), 'valid:one',
    '损坏快照不得覆盖上一代有效快照');

  console.log('配置安全落盘与双代恢复测试通过');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
