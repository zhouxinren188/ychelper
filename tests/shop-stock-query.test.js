'use strict';

const assert = require('assert');
const {
  SHOP_STOCK_COLUMNS,
  buildShopStockAoData,
  buildShopStockForm,
  normalizeShopId,
  normalizeSkus,
  summarizeShopStockRows
} = require('../src/js/shopStockQuery');

assert.deepStrictEqual(normalizeSkus([' 1001 ', '1002', '1001', '', null]), ['1001', '1002']);
assert.strictEqual(normalizeShopId('CSP0020000541985'), '20000541985');
assert.strictEqual(normalizeShopId('20000541985'), '20000541985');

const aoData = JSON.parse(buildShopStockAoData(100, 100, 2));
assert.strictEqual(aoData.find(item => item.name === 'iColumns').value, 17);
assert.strictEqual(aoData.find(item => item.name === 'iDisplayStart').value, 100);
assert.strictEqual(aoData.find(item => item.name === 'iDisplayLength').value, 100);
assert.strictEqual(aoData.find(item => item.name === 'mDataProp_8').value, 'sellerGoodsSign');
assert.strictEqual(aoData.find(item => item.name === 'mDataProp_11').value, 'stockNum');
assert.strictEqual(SHOP_STOCK_COLUMNS.length, 17);

const form = buildShopStockForm({
  csrfToken: 'csrf-test',
  sellerId: '20000023823',
  skus: ['1001', '1002'],
  start: 0,
  length: 100,
  echo: 1
});
assert.strictEqual(form.get('csrfToken'), 'csrf-test');
assert.strictEqual(form.get('sellerId'), '20000023823');
assert.strictEqual(form.get('sellerGoodsSign'), '1001,1002');
assert.strictEqual(form.get('deptId'), '');
assert.strictEqual(form.get('warehouseId'), '');
assert.doesNotThrow(() => JSON.parse(form.get('aoData')));

const queryContext = {
  skus: ['1001', '1002', '1003'],
  sellerId: '20000023823',
  deptId: '26408279105374',
  shopId: '92708941',
  warehouseNo: '800018086'
};
const summary = summarizeShopStockRows({
  ...queryContext,
  rows: [
    { sellerGoodsSign: '1001', sellerId: '20000023823', deptId: '26408279105374', shopId: '92708941', warehouseNo: '800018086', stockNum: '2.0000', updateTime: '2026-09-13T15:21:11.000Z' },
    { sellerGoodsSign: '1001', sellerId: '20000023823', deptId: '26408279105374', shopId: '92708941', warehouseNo: '800018086', stockNum: '3.0000', updateTime: '2026-09-13T15:21:13.000Z' },
    { sellerGoodsSign: '1002', sellerId: '20000023823', deptId: '26408279105374', shopId: '92708941', warehouseNo: '800018086', stockNum: '0.0000' },
    { sellerGoodsSign: '1002', sellerId: '20000023823', deptId: '26408279105374', shopId: 'other-shop', warehouseNo: '800018086', stockNum: '10.0000' },
    { sellerGoodsSign: '1003', sellerId: '20000023823', deptId: '26408279105374', shopId: '92708941', warehouseNo: 'other-warehouse', stockNum: '10.0000' },
    { sellerGoodsSign: '1003', sellerId: 'wrong-seller', deptId: '26408279105374', shopId: '92708941', warehouseNo: '800018086', stockNum: '10.0000' }
  ]
});

assert.strictEqual(summary.ready, false);
assert.strictEqual(summary.total, 3);
assert.strictEqual(summary.inStockCount, 1);
assert.strictEqual(summary.zeroStockCount, 1);
assert.strictEqual(summary.missingCount, 1);
assert.deepStrictEqual(summary.inStockSkus, ['1001']);
assert.deepStrictEqual(summary.zeroStockSkus, ['1002']);
assert.deepStrictEqual(summary.missingSkus, ['1003']);
assert.strictEqual(summary.latestUpdateTime, '2026-09-13T15:21:13.000Z');

const ready = summarizeShopStockRows({
  ...queryContext,
  shopId: 'CSP0092708941',
  rows: queryContext.skus.map(sellerGoodsSign => ({
    sellerGoodsSign,
    sellerId: queryContext.sellerId,
    deptId: queryContext.deptId,
    shopId: queryContext.shopId,
    warehouseNo: queryContext.warehouseNo,
    stockNum: '1.0000'
  }))
});
assert.strictEqual(ready.ready, true);
assert.strictEqual(ready.inStockCount, 3);

console.log('店铺库存查询与严格门禁测试通过');
