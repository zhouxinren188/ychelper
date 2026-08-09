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
  findDuplicateShopAccount,
  isShopLoginUrl,
  isTrustedShopLoginFrameUrl,
  normalizeShopUsername,
  parseShopIdentityJsonp
};
