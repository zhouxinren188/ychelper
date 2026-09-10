'use strict';

const SHOP_SFF_APP_ID = '3MC69M4R3HFKCQ4S01DN';
const SHOP_H5ST_APP_ID = '73806';
const PRODUCT_LIST_API = 'dsm.product.manage.ProductInfoReadViewService.queryValidProductList';
const SKU_LIST_API = 'dsm.product.manage.SkuInfoReadViewService.querySkuList';
const SHOP_BATCH_PRODUCT_URL = 'https://data.shop.jd.com/fullQuery/querySpu';
const SHOP_BATCH_SKU_URL = 'https://data.shop.jd.com/fullQuery/querySkuBySpuIds';
const SHOP_BATCH_QUERY_POLICY = Object.freeze({
  pageSize: 100,
  initialDelayMs: 1000,
  pageIntervalMs: 4000,
  rateLimitWaitMs: 60000,
  rateLimitRetries: 1
});
// 老款蚂蚁工具箱抓包实测：上一个业务响应完成约 300ms 后才发起下一次请求。
const SHOP_REQUEST_RESPONSE_DELAY_MS = 300;
const SKU_REQUEST_TIMEOUT_MS = 30000;
const SHOP_REQUEST_COOKIE_NAMES = ['thor', 'flash'];
const SHOP_AUTH_FAILURE_PATTERN = /(?:unauthori[sz]ed|forbidden|not[ _-]?login|login[ _-]?(?:expired|invalid)|未登录|请(?:先|重新)?登录|登录(?:状态|信息|会话)?(?:已)?(?:失效|过期|无效)|token[^\n]{0,24}(?:失效|过期|无效)|鉴权失败|认证失败)/i;

function normalizeShopDirectUserAgent(userAgent) {
  const value = String(userAgent || '').trim();
  if (
    value.length < 32 ||
    value.length > 512 ||
    /[\r\n]/.test(value) ||
    !/^Mozilla\/5\.0\b/.test(value) ||
    !/\bChrome\/\d+(?:\.\d+){1,3}\b/.test(value) ||
    !/\bSafari\/537\.36\b/.test(value) ||
    /\b(?:Electron|cloud-warehouse-assistant|ychelper)\//i.test(value)
  ) {
    throw new Error('店铺商品页浏览器环境无效，请重新打开店铺后台');
  }
  return value;
}

function buildShopCookieHeader(cookies = []) {
  const selected = new Map();
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    const name = String(cookie && cookie.name || '');
    if (!SHOP_REQUEST_COOKIE_NAMES.includes(name) || selected.has(name)) continue;
    selected.set(name, String(cookie && cookie.value || ''));
  }
  return SHOP_REQUEST_COOKIE_NAMES
    .filter(name => selected.has(name))
    .map(name => `${name}=${selected.get(name)}`)
    .join('; ');
}

function buildShopSffRequestHeaders({ bodyText, h5st, dsmEid, userAgent, cookies }) {
  const cookieHeader = buildShopCookieHeader(cookies);
  if (!cookieHeader.includes('thor=')) {
    throw new Error('店铺登录 Cookie 不完整，请重新登录店铺后台');
  }
  if (!String(dsmEid || '')) {
    throw new Error('店铺商品页缺少 dsm-eid，请重新打开店铺后台');
  }

  return {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'User-Agent': normalizeShopDirectUserAgent(userAgent),
    Cookie: cookieHeader,
    'Content-Type': 'application/json;charset=UTF-8',
    'dsm-platform': 'pc',
    h5st: String(h5st || ''),
    'dsm-eid': String(dsmEid),
    Host: 'sff.jd.com',
    'Content-Length': Buffer.byteLength(String(bodyText || ''), 'utf8'),
    Connection: 'Keep-Alive'
  };
}

function getProductState(goodsStatus) {
  const statusMap = {
    '在售': '4',
    '售卖中': '4',
    '下架': '5',
    '已下架': '5'
  };
  const normalized = String(goodsStatus || '').trim();
  if (normalized === '全部商品') return null;
  return statusMap[normalized] || '4';
}

function normalizeShopDateTime(value, endOfDay = false) {
  const text = String(value || '').trim();
  if (!text) return null;

  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const dateTime = text.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  const match = dateTime || dateOnly;
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = dateTime ? Number(match[4]) : (endOfDay ? 23 : 0);
  const minute = dateTime ? Number(match[5]) : (endOfDay ? 59 : 0);
  const second = dateTime ? Number(match[6] || 0) : (endOfDay ? 59 : 0);
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    return null;
  }

  const pad = number => String(number).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

