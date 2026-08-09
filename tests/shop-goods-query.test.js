'use strict';

const assert = require('assert');
const crypto = require('crypto');
const {
  SHOP_REQUEST_RESPONSE_DELAY_MS,
  SKU_REQUEST_TIMEOUT_MS,
  buildShopCookieHeader,
  buildProductListRequest,
  buildShopSffRequestHeaders,
  buildSkuListRequest,
  extractProductPage,
  extractSkuList,
  getProductId,
  getProductState,
  normalizeShopDateTime,
  queryProductPagesPageMajor
} = require('../src/js/shopGoodsQuery');

assert.strictEqual(SHOP_REQUEST_RESPONSE_DELAY_MS, 300);
assert.strictEqual(SKU_REQUEST_TIMEOUT_MS, 30000);

const fakeCookies = [
  { name: 'unrelated', value: 'must-not-be-sent' },
  { name: 'flash', value: 'flash-test' },
  { name: 'thor', value: 'thor-test' }
];
assert.strictEqual(buildShopCookieHeader(fakeCookies), 'thor=thor-test; flash=flash-test');
const directHeaders = buildShopSffRequestHeaders({
  bodyText: '{"test":true}',
  h5st: 'signed-test',
  dsmEid: 'eid-test',
  userAgent: 'Mozilla/5.0 test',
  cookies: fakeCookies
});
assert.deepStrictEqual(Object.keys(directHeaders), [
  'Accept',
  'User-Agent',
  'Cookie',
  'Content-Type',
  'dsm-platform',
  'h5st',
  'dsm-eid',
  'Content-Length',
  'Connection'
]);
assert.strictEqual(directHeaders.Cookie, 'thor=thor-test; flash=flash-test');
assert.strictEqual(directHeaders['dsm-platform'], 'pc');
assert.strictEqual(directHeaders['Content-Length'], Buffer.byteLength('{"test":true}', 'utf8'));
assert.throws(
  () => buildShopSffRequestHeaders({ bodyText: '{}', h5st: 'x', dsmEid: 'eid', cookies: [] }),
  /Cookie 不完整/
);

assert.strictEqual(getProductState('在售'), '4');
assert.strictEqual(getProductState('售卖中'), '4');
assert.strictEqual(getProductState('下架'), '5');
assert.strictEqual(getProductState('已下架'), '5');
assert.strictEqual(getProductState('全部商品'), null);
assert.strictEqual(getProductState(''), '4');
assert.strictEqual(normalizeShopDateTime('2026-04-14', false), '2026-04-14 00:00:00');
assert.strictEqual(normalizeShopDateTime('2026-04-14', true), '2026-04-14 23:59:59');
assert.strictEqual(normalizeShopDateTime('2026-04-14T08:05', false), '2026-04-14 08:05:00');
assert.strictEqual(normalizeShopDateTime('2026-04-14T18:30:59', true), '2026-04-14 18:30:59');
assert.strictEqual(normalizeShopDateTime('2026-02-30T08:05', false), null);

const allProductRequest = buildProductListRequest({ productState: null });
assert.strictEqual(allProductRequest.productListQueryReq.productState, null);

const productRequest = buildProductListRequest({
  dateFrom: '2026-04-14',
  dateTo: '2026-04-14',
  productState: '4',
  pageNum: 1,
  pageSize: 100
});

assert.deepStrictEqual(productRequest.productListQueryReq.onlineTime, [
  '2026-04-14 00:00:00',
  '2026-04-14 23:59:59'
]);
assert.strictEqual(productRequest.productListQueryReq.startOnlineTime, '2026-04-14 00:00:00');
assert.strictEqual(productRequest.productListQueryReq.endOnlineTime, '2026-04-14 23:59:59');
assert.strictEqual(productRequest.productListQueryReq.productState, '4');
assert.strictEqual(productRequest.productListQueryReq.pageSize, 100);
assert.deepStrictEqual(productRequest.accessContext, {
  source: 'web',
  businessModel: '0',
  proxyBelongBizId: ''
});
assert.strictEqual(
  crypto.createHash('sha256').update(JSON.stringify(productRequest)).digest('hex').toUpperCase(),
  'FC14A11E9F6F30FE52FCB5D34C8B5B06BB3655760E14E26ADA4B3547DA2DDB8E'
);

