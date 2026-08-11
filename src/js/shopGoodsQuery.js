'use strict';

const SHOP_SFF_APP_ID = '3MC69M4R3HFKCQ4S01DN';
const SHOP_H5ST_APP_ID = '73806';
const PRODUCT_LIST_API = 'dsm.product.manage.ProductInfoReadViewService.queryValidProductList';
const SKU_LIST_API = 'dsm.product.manage.SkuInfoReadViewService.querySkuList';
// 老款蚂蚁工具箱抓包实测：上一个业务响应完成约 300ms 后才发起下一次请求。
const SHOP_REQUEST_RESPONSE_DELAY_MS = 300;
const SKU_REQUEST_TIMEOUT_MS = 30000;
const SHOP_REQUEST_COOKIE_NAMES = ['thor', 'flash'];
const SHOP_AUTH_FAILURE_PATTERN = /(?:unauthori[sz]ed|forbidden|not[ _-]?login|login[ _-]?(?:expired|invalid)|未登录|请(?:先|重新)?登录|登录(?:状态|信息|会话)?(?:已)?(?:失效|过期|无效)|token[^\n]{0,24}(?:失效|过期|无效)|鉴权失败|认证失败)/i;

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
    'User-Agent': String(userAgent || ''),
    Cookie: cookieHeader,
    'Content-Type': 'application/json;charset=UTF-8',
    'dsm-platform': 'pc',
    h5st: String(h5st || ''),
    'dsm-eid': String(dsmEid),
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
  const items = data && Array.isArray(data.data)
    ? data.data
    : data && Array.isArray(data.list)
      ? data.list
      : [];

  if (!data || (!Array.isArray(data.data) && !Array.isArray(data.list))) {
    return { success: false, error: '商品列表响应结构异常', json: parsed.json };
  }

  return {
    success: true,
    items,
    totalCount: Number(data.totalCount) || items.length,
    pageNo: Number(data.pageNo || data.pageNum) || 1,
    pageSize: Number(data.pageSize) || items.length || 100,
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

      const skuItems = await options.fetchSkuList(productId, context);
      if (!Array.isArray(skuItems)) {
        throw new Error(`商品${productId}的SKU响应结构异常`);
      }
      if (skuItems.length > 0) skuMap.set(productId, skuItems);
      await onSku({ ...context, productId, skuItems });
    }
    processedProducts += page.items.length;
  }

  return { allProducts, skuMap, totalCount, totalPages, pageSize: effectivePageSize, processedProducts };
}

module.exports = {
  PRODUCT_LIST_API,
  SHOP_H5ST_APP_ID,
  SHOP_REQUEST_RESPONSE_DELAY_MS,
  SHOP_SFF_APP_ID,
  SKU_LIST_API,
  SKU_REQUEST_TIMEOUT_MS,
  buildShopCookieHeader,
  buildProductListRequest,
  buildShopSffRequestHeaders,
  buildSkuListRequest,
  extractProductPage,
  extractSkuList,
  filterGoodsByPriceRange,
  getProductId,
  getProductState,
  getShopGoodsDisplayName,
  getShopProductStatus,
  getShopSkuDisplayName,
  isShopSffAuthenticationFailure,
  normalizeShopDateTime,
  parseSffResponse,
  queryProductPagesPageMajor
};