function buildProductListRequest(options = {}) {
  const dateFrom = String(options.dateFrom || '').trim();
  const dateTo = String(options.dateTo || '').trim();
  if (Boolean(dateFrom) !== Boolean(dateTo)) {
    throw new Error('请同时选择上架开始时间和结束时间');
  }
  const startOnlineTime = dateFrom ? normalizeShopDateTime(dateFrom, false) : null;
  const endOnlineTime = dateTo ? normalizeShopDateTime(dateTo, true) : null;
  if ((dateFrom && !startOnlineTime) || (dateTo && !endOnlineTime)) {
    throw new Error('上架时间格式无效，请重新选择');
  }
  if (startOnlineTime && endOnlineTime && startOnlineTime > endOnlineTime) {
    throw new Error('上架开始时间不能晚于结束时间');
  }
  const hasDateRange = Boolean(startOnlineTime && endOnlineTime);
  const productState = options.productState === null
    ? null
    : String(options.productState || '4');

  return {
    productListQueryReq: {
      productName: null,
      skuIdList: null,
      categoryIdList: null,
      productIdList: null,
      salesVolume: null,
      jdPrice: null,
      shopCategory: null,
      stockNum: null,
      brandIdList: [],
      itemNum: null,
      onlineTime: hasDateRange ? [startOnlineTime, endOnlineTime] : null,
      productState,
      startOnlineTime,
      endOnlineTime,
      productType: null,
      startCreated: null,
      endCreated: null,
      startModified: null,
      endModified: null,
      categoryIds: [],
      minSalesVolume: null,
      maxSalesVolume: null,
      minJdPrice: null,
      maxJdPrice: null,
      minStockNum: null,
      maxStockNum: null,
      sortMap: { onlineTime: 'desc' },
      pageNum: Math.max(1, Number.parseInt(options.pageNum, 10) || 1),
      pageSize: Math.max(1, Number.parseInt(options.pageSize, 10) || 100)
    },
    accessContext: {
      source: 'web',
      businessModel: '0',
      proxyBelongBizId: ''
    }
  };
}

function buildSkuListRequest(productId) {
  return {
    skuListQueryReq: {
      productId: String(productId || ''),
      skuName: null,
      categoryIds: [],
      itemNum: null,
      skuType: null,
      startCreated: null,
      endCreated: null,
      startModified: null,
      endModified: null,
      sortMap: { created: 'asc' },
      supplyVenderId: null
    },
    accessContext: {
      source: 'web',
      businessModel: '0',
      proxyBelongBizId: ''
    }
  };
}

/**
 * 与京东商家后台“在售商品”列表保持同一批量查询结构。
 * 价格仍在本地按 SKU 精确筛选，避免 SPU 价格提前过滤掉有效 SKU。
 */
function buildShopBatchProductRequest(options = {}) {
  const dateFrom = String(options.dateFrom || '').trim();
  const dateTo = String(options.dateTo || '').trim();
  if (Boolean(dateFrom) !== Boolean(dateTo)) {
    throw new Error('请同时选择上架开始时间和结束时间');
  }
  const startOnlineTime = dateFrom ? normalizeShopDateTime(dateFrom, false) : '';
  const endOnlineTime = dateTo ? normalizeShopDateTime(dateTo, true) : '';
  if ((dateFrom && !startOnlineTime) || (dateTo && !endOnlineTime)) {
    throw new Error('上架时间格式无效，请重新选择');
  }
  if (startOnlineTime && endOnlineTime && startOnlineTime > endOnlineTime) {
    throw new Error('上架开始时间不能晚于结束时间');
  }

  return {
    category: [],
    colType: -1,
    columns: ['jdPrice', 'stockNum', 'onlineTime'],
    filterByVenderCode: false,
    itemNum: '',
    locType: -1,
    minJdPrice: '',
    maxJdPrice: '',
    maxStockNum: '',
    minStockNum: '',
    name: '',
    pageNo: Math.max(1, Number.parseInt(options.pageNum, 10) || 1),
    pageSize: Math.min(
      100,
      Math.max(1, Number.parseInt(options.pageSize, 10) || SHOP_BATCH_QUERY_POLICY.pageSize)
    ),
    skuIdList: [],
    spuIdList: [],
    startOnlineTime,
    endOnlineTime,
    status: 1,
    tyingType: 0,
    xnztType: 0,
    xpType: -1
  };
}

