'use strict';

const CP_ORIGIN = 'https://cp.jdl.com';
const TARGET_SERVICE_ID = '1';
const TARGET_SHIPPER_NO = 'CYS0000010';
const TARGET_SERVICE_LABEL = '仓配一体服务 / 青龙';
const MIN_CHANGE_INTERVAL_MS = 3 * 60 * 1000;

const SERVICE_FIELD_NAMES = new Set([
  'shipIds',
  'serviceIds',
  'isCashOnDeliverys',
  'isGuarateeValues',
  'expProductTypes',
  'sellerShipNos',
  'agingTypes',
  'isAllowModifyWb',
  'scanpayTypes',
  'deliverAgainInfos'
]);

const SPECIAL_FIELD_NAMES = new Set([
  ...SERVICE_FIELD_NAMES,
  'warehouseAddServiceJson',
  'warehouseNos',
  'serviceId-alter',
  'shipperOption-alter',
  'spStoreService'
]);

function text(value) {
  return value == null ? '' : String(value).trim();
}

function normalizeCpLogisticsTime(value, fallback) {
  const candidate = text(value);
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(candidate) ? candidate : fallback;
}

function cpDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function cpScheduledAt(time, now = new Date()) {
  const [hour, minute] = normalizeCpLogisticsTime(time, '00:00').split(':').map(Number);
  const scheduled = new Date(now);
  scheduled.setHours(hour, minute, 0, 0);
  return scheduled;
}

function cpScheduleDistanceMinutes(first, second) {
  const toMinutes = value => {
    const [hour, minute] = normalizeCpLogisticsTime(value, '00:00').split(':').map(Number);
    return hour * 60 + minute;
  };
  const distance = Math.abs(toMinutes(first) - toMinutes(second));
  return Math.min(distance, 24 * 60 - distance);
}

function getDueCpLogisticsActions(settings, now = new Date()) {
  const runDate = cpDateKey(now);
  const activatedAt = new Date(settings?.activatedAt || 0);
  const actions = [
    { action: 'add', label: '添加', time: settings?.addTime, lastDate: settings?.lastAddDate },
    { action: 'remove', label: '删除', time: settings?.removeTime, lastDate: settings?.lastRemoveDate }
  ];
  return actions.filter(item => {
    if (item.lastDate === runDate) return false;
    if (settings?.blockedDate === runDate && settings?.blockedAction === item.action) return false;
    const scheduled = cpScheduledAt(item.time, now);
    if (now < scheduled) return false;
    if (!Number.isNaN(activatedAt.getTime()) && activatedAt > scheduled) return false;
    return true;
  }).map(item => ({ ...item, scheduledAt: cpScheduledAt(item.time, now) }))
    .sort((left, right) => left.scheduledAt - right.scheduledAt);
}

