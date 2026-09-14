const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  MODE_BASELINE_REVISION,
  cloneModeBaseline,
  applyModeBaselineMigration
} = require('../src/js/modeBaseline');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

const expectedNames = [
  '入仓打标（AB仓）',
  '入仓打标',
  '打标（仅勾标）',
  '添加库存',
  '下标（取消京配）',
  '清库下标（不含停用）'
];

const userData = {
  merchantAccounts: [{ id: 'merchant-1' }],
  modes: [{ name: '用户旧模式', config: { jdLabel: true } }]
};
assert.strictEqual(applyModeBaselineMigration(userData), true, '首次升级必须执行模式替换');
assert.strictEqual(userData.modeBaselineRevision, MODE_BASELINE_REVISION, '替换后必须原子记录迁移版本');
assert.deepStrictEqual(userData.modes.map(mode => mode.name), expectedNames, '必须采用指定的六个基础模式及顺序');
assert.strictEqual(userData.modes[0].config.inventoryCheckBeforeJdLabel, true, 'AB仓模式必须开启库存校验');
assert.strictEqual(userData.modes[1].config.inventoryCheckBeforeJdLabel, false, '普通入仓模式不得开启库存校验');
assert.deepStrictEqual(userData.merchantAccounts, [{ id: 'merchant-1' }], '模式迁移不得改动账号等其他本地数据');

userData.modes.splice(0, 1);
userData.modes.push({ name: '用户升级后新增模式', config: {} });
const changedModes = JSON.parse(JSON.stringify(userData.modes));
assert.strictEqual(applyModeBaselineMigration(userData), false, '已迁移用户后续启动不得再次强制替换');
assert.deepStrictEqual(userData.modes, changedModes, '用户后续新增或删除模式必须永久保留');

const firstClone = cloneModeBaseline();
firstClone[0].config.logLength = '999';
assert.notStrictEqual(cloneModeBaseline()[0].config.logLength, '999', '每次读取基础模式必须返回独立副本');

assert.match(
  mainSource,
  /if \(dataSchemaVersion < 2\)[\s\S]*快捷模式统一为当前六个基础模式[\s\S]*applyModeBaselineMigration\(data\)[\s\S]*恢复上次活跃的账号ID/,
  '快捷模式迁移必须在应用启动的数据迁移阶段执行'
);
const beforeQuitSource = mainSource.slice(mainSource.indexOf("app.on('before-quit'"));
assert.doesNotMatch(beforeQuitSource, /applyModeBaselineMigration\(data\)/, '退出应用时不得再次执行快捷模式迁移');

console.log('快捷模式一次性基础配置迁移测试通过');
