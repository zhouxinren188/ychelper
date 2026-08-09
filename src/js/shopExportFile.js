'use strict';

function sanitizeFileNamePart(value, fallback) {
  const sanitized = String(value == null ? '' : value)
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[.\s]+$/g, '')
    .replace(/\s+/g, ' ');
  return sanitized || fallback;
}

function formatFileDateTime(value) {
  const match = String(value || '').match(
    /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/
  );
  if (!match) return '';
  const [, year, month, day, hour, minute, second = '00'] = match;
  return `${year}${month}${day}_${hour}${minute}${second}`;
}

function buildShopSkuExportFileName(options = {}) {
  const shopName = sanitizeFileNamePart(options.shopName, '未知店铺').slice(0, 80);
  const start = formatFileDateTime(options.dateFrom);
  const end = formatFileDateTime(options.dateTo);
  const timeRange = start && end ? `${start}-${end}` : '全部时间';
  const skuCount = Math.max(0, Number.parseInt(options.skuCount, 10) || 0);
  return `${shopName}_${timeRange}_${skuCount}个SKU.txt`;
}

module.exports = {
  buildShopSkuExportFileName,
  formatFileDateTime,
  sanitizeFileNamePart
};
