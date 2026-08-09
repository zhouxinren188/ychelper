'use strict';

const AUTH_MESSAGE_PATTERN = /(?:unauthori[sz]ed|forbidden|not[ _-]?login|login[ _-]?(?:expired|invalid)|token[^\n]{0,24}(?:expired|invalid)|未登录|请(?:先|重新)?登录|登录(?:状态|信息|会话)?(?:已)?(?:失效|过期|无效)|token[^\n]{0,24}(?:失效|过期|无效)|鉴权失败|认证失败|验证失败)/i;

function getWmsResponseMessage(data, fallback = '') {
  if (!data || typeof data !== 'object') return String(fallback || '').trim();
  const candidates = [
    data.resultMessage,
    data.message,
    data.msg,
    data.error,
    data.error_description,
    data.error_response && data.error_response.zh_desc,
    data.error_response && data.error_response.en_desc,
    data.error_response && data.error_response.message,
    data.error_response && data.error_response.error && data.error_response.error.message
  ];
  return String(candidates.find(value => value != null && String(value).trim()) || fallback || '').trim();
}

function getWmsResponseCodes(data) {
  if (!data || typeof data !== 'object') return [];
  const errorResponse = data.error_response && typeof data.error_response === 'object'
    ? data.error_response
    : {};
  const nestedError = errorResponse.error && typeof errorResponse.error === 'object'
    ? errorResponse.error
    : {};
  return [
    data.code,
    data.status,
    data.statusCode,
    data.resultCode,
    errorResponse.code,
    errorResponse.status,
    errorResponse.statusCode,
    nestedError.code,
    nestedError.status
  ].map(value => Number(value)).filter(Number.isFinite);
}

function classifyWmsApiResponse(httpStatus, data, rawText = '') {
  const status = Number(httpStatus) || 0;
  const message = getWmsResponseMessage(data, rawText);
  const codes = getWmsResponseCodes(data);
  if (status === 401 || status === 403 || codes.some(code => code === 401 || code === 403) || AUTH_MESSAGE_PATTERN.test(message)) {
    return { kind: 'auth', message: message || 'WMS 登录状态已失效' };
  }
  if (status < 200 || status >= 300) {
    return { kind: 'service', message: message || `WMS 服务返回 HTTP ${status || '异常'}` };
  }
  if (data && data.success === false) {
    return { kind: 'service', message: message || 'WMS 服务返回失败' };
  }
  return { kind: 'success', message };
}

module.exports = {
  classifyWmsApiResponse,
  getWmsResponseMessage
};
