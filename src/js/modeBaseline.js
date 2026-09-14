const MODE_BASELINE_REVISION = 1;

const MODE_BASELINE = [
  {
    name: '入仓打标（AB仓）',
    config: {
      importShopProduct: true,
      enableShopProduct: true,
      enableMasterData: true,
      disableMasterData: false,
      inventoryRatio: true,
      inventoryRatioValue: '100',
      jdLabel: true,
      enablePurchase: true,
      disableShopProduct: false,
      logistics: true,
      cancelJdLabel: false,
      inventoryCheckBeforeJdLabel: true,
      logLength: '210',
      logWidth: '150',
      logHeight: '100',
      logWeight: '0.5',
      stepDelay: 10,
      purchaseQty: 10,
      autoAccept: true
    }
  },
  {
    name: '入仓打标',
    config: {
      importShopProduct: true,
      enableShopProduct: true,
      enableMasterData: true,
      disableMasterData: false,
      inventoryRatio: true,
      inventoryRatioValue: '100',
      jdLabel: true,
      enablePurchase: true,
      disableShopProduct: false,
      logistics: true,
      cancelJdLabel: false,
      inventoryCheckBeforeJdLabel: false,
      logLength: '210',
      logWidth: '150',
      logHeight: '100',
      logWeight: '0.5',
      stepDelay: 10,
      purchaseQty: 10,
      autoAccept: true
    }
  },
  {
    name: '打标（仅勾标）',
    config: {
      importShopProduct: false,
      enableShopProduct: false,
      enableMasterData: false,
      disableMasterData: false,
      inventoryRatio: false,
      inventoryRatioValue: '100',
      jdLabel: true,
      enablePurchase: false,
      disableShopProduct: false,
      logistics: false,
      cancelJdLabel: false,
      inventoryCheckBeforeJdLabel: false,
      logLength: '210',
      logWidth: '150',
      logHeight: '100',
      logWeight: '0.5',
      stepDelay: 60,
      purchaseQty: 10,
      autoAccept: true
    }
  },
  {
    name: '添加库存',
    config: {
      importShopProduct: false,
      enableShopProduct: false,
      enableMasterData: false,
      disableMasterData: false,
      inventoryRatio: false,
      inventoryRatioValue: '100',
      jdLabel: false,
      enablePurchase: true,
      disableShopProduct: false,
      logistics: false,
      cancelJdLabel: false,
      inventoryCheckBeforeJdLabel: false,
      logLength: '210',
      logWidth: '150',
      logHeight: '100',
      logWeight: '0.5',
      stepDelay: 60,
      purchaseQty: 10,
      autoAccept: true
    }
  },
  {
    name: '下标（取消京配）',
    config: {
      importShopProduct: false,
      enableShopProduct: false,
      enableMasterData: false,
      disableMasterData: false,
      inventoryRatio: false,
      inventoryRatioValue: '100',
      jdLabel: false,
      enablePurchase: false,
      disableShopProduct: false,
      logistics: false,
      cancelJdLabel: true,
      inventoryCheckBeforeJdLabel: false,
      logLength: '210',
      logWidth: '150',
      logHeight: '100',
      logWeight: '0.5',
      stepDelay: 10,
      purchaseQty: 10,
      autoAccept: true
    }
  },
  {
    name: '清库下标（不含停用）',
    config: {
      importShopProduct: false,
      enableShopProduct: false,
      enableMasterData: false,
      disableMasterData: false,
      inventoryRatio: true,
      inventoryRatioValue: '0',
      jdLabel: false,
      enablePurchase: false,
      disableShopProduct: false,
      logistics: false,
      cancelJdLabel: true,
      inventoryCheckBeforeJdLabel: false,
      logLength: '210',
      logWidth: '150',
      logHeight: '100',
      logWeight: '0.5',
      stepDelay: 60,
      purchaseQty: 10,
      autoAccept: true
    }
  }
];

function cloneModeBaseline() {
  return MODE_BASELINE.map(mode => ({
    name: mode.name,
    config: { ...mode.config }
  }));
}

function applyModeBaselineMigration(data) {
  if (!data || typeof data !== 'object') {
    throw new TypeError('本地配置数据无效');
  }
  if ((Number(data.modeBaselineRevision) || 0) >= MODE_BASELINE_REVISION) {
    return false;
  }

  data.modes = cloneModeBaseline();
  data.modeBaselineRevision = MODE_BASELINE_REVISION;
  return true;
}

module.exports = {
  MODE_BASELINE_REVISION,
  MODE_BASELINE,
  cloneModeBaseline,
  applyModeBaselineMigration
};
