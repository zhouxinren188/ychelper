'use strict';

const assert = require('assert');
const {
  buildShopSkuExportFileName,
  formatFileDateTime,
  sanitizeFileNamePart
} = require('../src/js/shopExportFile');

assert.strictEqual(formatFileDateTime('2026-04-14T00:09:30'), '20260414_000930');
assert.strictEqual(formatFileDateTime('2026-04-15T01:10'), '20260415_011000');
assert.strictEqual(formatFileDateTime(''), '');
assert.strictEqual(sanitizeFileNamePart('测试/店铺:*?', '未知店铺'), '测试_店铺___');

assert.strictEqual(
  buildShopSkuExportFileName({
    shopName: '测试店铺',
    dateFrom: '2026-04-14T00:09:30',
    dateTo: '2026-04-15T01:10:00',
    skuCount: 5
  }),
  '测试店铺_20260414_000930-20260415_011000_5个SKU.txt'
);
assert.strictEqual(
  buildShopSkuExportFileName({ shopName: '', skuCount: 12 }),
  '未知店铺_全部时间_12个SKU.txt'
);

console.log('店铺 SKU 导出文件名测试通过');
