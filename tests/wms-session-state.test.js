'use strict';

const assert = require('assert');
const { classifyWmsApiResponse } = require('../src/js/wmsSessionState');

assert.strictEqual(classifyWmsApiResponse(401, { error_response: { code: 403, zh_desc: '验证失败:%s' } }).kind, 'auth');
assert.strictEqual(classifyWmsApiResponse(200, { success: false, resultMessage: 'Token 已失效，请重新登录' }).kind, 'auth');
assert.strictEqual(classifyWmsApiResponse(403, {}).kind, 'auth');
assert.strictEqual(classifyWmsApiResponse(503, { message: '服务繁忙' }).kind, 'service');
assert.strictEqual(classifyWmsApiResponse(200, { success: false, resultMessage: '业务查询失败' }).kind, 'service');
assert.strictEqual(classifyWmsApiResponse(200, { success: true, resultValue: { total: '0' } }).kind, 'success');

console.log('WMS 会话响应分类测试通过');