const timedProductRequest = buildProductListRequest({
  dateFrom: '2026-04-14T08:05',
  dateTo: '2026-04-14T18:30:59',
  productState: '4'
});
assert.deepStrictEqual(timedProductRequest.productListQueryReq.onlineTime, [
  '2026-04-14 08:05:00',
  '2026-04-14 18:30:59'
]);
assert.strictEqual(timedProductRequest.productListQueryReq.startOnlineTime, '2026-04-14 08:05:00');
assert.strictEqual(timedProductRequest.productListQueryReq.endOnlineTime, '2026-04-14 18:30:59');
assert.throws(
  () => buildProductListRequest({ dateFrom: '2026-04-14T08:05', dateTo: '' }),
  /同时选择/
);
assert.throws(
  () => buildProductListRequest({ dateFrom: '2026-04-14T18:30', dateTo: '2026-04-14T08:05' }),
  /不能晚于/
);

const productId = '10032969041181';
const skuRequest = buildSkuListRequest(productId);
assert.strictEqual(skuRequest.skuListQueryReq.productId, productId);
assert.deepStrictEqual(skuRequest.skuListQueryReq.sortMap, { created: 'asc' });
assert.strictEqual(
  crypto.createHash('sha256').update(JSON.stringify(skuRequest)).digest('hex').toUpperCase(),
  '29A52E85FFDEC98BCCF25F2789CCD5B5BFB77A89215089506DFBED1AB555E485'
);

const products = extractProductPage(JSON.stringify({
  code: 200,
  msg: '成功',
  data: {
    pageNo: 1,
    pageSize: 100,
    totalCount: 1,
    data: [{
      productId,
      productName: '测试商品',
      productSkuInfoVO: { skuId: '10198582176944' },
      skuCount: 5
    }]
  }
}));
assert.strictEqual(products.success, true);
assert.strictEqual(products.totalCount, 1);
assert.strictEqual(getProductId(products.items[0]), productId);

const skuIds = [
  '10198582176944',
  '10198582176945',
  '10198582176946',
  '10198582176947',
  '10198582176948'
];
const skus = extractSkuList(JSON.stringify({
  code: 200,
  msg: '成功',
  data: {
    totalCount: 5,
    data: skuIds.map(skuId => ({ skuId, productId }))
  }
}));
assert.strictEqual(skus.success, true);
assert.deepStrictEqual(skus.items.map(item => item.skuId), skuIds);

const risk = extractProductPage(JSON.stringify({ code: 601, msg: '风险校验失败' }));
assert.strictEqual(risk.success, false);
assert.strictEqual(risk.code, 601);

async function testPageMajorFlow() {
  const calls = [];
  const pageProgress = [];
  const skuProgress = [];
  const result = await queryProductPagesPageMajor({
    pageSize: 2,
    fetchProductPage: async pageNum => {
      calls.push(`P${pageNum}`);
      return {
        totalCount: 3,
        items: pageNum === 1
          ? [{ productId: 'p1' }, { productId: 'p2' }]
          : [{ productId: 'p3' }]
      };
    },
    fetchSkuList: async productId => {
      calls.push(`S${productId}`);
      return [{ skuId: `${productId}-sku` }];
    },
    onProductPage: progress => pageProgress.push({
      pageNum: progress.pageNum,
      completed: progress.completed,
      totalCount: progress.totalCount
    }),
    onSku: progress => skuProgress.push({
      productNumber: progress.productNumber,
      pageNum: progress.pageNum
    })
  });
  assert.deepStrictEqual(calls, ['P1', 'Sp1', 'Sp2', 'P2', 'Sp3']);
  assert.deepStrictEqual(pageProgress, [
    { pageNum: 1, completed: 0, totalCount: 3 },
    { pageNum: 2, completed: 2, totalCount: 3 }
  ]);
  assert.deepStrictEqual(skuProgress, [
    { productNumber: 1, pageNum: 1 },
    { productNumber: 2, pageNum: 1 },
    { productNumber: 3, pageNum: 2 }
  ]);
  assert.deepStrictEqual(result.allProducts.map(item => item.productId), ['p1', 'p2', 'p3']);
  assert.strictEqual(result.skuMap.size, 3);
  assert.strictEqual(result.totalPages, 2);
}

testPageMajorFlow()
  .then(() => console.log('shop-goods-query tests passed'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