/**
 * data.shop 的在售商品批量接口在部分店铺会静默忽略上架时间范围。
 * 有日期时必须改用能实际执行时间筛选的 SFF 商品列表；SKU 仍保持整页批量查询。
 */
function shouldUseShopBatchProductList(options = {}) {
  const productState = options.productState == null ? null : String(options.productState);
  const hasDateRange = Boolean(
    String(options.dateFrom || '').trim() || String(options.dateTo || '').trim()
  );
  return productState === '4' && !hasDateRange;
}

function buildShopBatchSkuRequest(productIds) {
  const normalizedIds = [...new Set((Array.isArray(productIds) ? productIds : [])
    .map(value => String(value == null ? '' : value).trim())
    .filter(Boolean))];
  if (normalizedIds.length === 0) {
    throw new Error('SKU批量查询缺少商品编号');
  }
  if (normalizedIds.length > SHOP_BATCH_QUERY_POLICY.pageSize) {
    throw new Error(`SKU批量查询每次最多${SHOP_BATCH_QUERY_POLICY.pageSize}个商品`);
  }
  const spuIdList = normalizedIds.map(value => {
    if (!/^\d+$/.test(value)) return value;
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value;
  });
  return { spuIdList, xnztQuery: false };
}

function parseShopBatchJson(response) {
  if (typeof response !== 'string') return response;
  try {
    return JSON.parse(response);
  } catch (error) {
    return null;
  }
}

function getShopBatchResponseCode(payload) {
  const value = payload && (payload.code ?? payload.subCode);
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}

function getShopBatchResponseMessage(payload, fallback) {
  return String(
    payload && (payload.subMsg || payload.message || payload.msg || payload.errorMessage) || fallback
  );
}

function validateShopBatchResponse(response, label) {
  const payload = parseShopBatchJson(response);
  if (!payload || typeof payload !== 'object') {
    return { success: false, error: `${label}响应不是有效 JSON`, json: null };
  }
  const code = getShopBatchResponseCode(payload);
  if (payload.success === false || Number(code) !== 200) {
    return {
      success: false,
      code,
      error: getShopBatchResponseMessage(payload, `${label}返回错误 code=${code}`),
      json: payload
    };
  }
  return { success: true, code: 200, json: payload };
}

function normalizeShopBatchProduct(item) {
  const source = item && typeof item === 'object' ? item : {};
  const productId = getProductId(source) || String(source.id || '');
  const productName = String(
    source.productName || source.spuName || source.wareName || source.name || source.title || ''
  );
  const rawOnlineTime = source.onlineTime ?? source.onSaleTime ?? source.listTime ?? '';
  const onlineTime = normalizeShopBatchOnlineTime(rawOnlineTime);
  const rawLogo = source.logo || source.imgUrl || source.imageUrl || source.image || source.pictureUrl || '';
  const logo = String(rawLogo).startsWith('//') ? `https:${rawLogo}` : rawLogo;
  const rawPrice = source.priceDetailVO && source.priceDetailVO.jdPrice != null
    ? source.priceDetailVO.jdPrice
    : source.jdPrice ?? source.price ?? source.salePrice;
  const priceDetailVO = source.priceDetailVO || (rawPrice == null ? undefined : { jdPrice: rawPrice });
  const firstSkuId = source.skuId ?? source.itemId ?? source.productSkuInfoVO?.skuId;

  return {
    ...source,
    productId,
    productName,
    onlineTime,
    logo,
    productState: source.productState ?? source.productStatus ?? source.status ?? 4,
    ...(priceDetailVO ? { priceDetailVO } : {}),
    ...(source.productSkuInfoVO
      ? { productSkuInfoVO: source.productSkuInfoVO }
      : firstSkuId != null
        ? { productSkuInfoVO: { skuId: String(firstSkuId) } }
        : {})
  };
}

function extractShopBatchProductPage(response) {
  const parsed = validateShopBatchResponse(response, '商品列表');
  if (!parsed.success) return parsed;
  const data = parsed.json.data ?? parsed.json;
  const candidates = [
    data && data.dataList,
    data && data.list,
    data && data.result,
    data && data.data,
    data && data.spuList,
    data && data.rows
  ];
  const rawItems = candidates.find(Array.isArray);
  if (!rawItems) {
    return { success: false, error: '商品列表响应结构异常', json: parsed.json };
  }
  const items = rawItems.map(normalizeShopBatchProduct);
  const totalValue = data.total ?? data.totalCount ?? data.count ?? data.recordsTotal;
  const totalCount = Number(totalValue);
  return {
    success: true,
    items,
    totalCount: Number.isFinite(totalCount) ? totalCount : items.length,
    pageNo: Number(data.pageNo || data.pageNum) || 1,
    pageSize: Number(data.pageSize) || items.length || SHOP_BATCH_QUERY_POLICY.pageSize,
    json: parsed.json
  };
}