function resetChangedCpScheduleCompletions(current = {}, next = {}, bindingChanged = false) {
  return {
    lastAddDate: bindingChanged || current.addTime !== next.addTime ? '' : text(current.lastAddDate),
    lastRemoveDate: bindingChanged || current.removeTime !== next.removeTime ? '' : text(current.lastRemoveDate)
  };
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function parseAttributes(tag) {
  const result = {};
  const source = String(tag || '').replace(/^<\/?[a-z0-9:-]+/i, '').replace(/\/?\s*>$/, '');
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = pattern.exec(source))) {
    result[String(match[1]).toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return result;
}

function extractNamedControls(fragment) {
  const controls = [];
  const source = String(fragment || '');
  const controlPattern = /<input\b[^>]*>|<textarea\b[^>]*>[\s\S]*?<\/textarea>|<select\b[^>]*>[\s\S]*?<\/select>/gi;
  let match;
  while ((match = controlPattern.exec(source))) {
    const markup = match[0];
    const openTag = markup.match(/^<[^>]+>/)?.[0] || '';
    const attrs = parseAttributes(openTag);
    const name = text(attrs.name);
    if (!name || Object.prototype.hasOwnProperty.call(attrs, 'disabled')) continue;

    if (/^<input/i.test(markup)) {
      const type = text(attrs.type || 'text').toLowerCase();
      if ((type === 'checkbox' || type === 'radio') && !Object.prototype.hasOwnProperty.call(attrs, 'checked')) continue;
      controls.push([name, attrs.value ?? '']);
      continue;
    }

    if (/^<textarea/i.test(markup)) {
      const value = markup.replace(/^<textarea\b[^>]*>/i, '').replace(/<\/textarea>$/i, '');
      controls.push([name, decodeHtml(value)]);
      continue;
    }

    const isMultiple = Object.prototype.hasOwnProperty.call(attrs, 'multiple');
    const options = [...markup.matchAll(/<option\b[^>]*>[\s\S]*?<\/option>/gi)].map(optionMatch => {
      const optionMarkup = optionMatch[0];
      const optionTag = optionMarkup.match(/^<[^>]+>/)?.[0] || '';
      const optionAttrs = parseAttributes(optionTag);
      const label = decodeHtml(optionMarkup.replace(/^<option\b[^>]*>/i, '').replace(/<\/option>$/i, '').replace(/<[^>]+>/g, '')).trim();
      return {
        value: optionAttrs.value ?? label,
        selected: Object.prototype.hasOwnProperty.call(optionAttrs, 'selected')
      };
    });
    const selected = options.filter(option => option.selected);
    const effective = selected.length > 0 ? selected : (isMultiple ? [] : options.slice(0, 1));
    effective.forEach(option => controls.push([name, option.value]));
  }
  return controls;
}

function extractElement(markup, tagName, id) {
  const escapedId = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<${tagName}\\b[^>]*\\bid=["']${escapedId}["'][^>]*>[\\s\\S]*?<\\/${tagName}>`, 'i');
  return String(markup || '').match(pattern)?.[0] || '';
}

function parseServiceRows(html) {
  const table = extractElement(html, 'table', 'logisticeShipTable-alter');
  const rows = [];
  for (const rowMatch of table.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)) {
    const fields = extractNamedControls(rowMatch[0]).filter(([name]) => SERVICE_FIELD_NAMES.has(name));
    const shipperNo = fields.find(([name]) => name === 'shipIds')?.[1] || '';
    const serviceId = fields.find(([name]) => name === 'serviceIds')?.[1] || '';
    if (!shipperNo && !serviceId) continue;
    rows.push({ fields, shipperNo: text(shipperNo), serviceId: text(serviceId) });
  }
  return rows;
}

function parseWarehouseRows(html) {
  const table = extractElement(html, 'table', 'logisticeTable');
  const warehouses = [];
  for (const rowMatch of table.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)) {
    const rowMarkup = rowMatch[0];
    const rowAttrs = parseAttributes(rowMarkup.match(/^<tr\b[^>]*>/i)?.[0] || '');
    const controls = extractNamedControls(rowMarkup);
    const rawWarehouseNo = controls.find(([name]) => name === 'warehouseNos')?.[1] || rowAttrs['data-warehouseno'] || '';
    const warehouseNo = text(rawWarehouseNo).split('@')[0];
    if (!warehouseNo) continue;
    const selectedCooperationMode = controls.find(([name]) => name === 'editCooperationModel')?.[1];
    const existingMode = text(rawWarehouseNo).includes('@') ? text(rawWarehouseNo).split('@')[1] : '';
    warehouses.push({
      warehouseNo,
      cooperationMode: text(selectedCooperationMode || existingMode || '0') || '0'
    });
  }
  return warehouses;
}

