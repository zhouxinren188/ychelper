'use strict';

function isShopLoginUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    const host = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase();
    return host.includes('passport') || pathname === '/login' || pathname.startsWith('/login/');
  } catch (error) {
    return /passport|\/login(?:\/|$)/i.test(String(rawUrl || ''));
  }
}

function isTrustedShopLoginFrameUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    const host = url.hostname.toLowerCase();
    return ['http:', 'https:'].includes(url.protocol) && (host === 'jd.com' || host.endsWith('.jd.com'));
  } catch (error) {
    return false;
  }
}

function classifyShopValidationSnapshot(snapshot = {}) {
  const rawUrl = String(snapshot.url || '');
  if (isShopLoginUrl(rawUrl) || snapshot.hasLoginForm) return 'login';

  try {
    const url = new URL(rawUrl);
    if (url.hostname.toLowerCase() === 'shop.jd.com') return 'authenticated';
  } catch (error) {}

  return 'unknown';
}

function parseShopIdentityJsonp(rawBody) {
  const text = String(rawBody || '').trim();
  if (!text) return null;

  let jsonText = text;
  const openParen = text.indexOf('(');
  const closeParen = text.lastIndexOf(')');
  if (openParen >= 0 && closeParen > openParen) {
    jsonText = text.slice(openParen + 1, closeParen);
  }

  try {
    const parsed = JSON.parse(jsonText);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    return null;
  }
}

function classifyShopIdentityResponse(response = {}) {
  const status = Number(response.status || 0);
  if (status === 401 || status === 403 || isShopLoginUrl(response.url)) return 'login';
  if (status < 200 || status >= 300) return 'unknown';

  const payload = parseShopIdentityJsonp(response.body);
  if (!payload) return 'unknown';

  const currentVendor = payload.currentVendor;
  if (currentVendor && currentVendor.vendorId != null && String(currentVendor.vendorId).trim()) {
    return 'authenticated';
  }

  // 该接口未登录时仍返回 HTTP 200，但只有身份切换标志，不含 currentVendor。
  if (
    Object.prototype.hasOwnProperty.call(payload, 'identityFlag') &&
    Object.prototype.hasOwnProperty.call(payload, 'switchIdentity') &&
    Object.prototype.hasOwnProperty.call(payload, 'switchVendor')
  ) {
    return 'login';
  }

  return 'unknown';
}

function normalizeOfficialShopName(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function extractOfficialShopId(data = {}) {
  // vendorId（商家ID）与 shopId（店铺ID）不是同一个业务字段；部分店铺
  // 两者数值恰好相同，不能因此用 vendorId 兜底店铺ID。
  const directId = data.shopId;
  if (directId != null && String(directId).trim()) return String(directId).trim();

  const match = String(data.shopInfoUrl || '').match(/index-([^./?]+)\.html/i);
  return match ? match[1] : '';
}

function parseShopOfficialInfoResponse(rawBody) {
  let payload;
  try {
    payload = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
  } catch (error) {
    return { success: false, message: `响应解析失败: ${error.message}` };
  }

  if (!payload || typeof payload !== 'object') {
    return { success: false, message: '店铺资料接口响应为空' };
  }

  const data = payload.data || (payload.result && payload.result.data) || payload.result || {};
  const shopName = normalizeOfficialShopName(data.shopName || data.venderName || data.vendorName);
  if (!shopName) {
    return {
      success: false,
      message: String(payload.message || payload.msg || '接口未返回店铺名称'),
      fields: data && typeof data === 'object' ? Object.keys(data) : []
    };
  }

  return {
    success: true,
    shopName,
    loginAccount: normalizeOfficialShopName(data.account),
    officialShopId: extractOfficialShopId(data),
    shopInfoUrl: String(data.shopInfoUrl || ''),
    fields: Object.keys(data)
  };
}

function normalizeShopUsername(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US');
}

function findDuplicateShopAccount(accounts, candidate = {}) {
  const normalizedUsername = normalizeShopUsername(candidate.username);
  if (!normalizedUsername) return null;

  const candidateId = String(candidate.id || '');
  return (Array.isArray(accounts) ? accounts : []).find(account => {
    if (candidateId && String(account.id || '') === candidateId) return false;
    return normalizeShopUsername(account.username) === normalizedUsername;
  }) || null;
}

module.exports = {
  classifyShopIdentityResponse,
  classifyShopValidationSnapshot,
  extractOfficialShopId,
  findDuplicateShopAccount,
  isShopLoginUrl,
  isTrustedShopLoginFrameUrl,
  normalizeOfficialShopName,
  normalizeShopUsername,
  parseShopOfficialInfoResponse,
  parseShopIdentityJsonp
};
