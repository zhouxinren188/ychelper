'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  collectUniqueSkuValues,
  groupGoodsByProduct,
  selectGoodsPerProduct
} = require('../src/js/shopGoodsSelection');

const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src', 'js', 'renderer.js'), 'utf8');

const firstNPosition = indexHtml.indexOf('value="前N个"');
const randomNPosition = indexHtml.indexOf('value="N个"');
assert(firstNPosition >= 0 && randomNPosition > firstNPosition,
  'SKU前N个选项必须存在并位于随机N个之前');
assert.match(indexHtml, /id="smFirstQtyN"/,
  'SKU前N个必须有独立的数量输入框');
assert.match(renderer, /sm_goodsFirstQtyN/,
  'SKU前N个数量必须保存并在下次启动恢复');
assert.match(renderer, /class="sm-spu-check"/,
  'SPU主行必须使用独立的整组勾选框，不能复用第一条SKU索引');
assert(
  indexHtml.indexOf('<th>状态</th>') > 0 &&
  indexHtml.indexOf('<th>状态</th>') < indexHtml.indexOf('<th>操作日期</th>'),
  '状态列必须位于操作日期前'
);
assert.match(renderer, /item\.skuName \|\| item\.name/,
  '展开后的SKU标题必须优先显示SKU名称和规格选项');
assert.match(renderer, /sm-status-badge is-on-sale/,
  '售卖中商品必须显示状态徽标');
assert.match(renderer, /sm-status-badge is-off-shelf/,
  '已下架商品必须显示状态徽标');
const selectedSkuFunction = renderer.slice(
  renderer.indexOf('function getSelectedSmSkus()'),
  renderer.indexOf('// ========== 导出 TXT ==========')
);
assert.match(selectedSkuFunction, /\.sm-sku-row \.sm-goods-check/,
  '导出和发送只能读取SKU子行，不能把SPU主行重复计入');

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
assert.deepStrictEqual(
  selectGoodsPerProduct(goods, '前N个', 2).map(item => item.sku),
  ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']
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
assert.deepStrictEqual(
  collectUniqueSkuValues(goods, [0, 0, 1, 99, 2]),
  ['A1', 'A2', 'A3'],
  '选择结果必须去重，并忽略越界或空SKU'
);

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
assert.deepStrictEqual(
  selectGoodsPerProduct(fourAfterPriceFilter, '前N个', 5).map(item => item.sku),
  ['D5', 'D6', 'D7', 'D8']
);

const missingCodes = [{ sku: 'X1' }, { sku: 'X2' }];
assert.deepStrictEqual(
  selectGoodsPerProduct(missingCodes, '第1个').map(item => item.sku),
  ['X1', 'X2']
);

console.log('店铺商品“每个SPU取SKU”筛选测试通过');