function parseFormSnapshot(html) {
  const form = extractElement(html, 'form', 'logisticsServiceAlteration-form');
  if (!form) throw new Error('CP物流服务变更页面结构异常：未找到变更表单');
  const controls = extractNamedControls(form);
  const firstValue = name => controls.find(([field]) => field === name)?.[1] || '';
  const identity = {
    id: text(firstValue('id')),
    deptId: text(firstValue('deptId')),
    deptName: text(firstValue('deptName')),
    deptNo: text(firstValue('deptNo')),
    logisticsServiceNo: text(firstValue('logisticsServiceNo'))
  };
  if (!identity.id || !identity.deptId || !identity.deptNo || !identity.logisticsServiceNo) {
    throw new Error('CP物流服务变更页面结构异常：事业部或服务编号缺失');
  }
  return {
    identity,
    controls,
    serviceRows: parseServiceRows(form),
    warehouses: parseWarehouseRows(form)
  };
}

function normalizeDeptNo(value) {
  return text(value).toUpperCase().replace(/^CBU/, '').replace(/\s+/g, '');
}

function assertExpectedDepartment(identity, expected = {}) {
  const expectedDeptNo = normalizeDeptNo(expected.deptNo || expected.departmentId);
  const actualDeptNo = normalizeDeptNo(identity.deptNo || identity.deptId);
  if (expectedDeptNo && actualDeptNo !== expectedDeptNo) {
    throw new Error(`CP事业部校验失败：当前页面为“${identity.deptName || identity.deptNo}”`);
  }
  const expectedName = text(expected.deptName || expected.departmentName);
  if (!expectedDeptNo && expectedName && text(identity.deptName) !== expectedName) {
    throw new Error(`CP事业部校验失败：当前页面为“${identity.deptName || identity.deptNo}”`);
  }
}

function getWarehouseServiceValue(warehouseServiceMap, warehouseNo) {
  const rows = Array.isArray(warehouseServiceMap?.warehouseServices)
    ? warehouseServiceMap.warehouseServices
    : [];
  const matched = rows.find(item => text(item?.warehouseNo) === text(warehouseNo));
  if (!matched) return null;
  const enabled = matched.enableServices;
  if (Array.isArray(enabled)) return enabled.length > 0 ? enabled.map(value => String(value)) : null;
  if (enabled == null || enabled === '') return null;
  return [String(enabled)];
}

function buildWarehouseServiceJson(warehouses, warehouseServiceMap) {
  return JSON.stringify(warehouses.map(warehouse => ({
    warehouseNo: Number.isSafeInteger(Number(warehouse.warehouseNo))
      ? Number(warehouse.warehouseNo)
      : warehouse.warehouseNo,
    value: getWarehouseServiceValue(warehouseServiceMap, warehouse.warehouseNo)
  })));
}

function isTargetService(row) {
  return text(row?.serviceId) === TARGET_SERVICE_ID && text(row?.shipperNo) === TARGET_SHIPPER_NO;
}

function mutateServiceRows(serviceRows, action) {
  const rows = Array.isArray(serviceRows) ? serviceRows.map(row => ({ ...row, fields: [...row.fields] })) : [];
  const targetExists = rows.some(isTargetService);
  if (action === 'add') {
    if (targetExists) return { changed: false, rows, message: `${TARGET_SERVICE_LABEL}已存在，无需重复添加` };
    const conflicting = rows.find(row => text(row.serviceId) === TARGET_SERVICE_ID);
    if (conflicting) {
      throw new Error(`当前已存在其他仓配一体承运商（${conflicting.shipperNo || '未知编码'}），已停止自动添加`);
    }
    const fields = [
      ['shipIds', TARGET_SHIPPER_NO],
      ['serviceIds', TARGET_SERVICE_ID],
      ['isCashOnDeliverys', '0'],
      ['isGuarateeValues', '0'],
      ['expProductTypes', ''],
      ['sellerShipNos', ''],
      ['agingTypes', ''],
      ['isAllowModifyWb', '0'],
      ['scanpayTypes', '0'],
      ['deliverAgainInfos', '']
    ];
    rows.push({ fields, shipperNo: TARGET_SHIPPER_NO, serviceId: TARGET_SERVICE_ID });
    return { changed: true, rows, message: `准备添加${TARGET_SERVICE_LABEL}` };
  }
  if (action === 'remove') {
    if (!targetExists) return { changed: false, rows, message: `${TARGET_SERVICE_LABEL}已删除，无需重复操作` };
    return {
      changed: true,
      rows: rows.filter(row => !isTargetService(row)),
      message: `准备删除${TARGET_SERVICE_LABEL}`
    };
  }
  throw new Error('未知的CP物流服务操作');
}