function getShopBatchSkuId(item) {
  const source = item && typeof item === 'object' ? item : {};
  return String(source.skuId ?? source.id ?? source.itemId ?? '').trim();
}

function getShopBatchSkuProductId(item, fallbackProductId = '') {
  const source = item && typeof item === 'object' ? item : {};
  return String(
    source.productId ?? source.spuId ?? source.wareId ?? source.parentId ?? source.id ?? fallbackProductId ?? ''
  ).trim();
}

function normalizeShopBatchOnlineTime(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string' && /[-/:T]/.test(value)) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : value;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return value;
  return number < 1e12 ? number * 1000 : number;
}

function normalizeShopBatchSku(item, fallbackProductId = '') {
  const source = item && typeof item === 'object' ? item : {};
  const skuId = getShopBatchSkuId(source);
  const productId = getShopBatchSkuProductId(source, fallbackProductId);
  return {
    ...source,
    skuId,
    productId,
    skuName: source.skuName || source.name || source.wareName || '',
    onlineTime: normalizeShopBatchOnlineTime(
      source.onlineTime ?? source.onSaleTime ?? source.listTime ?? ''
    ),
    jdPrice: source.jdPrice ?? source.price ?? source.salePrice ?? source.priceDetailVO?.jdPrice
  };
}

function getShopBatchSkuGroupItems(group) {
  if (Array.isArray(group)) return group;
  if (!group || typeof group !== 'object') return null;
  const candidates = [group.skuList, group.skuInfoList, group.children, group.list, group.dataList, group.data];
  return candidates.find(Array.isArray) || null;
}

function extractShopBatchSkuMap(response, requestedProductIds = []) {
  const parsed = validateShopBatchResponse(response, 'SKU批量查询');
  if (!parsed.success) return parsed;
  const requestedIds = [...new Set((Array.isArray(requestedProductIds) ? requestedProductIds : [])
    .map(value => String(value == null ? '' : value).trim())
    .filter(Boolean))];
  const requestedSet = new Set(requestedIds);
  const skuMap = new Map();
  const data = parsed.json.data ?? parsed.json;

  const addGroup = (productId, items, present = true) => {
    const normalizedProductId = String(productId == null ? '' : productId).trim();
    if (!normalizedProductId || !Array.isArray(items)) return;
    const normalizedItems = items
      .map(item => normalizeShopBatchSku(item, normalizedProductId))
      .filter(item => item.skuId);
    if (present || normalizedItems.length > 0) skuMap.set(normalizedProductId, normalizedItems);
  };

  const consumeArray = list => {
    for (const entry of list) {
      const groupedItems = getShopBatchSkuGroupItems(entry);
      if (groupedItems) {
        const productId = getShopBatchSkuProductId(entry);
        addGroup(productId, groupedItems);
        continue;
      }
      const productId = getShopBatchSkuProductId(entry);
      const sku = normalizeShopBatchSku(entry, productId);
      if (!productId || !sku.skuId) continue;
      const current = skuMap.get(productId) || [];
      current.push(sku);
      skuMap.set(productId, current);
    }
  };

  if (Array.isArray(data)) {
    consumeArray(data);
  } else if (data && typeof data === 'object') {
    const container = [data.dataList, data.list, data.result, data.rows].find(Array.isArray);
    if (container) {
      consumeArray(container);
    } else {
      for (const [entryProductId, entry] of Object.entries(data)) {
        const groupedItems = getShopBatchSkuGroupItems(entry);
        if (groupedItems) {
          addGroup(getShopBatchSkuProductId(entry, entryProductId), groupedItems);
        }
      }
    }
  }

  const unexpectedProductIds = [...skuMap.keys()].filter(productId => (
    requestedSet.size > 0 && !requestedSet.has(productId)
  ));
  const missingProductIds = requestedIds.filter(productId => !skuMap.has(productId));
  return { success: true, skuMap, missingProductIds, unexpectedProductIds, json: parsed.json };
}

