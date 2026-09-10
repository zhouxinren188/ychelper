'use strict';

const assert = require('assert');
const { sanitize, truncateLogMessage } = require('../src/js/logSanitizer');

const densePayload = [
  'request source=shop',
  'loginName=sample-user',
  'loginPwd=sample-password',
  'saToken=sample-token',
  'authCode=sample-auth-code',
  'graphicCaptchaVerifyToken=sample-verify-token trailing-secret'
].join('&');
const denseSanitized = sanitize(densePayload);
assert.match(denseSanitized, /敏感请求参数已过滤/);
[
  'sample-user',
  'sample-password',
  'sample-token',
  'sample-auth-code',
  'sample-verify-token',
  'trailing-secret'
].forEach(secret => {
  assert(!denseSanitized.includes(secret), `密集鉴权载荷不得保留 ${secret}`);
});

const structured = sanitize(
  '{"accountId":"account-value","refresh_token":"token-value","password":"password-value"}'
);
assert(!structured.includes('account-value'));
assert(!structured.includes('token-value'));
assert(!structured.includes('password-value'));
assert.match(structured, /"accountId":"\*\*\*"/);

const bearer = sanitize('Authorization: Bearer bearer-secret');
assert.strictEqual(bearer, 'Authorization: ***');

const longMessage = truncateLogMessage('x'.repeat(9000), 500);
assert(longMessage.length < 600);
assert.match(longMessage, /日志内容已截断/);

console.log('日志脱敏测试通过：第三方鉴权载荷、账号、Token、密码和超长日志均已覆盖');
