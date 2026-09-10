'use strict';

const assert = require('assert');
const crypto = require('crypto');
const {
  SHOP_BATCH_PRODUCT_URL,
  SHOP_BATCH_QUERY_POLICY,
  SHOP_BATCH_SKU_URL,
  SHOP_REQUEST_RESPONSE_DELAY_MS,
  SKU_REQUEST_TIMEOUT_MS,
  buildShopBatchProductRequest,
  buildShopBatchSkuRequest,
  buildShopCookieHeader,
  buildProductListRequest,
  buildShopSffRequestHeaders,
  buildSkuListRequest,
  extractProductPage,
  extractShopBatchProductPage,
  extractShopBatchSkuMap,
  extractSkuList,
  filterGoodsByPriceRange,
  getProductId,
  getProductState,
  getShopGoodsDisplayName,
  getShopProductStatus,
  getShopSkuDisplayName,
  isShopSffAuthenticationFailure,
  normalizeShopDateTime,
  queryShopProductPagesBatch,
  queryProductPagesPageMajor,
  shouldUseShopBatchProductList,
  normalizeShopDirectUserAgent,
  withShopBatchRateLimitRetry
} = require('../src/js/shopGoodsQuery');

assert.strictEqual(SHOP_REQUEST_RESPONSE_DELAY_MS, 300);
assert.strictEqual(SKU_REQUEST_TIMEOUT_MS, 30000);
assert.strictEqual(SHOP_BATCH_PRODUCT_URL, 'https://data.shop.jd.com/fullQuery/querySpu');
assert.strictEqual(SHOP_BATCH_SKU_URL, 'https://data.shop.jd.com/fullQuery/querySkuBySpuIds');
assert.deepStrictEqual(SHOP_BATCH_QUERY_POLICY, {
  pageSize: 100,
  initialDelayMs: 1000,
  pageIntervalMs: 4000,
  rateLimitWaitMs: 60000,
  rateLimitRetries: 1
});
assert.strictEqual(shouldUseShopBatchProductList({ productState: '4' }), true,
  '未限制日期的售卖中商品应继续使用低风控批量商品接口');
assert.strictEqual(shouldUseShopBatchProductList({
  productState: '4',
  dateFrom: '2026-09-07T00:00',
  dateTo: '2026-09-07T23:59'
}), false, '设置上架时间时必须使用真正支持日期筛选的 SFF 商品列表接口');
assert.strictEqual(shouldUseShopBatchProductList({ productState: '5' }), false,
  '已下架商品必须继续使用 SFF 状态筛选接口');

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
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
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
  'Host',
  'Content-Length',
  'Connection'
]);
assert.strictEqual(directHeaders.Cookie, 'thor=thor-test; flash=flash-test');
assert.match(directHeaders['User-Agent'], /Chrome\/134\.0\.0\.0/);
assert.strictEqual(directHeaders.Host, 'sff.jd.com');
assert.strictEqual(directHeaders['dsm-platform'], 'pc');
assert.strictEqual(directHeaders['Content-Length'], Buffer.byteLength('{"test":true}', 'utf8'));
assert.throws(
  () => buildShopSffRequestHeaders({ bodyText: '{}', h5st: 'x', dsmEid: 'eid', cookies: [] }),
  /Cookie 不完整/
);
assert.throws(
  () => normalizeShopDirectUserAgent('Mozilla/5.0 Chrome/134.0.0.0 Electron/35.0.0 Safari/537.36'),
  /浏览器环境无效/
);
assert.throws(
  () => normalizeShopDirectUserAgent('Mozilla/5.0 Chrome/134.0.0.0 Safari/537.36\r\nX-Test: injected'),
  /浏览器环境无效/
);