function buildChangePayload(snapshot, warehouseServiceMap, action) {
  if (!snapshot?.warehouses?.length) throw new Error('当前事业部未获取到仓库，已停止物流服务变更');
  const mutation = mutateServiceRows(snapshot.serviceRows, action);
  if (!mutation.changed) return { ...mutation, payload: null };

  const params = new URLSearchParams();
  params.append('warehouseAddServiceJson', buildWarehouseServiceJson(snapshot.warehouses, warehouseServiceMap));

  for (const [name, value] of snapshot.controls) {
    if (SPECIAL_FIELD_NAMES.has(name)) continue;
    params.append(name, value);
  }

  params.append('serviceId-alter', action === 'add' ? TARGET_SERVICE_ID : '');
  params.append('shipperOption-alter', action === 'add' ? TARGET_SHIPPER_NO : '');
  mutation.rows.forEach(row => row.fields.forEach(([name, value]) => params.append(name, value)));
  snapshot.warehouses.forEach(warehouse => {
    params.append('warehouseNos', `${warehouse.warehouseNo}@${warehouse.cooperationMode}`);
  });

  const sparePartsValues = snapshot.controls
    .filter(([name]) => name === 'small_sparePartsStore')
    .map(([, value]) => text(value));
  const spStoreService = sparePartsValues.includes('1') && sparePartsValues.includes('2')
    ? '3'
    : sparePartsValues.includes('1')
    ? '1'
    : sparePartsValues.includes('2')
    ? '2'
    : '0';
  params.append('spStoreService', spStoreService);
  return { ...mutation, payload: params.toString() };
}

function createLogisticsListBody(start = 0, length = 100, csrfToken = '') {
  const columns = [
    ['', false],
    ['logisticsServiceNo', true],
    ['deptNo', true],
    ['deptName', true],
    ['sellerName', true],
    ['serviceName', true],
    ['statusName', true],
    ['createTimeStr', true],
    ['updateTimeStr', true]
  ];
  const aoData = [
    { name: 'sEcho', value: 1 },
    { name: 'iColumns', value: columns.length },
    { name: 'sColumns', value: columns.map(() => '').join(',') },
    { name: 'iDisplayStart', value: start },
    { name: 'iDisplayLength', value: length }
  ];
  columns.forEach(([name, sortable], index) => {
    aoData.push({ name: `mDataProp_${index}`, value: index === 0 ? 0 : name });
    aoData.push({ name: `bSortable_${index}`, value: sortable });
  });
  aoData.push(
    { name: 'iSortCol_0', value: 1 },
    { name: 'sSortDir_0', value: 'desc' },
    { name: 'iSortingCols', value: 1 }
  );
  const body = new URLSearchParams({
    csrfToken: text(csrfToken),
    sellerId: '',
    deptId: '',
    status: '',
    warehouseNo: '',
    warehouseName: '',
    aoData: JSON.stringify(aoData)
  });
  return body.toString();
}

function findDepartmentService(rows, expected = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const expectedDeptNo = normalizeDeptNo(expected.deptNo || expected.departmentId);
  const expectedDeptId = normalizeDeptNo(expected.deptId || expected.id);
  const expectedName = text(expected.deptName || expected.departmentName);
  const matches = list.filter(row => {
    const rowDeptNo = normalizeDeptNo(row?.deptNo);
    const rowDeptId = normalizeDeptNo(row?.deptId);
    if (expectedDeptNo && (rowDeptNo === expectedDeptNo || rowDeptId === expectedDeptNo)) return true;
    if (expectedDeptId && (rowDeptId === expectedDeptId || rowDeptNo === expectedDeptId)) return true;
    return !expectedDeptNo && !expectedDeptId && expectedName && text(row?.deptName) === expectedName;
  });
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    const exactName = matches.find(row => !expectedName || text(row?.deptName) === expectedName);
    return exactName || matches[0];
  }
  return matches[0];
}