function isShopBatchRateLimitError(error) {
  return Boolean(error) && (
    error.code === 'JD_RATE_LIMIT' ||
    Number(error.jdCode) === -3010 ||
    Number(error.httpStatus) === 429
  );
}

async function withShopBatchRateLimitRetry(operation, options = {}) {
  if (typeof operation !== 'function') throw new TypeError('缺少批量查询函数');
  const delay = typeof options.delay === 'function'
    ? options.delay
    : ms => new Promise(resolve => setTimeout(resolve, ms));
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const label = String(options.label || '京东批量查询');

  for (let attempt = 0; attempt <= SHOP_BATCH_QUERY_POLICY.rateLimitRetries; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (!isShopBatchRateLimitError(error) || attempt >= SHOP_BATCH_QUERY_POLICY.rateLimitRetries) {
        throw error;
      }
      onProgress({
        stage: 'rate-limit',
        message: `${label}触发京东限流，等待60秒后重试一次…`,
        waitMs: SHOP_BATCH_QUERY_POLICY.rateLimitWaitMs,
        attempt: attempt + 1
      });
      await delay(SHOP_BATCH_QUERY_POLICY.rateLimitWaitMs);
    }
  }
  throw new Error(`${label}重试失败`);
}

/**
 * 页内固定为“1次 SPU + 1次整页 SKU”，页间等待，不并发、不逐 SKU 请求。
 */
async function queryShopProductPagesBatch(options = {}) {
  if (typeof options.fetchProductPage !== 'function' || typeof options.fetchSkuBatch !== 'function') {
    throw new TypeError('缺少商品页或SKU批量查询函数');
  }
  const pageSize = Math.min(
    100,
    Math.max(1, Number.parseInt(options.pageSize, 10) || SHOP_BATCH_QUERY_POLICY.pageSize)
  );
  const delay = typeof options.delay === 'function'
    ? options.delay
    : ms => new Promise(resolve => setTimeout(resolve, ms));
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const completedProductIds = options.completedProductIds instanceof Set
    ? options.completedProductIds
    : new Set();
  const cachedSkuMap = options.cachedSkuMap instanceof Map ? options.cachedSkuMap : new Map();
  const allProducts = [];
  const skuMap = new Map();
  let totalCount = 0;
  let totalPages = 1;
  let effectivePageSize = pageSize;
  let completed = 0;

  onProgress({
    stage: 'initial-wait',
    message: '等待1秒后开始批量查询…',
    waitMs: SHOP_BATCH_QUERY_POLICY.initialDelayMs
  });
  await delay(SHOP_BATCH_QUERY_POLICY.initialDelayMs);

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    if (pageNum > 1) {
      onProgress({
        stage: 'page-wait',
        message: `等待4秒后查询第${pageNum}页…`,
        waitMs: SHOP_BATCH_QUERY_POLICY.pageIntervalMs,
        pageNum,
        totalPages,
        completed,
        total: totalCount
      });
      await delay(SHOP_BATCH_QUERY_POLICY.pageIntervalMs);
    }

    const page = await options.fetchProductPage(pageNum);
    if (!page || !Array.isArray(page.items)) {
      throw new Error(`商品列表第${pageNum}页响应结构异常`);
    }
    if (pageNum === 1) {
      totalCount = Math.max(0, Number(page.totalCount) || 0);
      effectivePageSize = Math.max(1, Number.parseInt(page.pageSize, 10) || pageSize);
      totalPages = Math.max(1, Math.ceil(totalCount / effectivePageSize));
    }

    const pageProducts = page.items;
    const productIds = pageProducts.map(getProductId);
    const missingIdCount = productIds.filter(productId => !productId).length;
    if (missingIdCount > 0) {
      throw new Error(`商品列表第${pageNum}页有${missingIdCount}条记录缺少商品编号，已停止以免漏查SKU`);
    }
    if (pageProducts.length === 0 && totalCount > completed) {
      throw new Error(`商品列表第${pageNum}页为空，已停止以免遗漏商品`);
    }

    const pendingProductIds = productIds.filter(productId => !completedProductIds.has(productId));
    if (pendingProductIds.length > 0) {
      const batchResult = await options.fetchSkuBatch(pendingProductIds, {
        pageNum,
        totalPages,
        totalCount,
        completed,
        pageSize: pageProducts.length
      });
      if (!batchResult || !(batchResult.skuMap instanceof Map)) {
        throw new Error(`SKU批量查询第${pageNum}页响应结构异常`);
      }
      const missingProductIds = pendingProductIds.filter(productId => !batchResult.skuMap.has(productId));
      if (missingProductIds.length > 0) {
        throw new Error(
          `SKU批量查询第${pageNum}页缺少${missingProductIds.length}个商品结果，已停止以免遗漏SKU`
        );
      }
      for (const productId of pendingProductIds) {
        const items = batchResult.skuMap.get(productId);
        if (!Array.isArray(items)) {
          throw new Error(`商品${productId}的SKU批量响应结构异常`);
        }
        cachedSkuMap.set(productId, items);
        completedProductIds.add(productId);
      }
    }

    for (const productId of productIds) {
      const items = cachedSkuMap.get(productId);
      if (!Array.isArray(items)) {
        throw new Error(`商品${productId}缺少已完成的SKU数据`);
      }
      skuMap.set(productId, items);
    }
    allProducts.push(...pageProducts);
    completed += pageProducts.length;
    onProgress({
      stage: 'page-complete',
      message: `第${pageNum}/${totalPages}页查询完成`,
      pageNum,
      totalPages,
      completed,
      total: totalCount,
      pageTotal: pageProducts.length,
      skuTotal: productIds.reduce((sum, productId) => sum + skuMap.get(productId).length, 0),
      // 只交给主进程内的回调做当前页数据转换；IPC 层会改成普通数组，
      // 不直接传递 Map 或原始京东响应。
      pageProducts,
      pageSkuMap: new Map(productIds.map(productId => [productId, skuMap.get(productId)]))
    });
  }

  return { allProducts, skuMap, totalCount, totalPages, pageSize: effectivePageSize, completed };
}