const priceGoods = [
  { sku: 'no-price', price: null },
  { sku: 'invalid-price', price: 'not-a-number' },
  { sku: 'zero', price: 0 },
  { sku: 'ten', price: 10 },
  { sku: 'twenty', price: '20' }
];
assert.deepStrictEqual(
  filterGoodsByPriceRange(priceGoods, '10', '20').map(item => item.sku),
  ['ten', 'twenty'],
  '设置价格范围后，缺少有效价格的SKU不能绕过筛选'
);
assert.deepStrictEqual(
  filterGoodsByPriceRange(priceGoods, '0', '').map(item => item.sku),
  ['zero', 'ten', 'twenty']
);
assert.strictEqual(filterGoodsByPriceRange(priceGoods, '', '').length, priceGoods.length);
assert.throws(() => filterGoodsByPriceRange(priceGoods, '20', '10'), /最低售价不能高于/);
assert.throws(() => filterGoodsByPriceRange(priceGoods, '-1', ''), /有效数字/);

assert.strictEqual(getProductState('在售'), '4');
assert.strictEqual(getProductState('售卖中'), '4');
assert.strictEqual(getProductState('下架'), '5');
assert.strictEqual(getProductState('已下架'), '5');
assert.strictEqual(getProductState('全部商品'), null);
assert.strictEqual(getProductState(''), '4');
const officialProductTitle = '花卉数字油画diy填色新款手工填充油彩画丙烯涂色装饰画';
assert.strictEqual(
  getShopGoodsDisplayName(
    { productName: officialProductTitle },
    {
      skuName: `${officialProductTitle} [2714, 30/40X内框+画笔+颜料]`,
      saleAttrs: [{ attrValueAlias: ['2714'] }]
    }
  ),
  officialProductTitle,
  '商品名称必须显示SPU标题，不能拼接SKU规格'
);
assert.strictEqual(
  getShopGoodsDisplayName({}, { skuName: '仅有SKU标题' }),
  '仅有SKU标题',
  'SPU标题缺失时才回退到SKU标题'
);
assert.strictEqual(
  getShopSkuDisplayName(
    { productName: officialProductTitle },
    { skuName: officialProductTitle, saleAttrs: [
      { attrValueAlias: ['2714'] },
      { attrValueName: '30/40X内框+画笔+颜料' }
    ] }
  ),
  `${officialProductTitle} [2714, 30/40X内框+画笔+颜料]`,
  '展开后的SKU标题必须补回规格选项'
);
assert.strictEqual(
  getShopSkuDisplayName(
    { productName: officialProductTitle },
    { skuName: `${officialProductTitle} [S181, 30*40CM内框]` }
  ),
  `${officialProductTitle} [S181, 30*40CM内框]`,
  'SKU接口已经返回完整标题时不得重复拼接规格'
);
assert.strictEqual(getShopProductStatus({ productState: 4 }), '售卖中');
assert.strictEqual(getShopProductStatus({ productState: '5' }), '已下架');
assert.strictEqual(getShopProductStatus({ productStateName: '商品已下架' }, '4'), '已下架');
assert.strictEqual(getShopProductStatus({ productStatusName: '正在售卖' }, '5'), '售卖中');
assert.strictEqual(getShopProductStatus({}, '4'), '售卖中');
assert.strictEqual(getShopProductStatus({}, '5'), '已下架');
assert.strictEqual(
  getShopProductStatus({}, null),
  '未知',
  '全部商品查询缺少实际状态字段时不能猜测为售卖中'
);
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

const batchProductRequest = buildShopBatchProductRequest({
  dateFrom: '2026-04-14',
  dateTo: '2026-04-15',
  pageNum: 2,
  pageSize: 100
});
assert.strictEqual(batchProductRequest.status, 1);
assert.strictEqual(batchProductRequest.pageNo, 2);
assert.strictEqual(batchProductRequest.pageSize, 100);
assert.strictEqual(batchProductRequest.startOnlineTime, '2026-04-14 00:00:00');
assert.strictEqual(batchProductRequest.endOnlineTime, '2026-04-15 23:59:59');
assert.deepStrictEqual(batchProductRequest.columns, ['jdPrice', 'stockNum', 'onlineTime']);
assert.deepStrictEqual(
  buildShopBatchSkuRequest(['10032969041181', '10032969041182', '10032969041181']),
  { spuIdList: [10032969041181, 10032969041182], xnztQuery: false },
  '安全整数商品编号应按已验证项目的数字数组格式提交，并去重'
);
assert.deepStrictEqual(
  buildShopBatchSkuRequest(['9007199254740993']),
  { spuIdList: ['9007199254740993'], xnztQuery: false },
  '超过安全整数范围的商品编号必须保留字符串，不能损失精度'
);
assert.throws(() => buildShopBatchSkuRequest([]), /缺少商品编号/);

