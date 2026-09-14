'use strict';

const SHOP_STOCK_COLUMNS = [
  'shopNo',
  'shopName',
  'spName',
  'deptName',
  'stockWay',
  'warehouseName',
  'shopGoodsNo',
  'shopGoodsName',
  'sellerGoodsSign',
  'spGoodsNo',
  'goodsNo',
  'stockNum',
  'isvGoodsNo',
  'occupyNum',
  'sellerName',
  'vmiStockNum',
  'updateUser'
];

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeSkus(skus) {
  return [...new Set((Array.isArray(skus) ? skus : [])
    .map(normalizeText)
    .filter(Boolean))];
}

function normalizeShopId(value) {
  const normalized = normalizeText(value);
  const shopNoMatch = normalized.match(/^CSP00(\d+)$/i);
  return shopNoMatch ? shopNoMatch[1] : normalized;
}

function buildShopStockAoData(start = 0, length = 100, echo = 1) {
  const safeStart = Math.max(0, Number.parseInt(start, 10) || 0);
  const safeLength = Math.min(100, Math.max(1, Number.parseInt(length, 10) || 100));
  const data = [
    { name: 'sEcho', value: Math.max(1, Number.parseInt(echo, 10) || 1) },
    { name: 'iColumns', value: SHOP_STOCK_COLUMNS.length },
    { name: 'sColumns', value: SHOP_STOCK_COLUMNS.map(() => '').join(',') },
    { name: 'iDisplayStart', value: safeStart },
    { name: 'iDisplayLength', value: safeLength }
  ];

  SHOP_STOCK_COLUMNS.forEach((column, index) => {
    data.push({ name: `mDataProp_${index}`, value: column });
    data.push({ name: `bSortable_${index}`, value: true });
  });

  data.push(
    { name: 'iSortCol_0', value: 1 },
    { name: 'sSortDir_0', value: 'desc' },
    { name: 'iSortCol_1', value: 5 },
    { name: 'sSortDir_1', value: 'asc' },
    { name: 'iSortCol_2', value: 7 },
    { name: 'sSortDir_2', value: 'asc' },
    { name: 'iSortingCols', value: 3 }
  );

  return JSON.stringify(data);
}

function buildShopStockForm({ csrfToken, sellerId, skus, start = 0, length = 100, echo = 1 }) {
  const params = new URLSearchParams();
  params.set('csrfToken', normalizeText(csrfToken));
  params.set('sellerId', normalizeText(sellerId));
  params.set('deptId', '');
  params.set('shopId', '');
  params.set('stockWay', '');
  params.set('warehouseId', '');
  params.set('spId', '');
  params.set('goodsNo', '');
  params.set('shopGoodsNo', '');
  params.set('sellerGoodsSign', normalizeSkus(skus).join(','));
  params.set('isvGoodsNo', '');
  params.set('shopGoodsName', '');
  params.set('stockMaxNum', '');
  params.set('stockMinNum', '');
  params.set('aoData', buildShopStockAoData(start, length, echo));
  return params;
}

function summarizeShopStockRows({ skus, rows, sellerId, deptId, shopId, warehouseNo }) {
  const normalizedSkus = normalizeSkus(skus);
  const requested = new Set(normalizedSkus);
  const expectedSellerId = normalizeText(sellerId);
  const expectedDeptId = normalizeText(deptId);
  const expectedShopId = normalizeShopId(shopId);
  const expectedWarehouseNo = normalizeText(warehouseNo);
  const totals = new Map();
  const matchedSkus = new Set();
  let latestUpdateTime = '';

  for (const row of Array.isArray(rows) ? rows : []) {
    const sku = normalizeText(row && row.sellerGoodsSign);
    if (!requested.has(sku)) continue;
    if (expectedSellerId && normalizeText(row.sellerId) !== expectedSellerId) continue;
    if (expectedDeptId && normalizeText(row.deptId) !== expectedDeptId) continue;
    if (expectedShopId && normalizeShopId(row.shopId) !== expectedShopId) continue;
    if (expectedWarehouseNo && normalizeText(row.warehouseNo) !== expectedWarehouseNo) continue;

    matchedSkus.add(sku);
    const stockNum = Number.parseFloat(row.stockNum);
    totals.set(sku, (totals.get(sku) || 0) + (Number.isFinite(stockNum) ? stockNum : 0));
    const updateTime = normalizeText(row.updateTime);
    if (updateTime && updateTime > latestUpdateTime) latestUpdateTime = updateTime;
  }

  const inStockSkus = [];
  const zeroStockSkus = [];
  const missingSkus = [];
  for (const sku of normalizedSkus) {
    if (!matchedSkus.has(sku)) {
      missingSkus.push(sku);
    } else if ((totals.get(sku) || 0) > 0) {
      inStockSkus.push(sku);
    } else {
      zeroStockSkus.push(sku);
    }
  }

  return {
    ready: normalizedSkus.length > 0 && inStockSkus.length === normalizedSkus.length,
    total: normalizedSkus.length,
    inStockCount: inStockSkus.length,
    zeroStockCount: zeroStockSkus.length,
    missingCount: missingSkus.length,
    inStockSkus,
    zeroStockSkus,
    missingSkus,
    latestUpdateTime
  };
}

module.exports = {
  SHOP_STOCK_COLUMNS,
  buildShopStockAoData,
  buildShopStockForm,
  normalizeShopId,
  normalizeSkus,
  summarizeShopStockRows
};
