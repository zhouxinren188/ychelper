'use strict';

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function getWmsScanRecord(response, inboundNo = '') {
  const rows = Array.isArray(response?.resultValue) ? response.resultValue : [];
  const expectedInboundNo = normalizeText(inboundNo);
  if (!expectedInboundNo) return rows[0] || null;
  return rows.find(item => normalizeText(item?.inboundNo) === expectedInboundNo) || rows[0] || null;
}

function needsWmsLogisticsRepair(scanRecord) {
  return normalizeText(scanRecord?.newSkuCollectType) === '1';
}

function buildWmsMissingLogisticsQuery(inboundNo, warehouseNo) {
  return {
    navigatorNo: normalizeText(inboundNo),
    probe_anchor_warehouseNo: normalizeText(warehouseNo)
  };
}

function normalizeWmsMissingLogisticsItems(response) {
  const rows = Array.isArray(response?.resultValue) ? response.resultValue : [];
  const seen = new Set();
  const items = [];

  for (const row of rows) {
    const sku = normalizeText(row?.sku);
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    items.push({
      sku,
      isvSku: normalizeText(row?.isvSku),
      skuName: normalizeText(row?.skuName)
    });
  }

  return items;
}

module.exports = {
  buildWmsMissingLogisticsQuery,
  getWmsScanRecord,
  needsWmsLogisticsRepair,
  normalizeWmsMissingLogisticsItems
};