const batchProducts = extractShopBatchProductPage({
  code: 200,
  data: {
    total: 2,
    pageNo: 1,
    pageSize: 100,
    dataList: [
      {
        spuId: 1001,
        spuName: '批量商品一',
        jdPrice: '12.30',
        imgUrl: '//img.example.test/a.jpg',
        onlineTime: '2026-04-14 08:05:00'
      },
      { wareId: '1002', wareName: '批量商品二', price: 9.9, skuId: 2002, onlineTime: 1713060000 }
    ]
  }
});
assert.strictEqual(batchProducts.success, true);
assert.strictEqual(batchProducts.totalCount, 2);
assert.deepStrictEqual(batchProducts.items.map(item => item.productId), ['1001', '1002']);
assert.deepStrictEqual(batchProducts.items.map(item => item.productName), ['批量商品一', '批量商品二']);
assert.strictEqual(batchProducts.items[0].priceDetailVO.jdPrice, '12.30');
assert.strictEqual(batchProducts.items[1].productSkuInfoVO.skuId, '2002');
assert.strictEqual(batchProducts.items[0].logo, 'https://img.example.test/a.jpg');
assert.strictEqual(batchProducts.items[0].onlineTime, Date.parse('2026-04-14 08:05:00'));
assert.strictEqual(batchProducts.items[1].onlineTime, 1713060000000);

const objectSkuResult = extractShopBatchSkuMap({
  code: 200,
  data: {
    1001: [
      { skuId: 2001, skuName: '规格A', jdPrice: 10 },
      { skuId: 2002, skuName: '规格B', jdPrice: 11 }
    ],
    1002: [{ id: 2003, name: '规格C', price: 12 }]
  }
}, ['1001', '1002']);
assert.strictEqual(objectSkuResult.success, true);
assert.deepStrictEqual(objectSkuResult.missingProductIds, []);
assert.deepStrictEqual(objectSkuResult.skuMap.get('1001').map(item => item.skuId), ['2001', '2002']);
assert.deepStrictEqual(objectSkuResult.skuMap.get('1002').map(item => item.skuId), ['2003']);

const groupedSkuResult = extractShopBatchSkuMap({
  code: 200,
  data: [
    { spuId: 1001, skuList: [{ skuId: 2001 }, { skuId: 2002 }] },
    { spuId: 1002, skuInfoList: [{ itemId: 2003 }] }
  ]
}, ['1001', '1002']);
assert.deepStrictEqual(groupedSkuResult.skuMap.get('1001').map(item => item.skuId), ['2001', '2002']);
assert.deepStrictEqual(groupedSkuResult.skuMap.get('1002').map(item => item.skuId), ['2003']);

const flatSkuResult = extractShopBatchSkuMap({
  code: 200,
  data: [
    { spuId: 1001, skuId: 2001 },
    { productId: 1001, skuId: 2002 },
    { wareId: 1002, skuId: 2003 }
  ]
}, ['1001', '1002']);
assert.deepStrictEqual(flatSkuResult.skuMap.get('1001').map(item => item.skuId), ['2001', '2002']);
assert.deepStrictEqual(flatSkuResult.skuMap.get('1002').map(item => item.skuId), ['2003']);

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

const emptyProductsWithNullData = extractProductPage(JSON.stringify({
  code: 200,
  msg: '成功',
  data: null
}));
assert.strictEqual(emptyProductsWithNullData.success, true,
  '京东以null表示空结果时必须作为正常的0条商品处理');
assert.deepStrictEqual(emptyProductsWithNullData.items, []);
assert.strictEqual(emptyProductsWithNullData.totalCount, 0);

const emptyProductsWithZeroTotal = extractProductPage(JSON.stringify({
  code: 200,
  msg: '成功',
  data: { totalCount: 0, pageNum: 1, pageSize: 100, data: null }
}));
assert.strictEqual(emptyProductsWithZeroTotal.success, true,
  '京东明确返回总数0且列表缺省时必须作为正常空结果处理');
