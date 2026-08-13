'use strict';

const crypto = require('crypto');
const { execFileSync } = require('child_process');

const MACHINE_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const MACHINE_CODE_PATTERN = /^YC-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;
const MACHINE_CODE_SOURCE = 'windows_smbios_machine_guid_account_sha256_v2';
const WINDOWS_MACHINE_GUID_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Cryptography';
const WINDOWS_SMBIOS_DATA_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\mssmbios\\Data';
const WINDOWS_BIOS_INFO_KEY = 'HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS';
const HARDWARE_IDENTITY_FIELDS = Object.freeze([
  'system_uuid',
  'system_serial',
  'baseboard_manufacturer',
  'baseboard_product',
  'baseboard_serial'
]);
const PLACEHOLDER_HARDWARE_VALUES = Object.freeze([
  /^0+$/i,
  /^f+$/i,
  /^none$/i,
  /^unknown$/i,
  /^not applicable$/i,
  /^not specified$/i,
  /^default string$/i,
  /^system serial number$/i,
  /^to be filled by o\.e\.m\.?$/i
]);

function isValidMachineCode(value) {
  return typeof value === 'string' && MACHINE_CODE_PATTERN.test(value);
}

function normalizeDeviceIdentity(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized.length < 16 || normalized.length > 256 || /^[0{}\s-]+$/.test(normalized)) {
    throw new Error('本机稳定设备信息格式无效');
  }
  return normalized;
}

function normalizeAccountIdentity(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('云仓助手账号标识格式无效');
  }
  return normalized;
}

function normalizeHardwareValue(value) {
  const normalized = typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').toLowerCase()
    : '';
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) return '';
  const compact = normalized.replace(/[{}\s:-]/g, '');
  if (!compact || PLACEHOLDER_HARDWARE_VALUES.some(pattern => pattern.test(normalized) || pattern.test(compact))) {
    return '';
  }
  return normalized;
}

function normalizeHardwareIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('本机主板信息格式无效');
  }

  const normalized = {};
  for (const field of HARDWARE_IDENTITY_FIELDS) {
    const fieldValue = normalizeHardwareValue(value[field]);
    if (fieldValue) normalized[field] = fieldValue;
  }
  if (Object.keys(normalized).length === 0) {
    throw new Error('未读取到可用的本机主板信息');
  }
  return normalized;
}

function runRegistryQuery(run, args) {
  return run('reg.exe', args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 4 * 1024 * 1024
  });
}

function readWindowsMachineGuid(run = execFileSync, platform = process.platform) {
  if (platform !== 'win32') {
    throw new Error('当前系统不支持读取 Windows MachineGuid');
  }

  let output;
  try {
    output = runRegistryQuery(run, ['query', WINDOWS_MACHINE_GUID_KEY, '/v', 'MachineGuid']);
  } catch {
    throw new Error('无法读取 Windows MachineGuid');
  }

  const line = String(output || '').split(/\r?\n/).find(item => /\bMachineGuid\b/i.test(item));
  const match = line && line.match(/\bMachineGuid\b\s+REG_\w+\s+(.+?)\s*$/i);
  if (!match) {
    throw new Error('Windows MachineGuid 返回格式无效');
  }
  return normalizeDeviceIdentity(match[1]);
}

function readSmbiosStrings(buffer, start) {
  const strings = [];
  if (start >= buffer.length) return { strings, nextOffset: buffer.length };
  if (buffer[start] === 0 && buffer[start + 1] === 0) {
    return { strings, nextOffset: start + 2 };
  }

  let cursor = start;
  while (cursor < buffer.length) {
    const end = buffer.indexOf(0, cursor);
    if (end < 0) return { strings, nextOffset: buffer.length };
    strings.push(buffer.subarray(cursor, end).toString('utf8').trim());
    cursor = end + 1;
    if (buffer[cursor] === 0) {
      return { strings, nextOffset: cursor + 1 };
    }
  }
  return { strings, nextOffset: buffer.length };
}

function getSmbiosString(strings, index) {
  return Number.isInteger(index) && index > 0 ? strings[index - 1] || '' : '';
}

function parseSmbiosTable(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 6) {
    throw new Error('SMBIOS 主板数据格式无效');
  }

  const identity = {};
  let offset = 0;
  let tableEnd = buffer.length;
  if (buffer.length >= 12) {
    const declaredTableLength = buffer.readUInt32LE(4);
    if (declaredTableLength > 0 && declaredTableLength <= buffer.length - 8 && buffer[9] >= 4) {
      offset = 8;
      tableEnd = 8 + declaredTableLength;
    }
  }
  while (offset + 4 <= tableEnd) {
    const type = buffer[offset];
    const length = buffer[offset + 1];
    if (length < 4 || offset + length > tableEnd) break;

    const { strings, nextOffset } = readSmbiosStrings(buffer, offset + length);
    if (type === 1) {
      identity.system_serial = getSmbiosString(strings, buffer[offset + 7]);
      if (length >= 24) {
        const uuid = buffer.subarray(offset + 8, offset + 24);
        const uuidHex = uuid.toString('hex');
        if (!/^0+$/.test(uuidHex) && !/^f+$/i.test(uuidHex)) identity.system_uuid = uuidHex;
      }
    } else if (type === 2) {
      identity.baseboard_manufacturer = getSmbiosString(strings, buffer[offset + 4]);
      identity.baseboard_product = getSmbiosString(strings, buffer[offset + 5]);
      identity.baseboard_serial = getSmbiosString(strings, buffer[offset + 7]);
    }

    if (type === 127 || nextOffset <= offset) break;
    offset = nextOffset;
  }
  return normalizeHardwareIdentity(identity);
}