function parseSffResponse(responseText) {
  let json;
  try {
    json = typeof responseText === 'string' ? JSON.parse(responseText) : responseText;
  } catch (error) {
    return { success: false, error: '京东接口响应不是有效 JSON', json: null };
  }

  if (!json || typeof json !== 'object') {
    return { success: false, error: '京东接口响应为空', json: null };
  }

  if (Number(json.code) !== 200) {
    return {
      success: false,
      code: Number.isFinite(Number(json.code)) ? Number(json.code) : json.code,
      error: json.msg || json.message || `京东接口返回错误 code=${json.code}`,
      json
    };
  }

  return { success: true, code: 200, json };
}

function isShopSffAuthenticationFailure(parsed = {}) {
  const code = Number(parsed.code ?? parsed.json?.code);
  const message = String(
    parsed.error || parsed.json?.msg || parsed.json?.message || ''
  );
  return code === 401 || code === 403 || SHOP_AUTH_FAILURE_PATTERN.test(message);
}

function extractProductPage(responseText) {
  const parsed = parseSffResponse(responseText);
  if (!parsed.success) return parsed;

  const data = parsed.json.data;
  const totalValue = data && typeof data === 'object'
    ? data.totalCount ?? data.total ?? data.count ?? data.recordsTotal
    : undefined;
  const explicitTotal = Number(totalValue);
  const items = Array.isArray(data)
    ? data
    : data && Array.isArray(data.data)
      ? data.data
      : data && Array.isArray(data.list)
        ? data.list
        : data && Array.isArray(data.rows)
          ? data.rows
          : data && Array.isArray(data.records)
            ? data.records
            : null;
  const explicitEmpty = data == null || (
    data && typeof data === 'object' && Number.isFinite(explicitTotal) && explicitTotal === 0
  );

  if (!Array.isArray(items) && !explicitEmpty) {
    return { success: false, error: '商品列表响应结构异常', json: parsed.json };
  }
  const normalizedItems = Array.isArray(items) ? items : [];

  return {
    success: true,
    items: normalizedItems,
    totalCount: Number.isFinite(explicitTotal) ? explicitTotal : normalizedItems.length,
    pageNo: Number(data && (data.pageNo || data.pageNum)) || 1,
    pageSize: Number(data && data.pageSize) || normalizedItems.length || 100,
    json: parsed.json
  };
}

function extractSkuList(responseText) {
  const parsed = parseSffResponse(responseText);
  if (!parsed.success) return parsed;

  const data = parsed.json.data;
  const items = data && Array.isArray(data.data)
    ? data.data
    : data && Array.isArray(data.list)
      ? data.list
      : Array.isArray(data)
        ? data
        : [];

  if (!Array.isArray(items)) {
    return { success: false, error: 'SKU列表响应结构异常', json: parsed.json };
  }

  return { success: true, items, json: parsed.json };
}