assert.deepStrictEqual(emptyProductsWithZeroTotal.items, []);
assert.strictEqual(emptyProductsWithZeroTotal.totalCount, 0);

const malformedProductsWithPositiveTotal = extractProductPage(JSON.stringify({
  code: 200,
  msg: '成功',
  data: { totalCount: 3, pageNum: 1, pageSize: 100, data: null }
}));
assert.strictEqual(malformedProductsWithPositiveTotal.success, false,
  '总数大于0却缺少商品列表时仍必须报结构异常');

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
assert.strictEqual(isShopSffAuthenticationFailure(risk), false);
assert.strictEqual(isShopSffAuthenticationFailure({ code: 401, error: '请求失败' }), true);
assert.strictEqual(isShopSffAuthenticationFailure({ code: 500, error: '登录状态已失效' }), true);
assert.strictEqual(isShopSffAuthenticationFailure({ code: 312, error: '签名校验失败' }), false);

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

  const clampedPageCalls = [];
  const clampedResult = await queryProductPagesPageMajor({
    pageSize: 100,
    fetchProductPage: async pageNum => {
      clampedPageCalls.push(pageNum);
      return {
        totalCount: 120,
        pageSize: 50,
        items: [{ productId: `clamped-${pageNum}` }]
      };
    },
    fetchSkuList: async productId => [{ skuId: `${productId}-sku` }]
  });
  assert.deepStrictEqual(clampedPageCalls, [1, 2, 3],
    '服务端下调pageSize后必须按响应中的实际页大小查询完全部页');
  assert.strictEqual(clampedResult.pageSize, 50);
  assert.strictEqual(clampedResult.totalPages, 3);

  const completedProductIds = new Set();
  const cachedSkuMap = new Map();
  const resumeCalls = [];
  const fetchResumePage = async () => ({
    totalCount: 2,
    items: [{ productId: 'resume-1' }, { productId: 'resume-2' }]
  });
  let firstAttempt = true;
  await assert.rejects(
    queryProductPagesPageMajor({
      pageSize: 100,
      completedProductIds,
      cachedSkuMap,
      fetchProductPage: fetchResumePage,
      fetchSkuList: async productId => {
        resumeCalls.push(productId);
        if (productId === 'resume-2' && firstAttempt) throw new Error('risk-control');
        return [{ skuId: `${productId}-sku` }];
      }
    }),
    /risk-control/
  );
  assert.deepStrictEqual([...completedProductIds], ['resume-1'],
    '失败的SPU不能写入断点，已经完整返回的SPU必须保留');
  assert.deepStrictEqual(cachedSkuMap.get('resume-1'), [{ skuId: 'resume-1-sku' }]);

  firstAttempt = false;
  const resumedFlags = [];
  const resumedResult = await queryProductPagesPageMajor({
    pageSize: 100,
    completedProductIds,
    cachedSkuMap,
    fetchProductPage: fetchResumePage,
    fetchSkuList: async productId => {
      resumeCalls.push(productId);
      return [{ skuId: `${productId}-sku` }];
    },
    onSku: progress => resumedFlags.push([progress.productId, progress.resumed])
  });
  assert.deepStrictEqual(resumeCalls, ['resume-1', 'resume-2', 'resume-2'],
    '恢复查询必须跳过已经完成的SPU，只重新请求中断点及其后续SPU');
  assert.deepStrictEqual(resumedFlags, [['resume-1', true], ['resume-2', false]]);
  assert.strictEqual(resumedResult.skuMap.size, 2);
}