function parseRegistryBinary(output, valueName) {
  const escapedName = String(valueName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = String(output || '').split(/\r?\n/).find(item => new RegExp(`\\b${escapedName}\\b`, 'i').test(item));
  const match = line && line.match(/\bREG_BINARY\b\s+([0-9a-f]+)\s*$/i);
  if (!match || match[1].length % 2 !== 0) throw new Error('SMBIOS 主板数据返回格式无效');
  return Buffer.from(match[1], 'hex');
}

function parseBiosRegistryIdentity(output) {
  const values = {};
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9]+)\s+REG_\w+\s+(.+?)\s*$/);
    if (match) values[match[1]] = match[2];
  }
  return normalizeHardwareIdentity({
    baseboard_manufacturer: values.BaseBoardManufacturer,
    baseboard_product: values.BaseBoardProduct
  });
}

function readWindowsHardwareIdentity(run = execFileSync, platform = process.platform) {
  if (platform !== 'win32') {
    throw new Error('当前系统不支持读取 Windows 主板信息');
  }

  try {
    const output = runRegistryQuery(run, ['query', WINDOWS_SMBIOS_DATA_KEY, '/v', 'SMBiosData']);
    return parseSmbiosTable(parseRegistryBinary(output, 'SMBiosData'));
  } catch {
    try {
      const output = runRegistryQuery(run, ['query', WINDOWS_BIOS_INFO_KEY]);
      return parseBiosRegistryIdentity(output);
    } catch {
      throw new Error('无法读取可用的 Windows 主板信息');
    }
  }
}

function getMachineCodeAccountKey(accountIdentity) {
  const normalizedAccount = normalizeAccountIdentity(accountIdentity);
  return crypto
    .createHash('sha256')
    .update(`ychelper-machine-code-account-v1\0${normalizedAccount}`, 'utf8')
    .digest('hex');
}

function deriveMachineCode(hardwareIdentity, machineGuid, accountIdentity) {
  const normalizedHardware = normalizeHardwareIdentity(hardwareIdentity);
  const normalizedMachineGuid = normalizeDeviceIdentity(machineGuid);
  const normalizedAccount = normalizeAccountIdentity(accountIdentity);
  const hardwarePayload = HARDWARE_IDENTITY_FIELDS
    .filter(field => normalizedHardware[field])
    .map(field => `${field}=${normalizedHardware[field]}`)
    .join('\n');
  const digest = crypto
    .createHash('sha256')
    .update(`ychelper-machine-code-v3\0${hardwarePayload}\0${normalizedMachineGuid}\0${normalizedAccount}`, 'utf8')
    .digest();

  let value = BigInt(`0x${digest.subarray(0, 5).toString('hex')}`);
  const encoded = new Array(8);
  for (let index = encoded.length - 1; index >= 0; index--) {
    encoded[index] = MACHINE_CODE_ALPHABET[Number(value & 31n)];
    value >>= 5n;
  }

  const payload = encoded.join('');
  return `YC-${payload.slice(0, 4)}-${payload.slice(4)}`;
}

function getOrCreateMachineCode(options = {}) {
  if (typeof options.load !== 'function' || typeof options.save !== 'function') {
    throw new Error('机器码存储需要 load/save 适配器');
  }
  const accountIdentity = normalizeAccountIdentity(options.accountIdentity);

  const existing = options.load();
  if (existing !== null && existing !== undefined && existing !== '') {
    if (!isValidMachineCode(existing)) {
      throw new Error('本机已保存的机器码格式损坏，已停止生成新机器码以避免账号路由漂移');
    }
    return existing;
  }

  let hardwareIdentity;
  let machineGuid;
  try {
    const readHardwareIdentity = typeof options.readHardwareIdentity === 'function'
      ? options.readHardwareIdentity
      : readWindowsHardwareIdentity;
    const readMachineGuid = typeof options.readMachineGuid === 'function'
      ? options.readMachineGuid
      : readWindowsMachineGuid;
    hardwareIdentity = readHardwareIdentity();
    machineGuid = readMachineGuid();
  } catch (error) {
    throw new Error(`无法根据本机主板、系统和账号信息生成机器码: ${error.message}`);
  }

  const machineCode = deriveMachineCode(hardwareIdentity, machineGuid, accountIdentity);
  if (options.save(machineCode) === false) {
    throw new Error('机器码无法持久化，已停止启用订单执行端');
  }

  const persisted = options.load();
  if (persisted !== machineCode) {
    throw new Error('机器码持久化复验失败，已停止启用订单执行端');
  }
  return machineCode;
}

module.exports = {
  HARDWARE_IDENTITY_FIELDS,
  MACHINE_CODE_ALPHABET,
  MACHINE_CODE_PATTERN,
  MACHINE_CODE_SOURCE,
  WINDOWS_BIOS_INFO_KEY,
  WINDOWS_MACHINE_GUID_KEY,
  WINDOWS_SMBIOS_DATA_KEY,
  deriveMachineCode,
  getMachineCodeAccountKey,
  getOrCreateMachineCode,
  isValidMachineCode,
  normalizeAccountIdentity,
  normalizeDeviceIdentity,
  normalizeHardwareIdentity,
  parseSmbiosTable,
  readWindowsHardwareIdentity,
  readWindowsMachineGuid
};
