'use strict';

const SENSITIVE_KEY_NAMES = [
  'cookie',
  'cookies',
  'authorization',
  'jwt',
  'pt_key',
  'username',
  'user_name',
  'loginname',
  'login_name',
  'loginid',
  'login_id',
  'accountid',
  'account_id',
  'pin',
  'eid',
  'fp',
  'h5st',
  'seqsid',
  'authcode',
  'publickey',
  '[a-z0-9_-]*(?:token|password|passwd|pwd|secret|credential|sessionid|session_id)[a-z0-9_-]*',
  '用户密码',
  '账号',
  '密码',
  '口令'
].join('|');

const DENSE_AUTH_PAYLOAD = /(?:^|[?&\s])(?:loginpwd|password|passwd|satoken|authcode|authorization|graphiccaptchajwttoken|graphiccaptchaverifytoken|h5st)=/i;

function maskSecret() {
  return '***';
}

function sanitize(input) {
  let text = String(input == null ? '' : input);

  // 第三方网页偶尔会把完整登录表单打印到控制台。遇到这种密集鉴权载荷时，
  // 不尝试逐字段保留，直接丢弃整段参数，防止未知字段或空格续行造成泄漏。
  if (DENSE_AUTH_PAYLOAD.test(text)) {
    const label = (text.match(/^[^=&\r\n]{0,80}/) || ['第三方页面请求'])[0].trim();
    return `${label || '第三方页面请求'} [敏感请求参数已过滤]`;
  }

  text = text.replace(/\b(set-cookie|cookie|authorization)\s*:\s*([^\r\n]+)/gi,
    (match, key) => `${key}: ${maskSecret()}`);
  text = text.replace(/\b(cookie|cookies)\s*=\s*([^\r\n]+)/gi,
    (match, key) => `${key}=${maskSecret()}`);

  const quotedPattern = new RegExp(
    `((?:["']?)(?:${SENSITIVE_KEY_NAMES})(?:["']?)\\s*[:=]\\s*["'])([^"']*)(["'])`,
    'gi'
  );
  text = text.replace(quotedPattern,
    (match, prefix, value, suffix) => `${prefix}${maskSecret()}${suffix}`);

  const plainPattern = new RegExp(
    `(\\b(?:${SENSITIVE_KEY_NAMES})\\b\\s*[:=]\\s*)(?!["'])([^\\s,;}&\\]]+)`,
    'gi'
  );
  text = text.replace(plainPattern, (match, prefix) => `${prefix}${maskSecret()}`);

  text = text.replace(/(\bBearer\s+)([A-Za-z0-9._~+\/-]+)/gi,
    (match, prefix) => `${prefix}${maskSecret()}`);
  text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    () => maskSecret());
  return text;
}

function truncateLogMessage(input, maxLength = 8000) {
  const text = String(input == null ? '' : input);
  const limit = Math.max(200, Number(maxLength) || 8000);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… [日志内容已截断]`;
}

module.exports = {
  sanitize,
  truncateLogMessage
};