function getProductId(product) {
  if (!product || typeof product !== 'object') return '';
  return String(product.productId || product.product_id || product.spuId || product.wareId || '');
}

/**
 * 快速打标的“商品名称”与京东商品列表保持一致，统一显示 SPU 标题。
 * SKU 名称可能自带规格，saleAttrs 也只是 SKU 规格，不能拼进商品标题。
 */
function getShopGoodsDisplayName(product, skuItem) {
  const productName = String(product && product.productName || '').trim();
  if (productName) return productName;
  return String(
    skuItem && (skuItem.skuName || skuItem.sku_name || skuItem.name) || ''
  ).trim();
}

/**
 * SKU 子行保留 SKU 原始标题；当接口只返回 SPU 标题时，从 saleAttrs 补回规格选项。
 * 该值只用于展开后的 SKU 行，不得替代 SPU 主标题。
 */
function getShopSkuDisplayName(product, skuItem) {
  const productName = String(product && product.productName || '').trim();
  const source = skuItem && typeof skuItem === 'object' ? skuItem : {};
  const skuName = String(source.skuName || source.sku_name || source.name || '').trim();
  if (skuName && skuName !== productName) return skuName;

  const saleAttrs = source.saleAttrs || source.saleAttrList || source.attrs || source.specs;
  const optionValues = Array.isArray(saleAttrs)
    ? saleAttrs.map(attr => {
        if (attr == null) return '';
        if (typeof attr !== 'object') return String(attr).trim();
        if (Array.isArray(attr.attrValueAlias) && attr.attrValueAlias.length > 0) {
          return String(attr.attrValueAlias[0] || '').trim();
        }
        if (typeof attr.attrValueAlias === 'string') return attr.attrValueAlias.trim();
        if (Array.isArray(attr.attrValues) && attr.attrValues.length > 0) {
          return String(attr.attrValues[0] || '').trim();
        }
        return String(attr.attrValueName || attr.attrValue || attr.name || '').trim();
      }).filter(Boolean)
    : [];

  const baseName = skuName || productName;
  if (optionValues.length === 0) return baseName;
  const optionText = `[${optionValues.join(', ')}]`;
  return baseName ? `${baseName} ${optionText}` : optionText;
}

/**
 * 商品状态优先使用商品列表响应中的 SPU 状态。
 * “全部商品”查询没有可用回退值；只有查询明确限定 4/5 时才按筛选条件回退。
 */
function getShopProductStatus(product, fallbackProductState = null) {
  const source = product && typeof product === 'object' ? product : {};
  const textCandidates = [
    source.productStateName,
    source.productStatusName,
    source.saleStatusName,
    source.statusName,
    source.productStateDesc,
    source.productStatusDesc
  ];

  for (const candidate of textCandidates) {
    const text = String(candidate == null ? '' : candidate).trim();
    if (!text) continue;
    if (text.includes('下架')) return '已下架';
    if (text.includes('售卖') || text.includes('在售') || text.includes('上架')) return '售卖中';
  }

  const codeCandidates = [
    source.productState,
    source.productStatus,
    source.saleStatus,
    source.wareStatus,
    source.status
  ];
  for (const candidate of codeCandidates) {
    const code = String(candidate == null ? '' : candidate).trim();
    if (code === '4') return '售卖中';
    if (code === '5') return '已下架';
  }

  const fallback = String(fallbackProductState == null ? '' : fallbackProductState).trim();
  if (fallback === '4' || fallback === '售卖中' || fallback === '在售') return '售卖中';
  if (fallback === '5' || fallback === '已下架' || fallback === '下架') return '已下架';
  return '未知';
}

function parseOptionalPrice(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  const price = Number(text);
  if (!Number.isFinite(price) || price < 0) {
    throw new Error(`${label}必须是大于或等于0的有效数字`);
  }
  return price;
}

/**
 * 价格筛选必须先于“每个 SPU 取 SKU”执行。
 * 只要设置了任一价格边界，缺少有效价格的 SKU 就不能绕过筛选。
 */
function filterGoodsByPriceRange(goods, priceMin, priceMax) {
  const min = parseOptionalPrice(priceMin, '最低售价');
  const max = parseOptionalPrice(priceMax, '最高售价');
  if (min != null && max != null && min > max) {
    throw new Error('最低售价不能高于最高售价');
  }

  const source = Array.isArray(goods) ? goods : [];
  if (min == null && max == null) return source.slice();

  return source.filter(item => {
    const rawPrice = item && item.price;
    if (rawPrice == null || String(rawPrice).trim() === '') return false;
    const price = Number(rawPrice);
    if (!Number.isFinite(price)) return false;
    return (min == null || price >= min) && (max == null || price <= max);
  });
}

