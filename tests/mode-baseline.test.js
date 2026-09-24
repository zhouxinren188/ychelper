const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  MODE_BASELINE_REVISION,
  cloneModeBaseline,
  applyModeBaselineMigration,
  resolvePurchaseJdLabelPolicy,
  applyPurchaseJdLabelPolicyDefaults
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
assert.strictEqual(userData.modes[0].config.purchaseJdLabelPolicy, 'remove', 'AB仓入仓模式必须默认去除已打标SKU');
assert.strictEqual(userData.modes[1].config.purchaseJdLabelPolicy, 'none', '普通入仓模式必须默认不操作京配状态');
assert.strictEqual(userData.modes[3].config.purchaseJdLabelPolicy, 'none', '添加库存模式必须默认不操作京配状态');
assert.strictEqual(userData.modes[2].config.purchaseJdLabelPolicy, 'none', '未启用采购的模式不得开启采购京配校验');
assert.deepStrictEqual(userData.merchantAccounts, [{ id: 'merchant-1' }], '模式迁移不得改动账号等其他本地数据');

userData.modes.splice(0, 1);
userData.modes.push({ name: '用户升级后新增模式', config: {} });
const changedModes = JSON.parse(JSON.stringify(userData.modes));
assert.strictEqual(applyModeBaselineMigration(userData), false, '已迁移用户后续启动不得再次强制替换');
assert.deepStrictEqual(userData.modes, changedModes, '用户后续新增或删除模式必须永久保留');

const firstClone = cloneModeBaseline();
firstClone[0].config.logLength = '999';
assert.notStrictEqual(cloneModeBaseline()[0].config.logLength, '999', '每次读取基础模式必须返回独立副本');

const customizedModes = {
  modes: [
    { name: '自定义AB', config: { enablePurchase: true, inventoryCheckBeforeJdLabel: true, stepDelay: 37 } },
    { name: '自定义普通入仓', config: { enablePurchase: true, inventoryCheckBeforeJdLabel: false, purchaseQty: 23 } },
    { name: '用户已选择去除', config: { enablePurchase: true, purchaseJdLabelPolicy: 'remove', logLength: '999' } },
    { name: '不采购', config: { enablePurchase: false, jdLabel: true } }
  ]
};
assert.strictEqual(applyPurchaseJdLabelPolicyDefaults(customizedModes), true, '旧模式缺少新字段时必须只补默认值');
assert.strictEqual(customizedModes.modes[0].config.purchaseJdLabelPolicy, 'remove', '开启库存校验的采购模式应去除已打标');
assert.strictEqual(customizedModes.modes[1].config.purchaseJdLabelPolicy, 'none', '其他采购模式应默认不操作');
assert.strictEqual(customizedModes.modes[2].config.purchaseJdLabelPolicy, 'remove', '用户已明确选择的策略必须保留');
assert.strictEqual(customizedModes.modes[3].config.purchaseJdLabelPolicy, 'none', '未采购模式应补为不操作');
assert.strictEqual(customizedModes.modes[0].config.stepDelay, 37, '补字段不得覆盖用户自定义延时');
assert.strictEqual(customizedModes.modes[1].config.purchaseQty, 23, '补字段不得覆盖用户自定义采购数量');
assert.strictEqual(customizedModes.modes[2].config.logLength, '999', '补字段不得覆盖其他自定义配置');
assert.strictEqual(applyPurchaseJdLabelPolicyDefaults(customizedModes), false, '字段已存在时重复启动不得再次修改');
assert.strictEqual(resolvePurchaseJdLabelPolicy({ enablePurchase: true, inventoryCheckBeforeJdLabel: true }), 'remove');
assert.strictEqual(resolvePurchaseJdLabelPolicy({ enablePurchase: true, inventoryCheckBeforeJdLabel: false }), 'none');

assert.match(
  mainSource,
  /if \(dataSchemaVersion < 2\)[\s\S]*快捷模式统一为当前六个基础模式[\s\S]*applyModeBaselineMigration\(data\)[\s\S]*恢复上次活跃的账号ID/,
  '快捷模式迁移必须在应用启动的数据迁移阶段执行'
);
const beforeQuitSource = mainSource.slice(mainSource.indexOf("app.on('before-quit'"));
assert.doesNotMatch(beforeQuitSource, /applyModeBaselineMigration\(data\)/, '退出应用时不得再次执行快捷模式迁移');
assert.match(mainSource, /applyPurchaseJdLabelPolicyDefaults\(data\)[\s\S]*其他自定义配置保持不变/,
  '升级时必须只补采购京配校验字段，不得再次替换用户快捷模式');

console.log('快捷模式一次性基础配置迁移测试通过');
