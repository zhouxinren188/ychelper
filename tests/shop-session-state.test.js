'use strict';

const assert = require('assert');
const {
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

assert.strictEqual(normalizeOfficialShopName('  测试\n店铺  '), '测试 店铺');
assert.strictEqual(extractOfficialShopId({ shopId: 12345 }), '12345');
assert.strictEqual(extractOfficialShopId({ vendorId: 67890 }), '',
  '商家ID不能被误当作店铺ID');
assert.strictEqual(
  extractOfficialShopId({ shopInfoUrl: 'https://shop.jd.com/index-6802637.html' }),
  '6802637'
);
assert.deepStrictEqual(
  parseShopOfficialInfoResponse(JSON.stringify({
    data: {
      shopName: '  测试店铺  ',
      account: '  测试账号  ',
      shopInfoUrl: 'https://shop.jd.com/index-6802637.html',
      extraField: true
    }
  })),
  {
    success: true,
    shopName: '测试店铺',
    loginAccount: '测试账号',
    officialShopId: '6802637',
    shopInfoUrl: 'https://shop.jd.com/index-6802637.html',
    fields: ['shopName', 'account', 'shopInfoUrl', 'extraField']
  }
);
assert.deepStrictEqual(
  parseShopOfficialInfoResponse('{bad json'),
  {
    success: false,
    message: '响应解析失败: Expected property name or \'}\' in JSON at position 1 (line 1 column 2)'
  }
);
assert.deepStrictEqual(
  parseShopOfficialInfoResponse(JSON.stringify({ data: { shopInfoUrl: '/index-123.html' } })),
  {
    success: false,
    message: '接口未返回店铺名称',
    fields: ['shopInfoUrl']
  }
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