async function queryProductPagesPageMajor(options = {}) {
  const pageSize = Math.max(1, Number.parseInt(options.pageSize, 10) || 100);
  if (typeof options.fetchProductPage !== 'function' || typeof options.fetchSkuList !== 'function') {
    throw new TypeError('缺少商品页或SKU查询函数');
  }

  const onProductPage = typeof options.onProductPage === 'function' ? options.onProductPage : () => {};
  const onSku = typeof options.onSku === 'function' ? options.onSku : () => {};
  const onMissingProductId = typeof options.onMissingProductId === 'function'
    ? options.onMissingProductId
    : () => {};
  // 外部传入的两个容器用于保存一次查询的安全断点。只有已经完整返回的 SKU
  // 才会写入；请求失败的 SPU 不会被标记为完成，下次同条件查询会继续请求它。
  const completedProductIds = options.completedProductIds instanceof Set
    ? options.completedProductIds
    : new Set();
  const cachedSkuMap = options.cachedSkuMap instanceof Map
    ? options.cachedSkuMap
    : new Map();
  const allProducts = [];
  const skuMap = new Map();
  let totalCount = 0;
  let totalPages = 1;
  let effectivePageSize = pageSize;
  let processedProducts = 0;

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const page = await options.fetchProductPage(pageNum);
    if (!page || !Array.isArray(page.items)) {
      throw new Error(`商品列表第${pageNum}页响应结构异常`);
    }
    if (pageNum === 1) {
      totalCount = Math.max(0, Number(page.totalCount) || 0);
      // 京东可能把请求的 pageSize 下调。必须以首屏响应中的实际分页大小计算，
      // 否则请求 100、实际返回 50 时只会查询一半页数。
      effectivePageSize = Math.max(1, Number.parseInt(page.pageSize, 10) || pageSize);
      totalPages = Math.max(1, Math.ceil(totalCount / effectivePageSize));
    }

    allProducts.push(...page.items);
    await onProductPage({
      pageNum,
      totalPages,
      totalCount,
      completed: processedProducts,
      items: page.items,
      allProducts
    });

    for (let pageIndex = 0; pageIndex < page.items.length; pageIndex++) {
      const productNumber = processedProducts + pageIndex + 1;
      const productId = getProductId(page.items[pageIndex]);
      const context = {
        pageNum,
        totalPages,
        pageIndex,
        pageSize: page.items.length,
        productNumber,
        totalCount
      };
      if (!productId) {
        await onMissingProductId(context);
        continue;
      }

      const resumed = completedProductIds.has(productId);
      const skuItems = resumed
        ? (cachedSkuMap.get(productId) || [])
        : await options.fetchSkuList(productId, context);
      if (!Array.isArray(skuItems)) {
        throw new Error(`商品${productId}的SKU响应结构异常`);
      }
      if (!resumed) {
        cachedSkuMap.set(productId, skuItems);
        completedProductIds.add(productId);
      }
      if (skuItems.length > 0) skuMap.set(productId, skuItems);
      await onSku({ ...context, productId, skuItems, resumed });
    }
    processedProducts += page.items.length;
  }

  return { allProducts, skuMap, totalCount, totalPages, pageSize: effectivePageSize, processedProducts };
}

module.exports = {
  PRODUCT_LIST_API,
  SHOP_BATCH_PRODUCT_URL,
  SHOP_BATCH_QUERY_POLICY,
  SHOP_BATCH_SKU_URL,
  SHOP_H5ST_APP_ID,
  SHOP_REQUEST_RESPONSE_DELAY_MS,
  SHOP_SFF_APP_ID,
  SKU_LIST_API,
  SKU_REQUEST_TIMEOUT_MS,
  buildShopCookieHeader,
  buildShopBatchProductRequest,
  buildShopBatchSkuRequest,
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
  isShopBatchRateLimitError,
  normalizeShopDirectUserAgent,
  normalizeShopDateTime,
  parseSffResponse,
  queryShopProductPagesBatch,
  queryProductPagesPageMajor,
  shouldUseShopBatchProductList,
  validateShopBatchResponse,
  withShopBatchRateLimitRetry
};
