'use strict';

const assert = require('assert');
const {
  classifyShopIdentityResponse,
  classifyShopValidationSnapshot,
  findDuplicateShopAccount,
  isShopLoginUrl,
  isTrustedShopLoginFrameUrl,
  normalizeShopUsername,
  parseShopIdentityJsonp
} = require('../src/js/shopSessionState');

assert.strictEqual(isShopLoginUrl('https://passport.shop.jd.com/login/index.action/jdm'), true);
assert.strictEqual(isShopLoginUrl('https://shop.jd.com/jdm/home'), false);
assert.strictEqual(isTrustedShopLoginFrameUrl('https://passport.shop.jd.com/login/index.action/jdm'), true);
assert.strictEqual(isTrustedShopLoginFrameUrl('https://safe.jd.com/frame'), true);
assert.strictEqual(isTrustedShopLoginFrameUrl('https://eviljd.com/login'), false);
assert.strictEqual(isTrustedShopLoginFrameUrl('https://example.com/login'), false);
assert.strictEqual(isTrustedShopLoginFrameUrl('data:text/html,test'), false);
assert.strictEqual(
  classifyShopValidationSnapshot({ url: 'https://shop.jd.com/jdm/home', hasLoginForm: false }),
  'authenticated'
);
assert.strictEqual(
  classifyShopValidationSnapshot({ url: 'https://shop.jd.com/jdm/home', hasLoginForm: true }),
  'login'
);
assert.strictEqual(
  classifyShopValidationSnapshot({ url: 'https://passport.shop.jd.com/login/index.action/jdm' }),
  'login'
);
assert.strictEqual(
  classifyShopValidationSnapshot({ url: 'https://wares-jdm.jd.com/ware/wareList' }),
  'unknown'
);

assert.deepStrictEqual(
  parseShopIdentityJsonp('callback_1({"identityFlag":3,"currentVendor":{"vendorId":"123"}});'),
  { identityFlag: 3, currentVendor: { vendorId: '123' } }
);
assert.strictEqual(parseShopIdentityJsonp('not-json'), null);
assert.strictEqual(
  classifyShopIdentityResponse({
    status: 200,
    body: 'callback_1({"identityFlag":3,"switchIdentity":false,"switchVendor":false,"currentVendor":{"vendorId":"123"}})'
  }),
  'authenticated'
);
assert.strictEqual(
  classifyShopIdentityResponse({
    status: 200,
    body: 'callback_1({"identityFlag":1,"switchIdentity":false,"switchVendor":false})'
  }),
  'login'
);
assert.strictEqual(
  classifyShopIdentityResponse({ status: 403, body: '' }),
  'login'
);
assert.strictEqual(
  classifyShopIdentityResponse({ status: 500, body: '' }),
  'unknown'
);
assert.strictEqual(
  classifyShopIdentityResponse({ status: 200, body: 'temporarily unavailable' }),
  'unknown'
);

assert.strictEqual(normalizeShopUsername('  JD123456  '), 'jd123456');
assert.strictEqual(normalizeShopUsername('ＪＤ１２３'), 'jd123');
const shopAccounts = [
  { id: 'shop-1', username: 'JD123456' },
  { id: 'shop-2', username: 'another-shop' }
];
assert.strictEqual(
  findDuplicateShopAccount(shopAccounts, { username: ' jd123456 ' }).id,
  'shop-1'
);
assert.strictEqual(
  findDuplicateShopAccount(shopAccounts, { id: 'shop-1', username: 'jd123456' }),
  null
);
assert.strictEqual(
  findDuplicateShopAccount(shopAccounts, { username: 'new-shop' }),
  null
);

console.log('店铺会话状态测试通过');