async function testBatchPageFlow() {
  const calls = [];
  const delays = [];
  const progress = [];
  const result = await queryShopProductPagesBatch({
    pageSize: 2,
    delay: async ms => delays.push(ms),
    fetchProductPage: async pageNum => {
      calls.push(`P${pageNum}`);
      return {
        totalCount: 3,
        pageSize: 2,
        items: pageNum === 1
          ? [{ productId: 'p1' }, { productId: 'p2' }]
          : [{ productId: 'p3' }]
      };
    },
    fetchSkuBatch: async productIds => {
      calls.push(`S${productIds.join(',')}`);
      return {
        skuMap: new Map(productIds.map(productId => [
          productId,
          productId === 'p1'
            ? [{ skuId: 'p1-a' }, { skuId: 'p1-b' }]
            : [{ skuId: `${productId}-a` }]
        ]))
      };
    },
    onProgress: value => progress.push(value)
  });
  assert.deepStrictEqual(calls, ['P1', 'Sp1,p2', 'P2', 'Sp3']);
  assert.deepStrictEqual(delays, [1000, 4000]);
  assert.strictEqual(result.totalPages, 2);
  assert.strictEqual(result.skuMap.get('p1').length, 2, '批量流程必须保留同一SPU的全部SKU');
  const completedProgress = progress.filter(item => item.stage === 'page-complete');
  assert.deepStrictEqual(completedProgress.map(item => item.completed), [2, 3]);
  assert.deepStrictEqual(completedProgress[0].pageProducts.map(item => item.productId), ['p1', 'p2']);
  assert.deepStrictEqual(completedProgress[0].pageSkuMap.get('p1'), [
    { skuId: 'p1-a' },
    { skuId: 'p1-b' }
  ], '每页完成回调必须带上该页全部SKU，供界面立即显示');

  const bulkCalls = [];
  const bulkDelays = [];
  const totalProducts = 1732;
  const bulkResult = await queryShopProductPagesBatch({
    pageSize: 100,
    delay: async ms => bulkDelays.push(ms),
    fetchProductPage: async pageNum => {
      bulkCalls.push(`P${pageNum}`);
      const start = (pageNum - 1) * 100;
      const count = Math.min(100, totalProducts - start);
      return {
        totalCount: totalProducts,
        pageSize: 100,
        items: Array.from({ length: count }, (_, index) => ({ productId: `p${start + index + 1}` }))
      };
    },
    fetchSkuBatch: async productIds => {
      bulkCalls.push(`S${productIds.length}`);
      return {
        skuMap: new Map(productIds.map(productId => [productId, [{ skuId: `${productId}-sku` }]]))
      };
    }
  });
  assert.strictEqual(bulkCalls.filter(call => call.startsWith('P')).length, 18);
  assert.strictEqual(bulkCalls.filter(call => call.startsWith('S')).length, 18);
  assert.strictEqual(bulkCalls.length, 36, '1732个SPU只能产生18次商品和18次SKU批量调用');
  assert.deepStrictEqual(bulkDelays, [1000, ...Array(17).fill(4000)]);
  assert.strictEqual(bulkResult.skuMap.size, totalProducts);

  await assert.rejects(
    queryShopProductPagesBatch({
      pageSize: 100,
      delay: async () => {},
      fetchProductPage: async () => ({
        totalCount: 2,
        pageSize: 100,
        items: [{ productId: 'missing-1' }, { productId: 'missing-2' }]
      }),
      fetchSkuBatch: async () => ({
        skuMap: new Map([['missing-1', [{ skuId: 'sku-1' }]]])
      })
    }),
    /缺少1个商品结果/,
    '批量响应不完整时必须停止，不能把漏掉的SKU当作成功'
  );

  const rateCalls = [];
  const rateDelays = [];
  const rateResult = await withShopBatchRateLimitRetry(async attempt => {
    rateCalls.push(attempt);
    if (attempt === 0) {
      const error = new Error('rate limited');
      error.code = 'JD_RATE_LIMIT';
      throw error;
    }
    return 'ok';
  }, {
    label: '测试批量查询',
    delay: async ms => rateDelays.push(ms)
  });
  assert.strictEqual(rateResult, 'ok');
  assert.deepStrictEqual(rateCalls, [0, 1]);
  assert.deepStrictEqual(rateDelays, [60000]);

  let failedAttempts = 0;
  await assert.rejects(
    withShopBatchRateLimitRetry(async () => {
      failedAttempts += 1;
      const error = new Error('still limited');
      error.code = 'JD_RATE_LIMIT';
      throw error;
    }, { delay: async () => {} }),
    /still limited/
  );
  assert.strictEqual(failedAttempts, 2, '限流后只能重试一次，不能无限循环');
}

testBatchPageFlow()
  .then(() => testPageMajorFlow())
  .then(() => console.log('shop-goods-query tests passed'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