function parseJson(textValue, label) {
  try {
    return JSON.parse(String(textValue || ''));
  } catch (_) {
    throw new Error(`${label}返回格式异常，可能需要重新登录CP端`);
  }
}

function isTruthyResponseValue(value) {
  return value === true || value === 1 || String(value || '').toLowerCase() === 'true';
}

class CpLogisticsServiceClient {
  constructor({ session, timeoutMs = 30000, now = () => Date.now(), bootstrapSession = null }) {
    if (!session || typeof session.fetch !== 'function') throw new Error('CP登录会话不可用');
    this.session = session;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.bootstrapSession = typeof bootstrapSession === 'function' ? bootstrapSession : null;
  }

  async request(pathname, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.session.fetch(new URL(pathname, CP_ORIGIN).toString(), {
        redirect: 'follow',
        credentials: 'include',
        ...options,
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`CP接口请求失败（HTTP ${response.status}）`);
      if (String(response.url || '').toLowerCase().includes('passport.jd.com')) {
        throw new Error('CP登录已失效，请重新登录云仓助手');
      }
      return response.text();
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('CP接口请求超时，请稍后重试');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  commonHeaders(contentType = '') {
    const headers = {
      Accept: '*/*',
      Referer: `${CP_ORIGIN}/goToMainIframe.do`,
      Origin: CP_ORIGIN,
      'X-Requested-With': 'XMLHttpRequest'
    };
    if (contentType) headers['Content-Type'] = contentType;
    return headers;
  }

  async getCsrfToken() {
    let cookies = await this.session.cookies.get({ url: `${CP_ORIGIN}/` });
    let token = cookies.find(cookie => cookie.name === 'csrfToken')?.value || '';
    let hasThor = cookies.some(cookie => cookie.name === 'thor');
    if ((!token || !hasThor) && this.bootstrapSession) {
      await this.bootstrapSession();
      cookies = await this.session.cookies.get({ url: `${CP_ORIGIN}/` });
      token = cookies.find(cookie => cookie.name === 'csrfToken')?.value || '';
      hasThor = cookies.some(cookie => cookie.name === 'thor');
    }
    if (!token || !hasThor) {
      throw new Error('CP登录Cookie不完整，请重新登录云仓助手');
    }
    return token;
  }

  async listLogisticsServices() {
    const pageSize = 100;
    const allRows = [];
    const csrfToken = await this.getCsrfToken();
    for (let start = 0; start < 2000; start += pageSize) {
      const responseText = await this.request(`/logistics/queryLogisticsServiceList.do?rand=${this.now()}`, {
        method: 'POST',
        headers: this.commonHeaders('application/x-www-form-urlencoded; charset=UTF-8'),
        body: createLogisticsListBody(start, pageSize, csrfToken)
      });
      const data = parseJson(responseText, 'CP物流服务列表');
      const rows = Array.isArray(data?.aaData) ? data.aaData : [];
      allRows.push(...rows);
      const total = Number(data?.iTotalDisplayRecords ?? data?.iTotalRecords ?? data?.recordsTotal ?? rows.length);
      if (rows.length < pageSize || allRows.length >= total) break;
    }
    return allRows;
  }

  async loadSnapshot(expectedDepartment) {
    const rows = await this.listLogisticsServices();
    const record = findDepartmentService(rows, expectedDepartment);
    if (!record?.id) throw new Error('当前登录账号中未找到固定事业部的物流服务记录');
    const csrfToken = await this.getCsrfToken();
    const query = new URLSearchParams({
      id: String(record.id),
      csrfToken,
      _: String(this.now())
    });
    const html = await this.request(`/logistics/gotoLogisticsServiceAlterationPage.do?${query}`, {
      method: 'GET',
      headers: this.commonHeaders('application/x-www-form-urlencoded; charset=UTF-8')
    });
    const snapshot = parseFormSnapshot(html);
    assertExpectedDepartment(snapshot.identity, expectedDepartment);
    const warehouseText = await this.request(`/logistics/getWarehouseAddService.do?id=${encodeURIComponent(snapshot.identity.id)}&_v=${this.now()}`, {
      method: 'GET',
      headers: this.commonHeaders()
    });
    const warehouseResult = parseJson(warehouseText, 'CP仓库增值服务');
    if (!isTruthyResponseValue(warehouseResult?.success) || !warehouseResult?.map) {
      throw new Error(warehouseResult?.message || 'CP仓库增值服务读取失败，已停止变更');
    }
    return { snapshot, warehouseServiceMap: warehouseResult.map };
  }

  async assertShipperCanBeRemoved(deptNo) {
    const query = new URLSearchParams({ shipNo: TARGET_SHIPPER_NO, deptNo });
    const responseText = await this.request(`/logistics/checkInShipperLine.do?${query}`, {
      method: 'GET',
      headers: this.commonHeaders()
    });
    const result = parseJson(responseText, 'CP承运商分单规则检查');
    if (Number(result?.resultCode) !== 200) {
      throw new Error(result?.resultMessage || 'CP承运商分单规则检查失败');
    }
    if (isTruthyResponseValue(result.resultData)) {
      throw new Error('青龙承运商仍在事业部分单规则中，已停止自动删除');
    }
  }

  async change(expectedDepartment, action) {
    const { snapshot, warehouseServiceMap } = await this.loadSnapshot(expectedDepartment);
    const prepared = buildChangePayload(snapshot, warehouseServiceMap, action);
    if (!prepared.changed) {
      return {
        success: true,
        changed: false,
        verified: true,
        message: prepared.message,
        identity: snapshot.identity,
        warehouseCount: snapshot.warehouses.length
      };
    }
    if (action === 'remove') await this.assertShipperCanBeRemoved(snapshot.identity.deptNo);

    const responseText = await this.request('/logistics/alterationLogisticsService.do', {
      method: 'POST',
      headers: this.commonHeaders('application/x-www-form-urlencoded; charset=UTF-8'),
      body: prepared.payload
    });
    const result = parseJson(responseText, 'CP物流服务变更');
    if (Number(result?.resultCode) !== 1) {
      throw new Error(result?.resultMessage || 'CP物流服务变更失败');
    }

    const verifiedState = await this.loadSnapshot(expectedDepartment);
    const exists = verifiedState.snapshot.serviceRows.some(isTargetService);
    const verified = action === 'add' ? exists : !exists;
    if (!verified) throw new Error('CP返回操作成功，但重新查询未确认生效');
    return {
      success: true,
      changed: true,
      verified: true,
      message: result.resultMessage || '操作成功！',
      identity: snapshot.identity,
      warehouseCount: snapshot.warehouses.length
    };
  }
}

module.exports = {
  CP_ORIGIN,
  MIN_CHANGE_INTERVAL_MS,
  TARGET_SERVICE_ID,
  TARGET_SHIPPER_NO,
  TARGET_SERVICE_LABEL,
  CpLogisticsServiceClient,
  assertExpectedDepartment,
  buildChangePayload,
  buildWarehouseServiceJson,
  cpDateKey,
  cpScheduledAt,
  cpScheduleDistanceMinutes,
  createLogisticsListBody,
  extractNamedControls,
  findDepartmentService,
  getDueCpLogisticsActions,
  isTargetService,
  mutateServiceRows,
  normalizeCpLogisticsTime,
  normalizeDeptNo,
  parseFormSnapshot,
  parseServiceRows,
  parseWarehouseRows,
  resetChangedCpScheduleCompletions
};
