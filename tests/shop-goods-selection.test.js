'use strict';

const assert = require('assert');
const { groupGoodsByProduct, selectGoodsPerProduct } = require('../src/js/shopGoodsSelection');

const goods = [
  ...[10, 20, 30, 40, 50, 60].map((price, index) => ({
    productCode: 'A', sku: `A${index + 1}`, price
  })),
  { productCode: 'B', sku: 'B1', price: 5 },
  { productCode: 'B', sku: 'B2', price: 1 },
  { productCode: 'B', sku: 'B3', price: 3 },
  { productCode: 'C', sku: 'C1', price: null },
  { productCode: 'C', sku: 'C2', price: null }
];

assert.deepStrictEqual(groupGoodsByProduct(goods).map(group => group.length), [6, 3, 2]);
assert.deepStrictEqual(
  selectGoodsPerProduct(goods, '第1个').map(item => item.sku),
  ['A1', 'B1', 'C1']
);
assert.deepStrictEqual(
  selectGoodsPerProduct(goods, '最后1个').map(item => item.sku),
  ['A6', 'B3', 'C2']
);
assert.deepStrictEqual(
  selectGoodsPerProduct(goods, '最低价').map(item => item.sku),
  ['A1', 'B2', 'C1']
);
assert.deepStrictEqual(
  selectGoodsPerProduct(goods, '最高价').map(item => item.sku),
  ['A6', 'B1', 'C1']
);

const randomFive = selectGoodsPerProduct(goods, 'N个', 5, () => 0.25);
const randomCounts = randomFive.reduce((counts, item) => {
  counts[item.productCode] = (counts[item.productCode] || 0) + 1;
  return counts;
}, {});
assert.deepStrictEqual(randomCounts, { A: 5, B: 3, C: 2 });
assert.strictEqual(new Set(randomFive.map(item => item.sku)).size, randomFive.length);
assert.strictEqual(randomFive.length, 10);
assert.strictEqual(selectGoodsPerProduct(goods, '全部').length, goods.length);

// 单个SPU原有8个SKU，价格筛选后只剩4个时，“随机5个”应全部保留这4个，不重复补足。
const eightSkuProduct = Array.from({ length: 8 }, (item, index) => ({
  productCode: 'D',
  sku: `D${index + 1}`,
  price: (index + 1) * 10
}));
const fourAfterPriceFilter = eightSkuProduct.filter(item => item.price >= 50);
const upToFive = selectGoodsPerProduct(fourAfterPriceFilter, 'N个', 5, () => 0.5);
assert.strictEqual(fourAfterPriceFilter.length, 4);
assert.deepStrictEqual(upToFive.map(item => item.sku), ['D5', 'D6', 'D7', 'D8']);

const missingCodes = [{ sku: 'X1' }, { sku: 'X2' }];
assert.deepStrictEqual(
  selectGoodsPerProduct(missingCodes, '第1个').map(item => item.sku),
  ['X1', 'X2']
);

console.log('店铺商品“每个SPU取SKU”筛选测试通过');
