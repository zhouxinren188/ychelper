'use strict';

const WMS_HOSTS = new Set(['unionwms.jdl.com', 'union.wms.jdl.com']);
const WMS_WAREHOUSE_SECTION_SELECTOR = '.right-menu .warehouse-container .warehouse-name > section';
const WMS_WAREHOUSE_MULTI_LABEL_SELECTOR = `${WMS_WAREHOUSE_SECTION_SELECTOR} .el-dropdown-link > span:first-child`;
const WMS_WAREHOUSE_SINGLE_LABEL_SELECTOR = `${WMS_WAREHOUSE_SECTION_SELECTOR} > div:not(.el-dropdown)`;

function classifyWmsPageUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    if (!WMS_HOSTS.has(parsed.hostname.toLowerCase())) return 'other';

    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    if (pathname === '/logon' || pathname.startsWith('/logon/')) return 'warehouse-selection';
    if (
      pathname === '/default' || pathname.startsWith('/default/') ||
      pathname === '/gray' || pathname.startsWith('/gray/')
    ) {
      return 'warehouse-workspace';
    }
    return 'other';
  } catch (_) {
    return 'other';
  }
}

function parseWarehouseLabel(rawLabel) {
  const displayName = String(rawLabel || '').replace(/\s+/g, ' ').trim();
  if (!displayName) {
    return { displayName: '', warehouseName: '', warehouseNo: '' };
  }

  const match = displayName.match(/^(.*?)\s*[（(]\s*([^（）()]+?)\s*[）)]\s*$/);
  if (!match) {
    return { displayName, warehouseName: displayName, warehouseNo: '' };
  }

  return {
    displayName,
    warehouseName: match[1].trim(),
    warehouseNo: match[2].trim()
  };
}

function isCompleteWmsWarehouseLabel(rawLabel) {
  const parsed = parseWarehouseLabel(rawLabel);
  return Boolean(parsed.warehouseName && parsed.warehouseNo);
}

function normalizeWmsWarehouseInfo(candidate = {}) {
  const warehouseName = String(candidate.warehouseName || '').replace(/\s+/g, ' ').trim();
  const warehouseNo = String(candidate.warehouseNo || '').replace(/\s+/g, ' ').trim();
  if (warehouseName && warehouseNo) {
    return {
      displayName: `${warehouseName}(${warehouseNo})`,
      warehouseName,
      warehouseNo
    };
  }
  return parseWarehouseLabel(candidate.label || '');
}

module.exports = {
  WMS_WAREHOUSE_MULTI_LABEL_SELECTOR,
  WMS_WAREHOUSE_SECTION_SELECTOR,
  WMS_WAREHOUSE_SINGLE_LABEL_SELECTOR,
  classifyWmsPageUrl,
  isCompleteWmsWarehouseLabel,
  normalizeWmsWarehouseInfo,
  parseWarehouseLabel
};
