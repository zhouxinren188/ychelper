'use strict';

const assert = require('assert');
const {
  MACHINE_CODE_PATTERN,
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
} = require('../machine-code');

function makeSmbiosTable() {
  const system = Buffer.alloc(24);
  system[0] = 1;
  system[1] = 24;
  system[7] = 1;
  Buffer.from('00112233445566778899aabbccddeeff', 'hex').copy(system, 8);

  const baseboard = Buffer.alloc(8);
  baseboard[0] = 2;
  baseboard[1] = 8;
  baseboard[4] = 1;
  baseboard[5] = 2;
  baseboard[6] = 3;
  baseboard[7] = 4;

  return Buffer.concat([
    system,
    Buffer.from('SYSTEM-SERIAL\0\0', 'utf8'),
    baseboard,
    Buffer.from('BOARD-VENDOR\0BOARD-PRODUCT\0BOARD-VERSION\0BOARD-SERIAL-001\0\0', 'utf8'),
    Buffer.from([127, 4, 0, 0, 0, 0])
  ]);
}

const machineGuid = 'A1B2C3D4-E5F6-47A8-9B01-23456789ABCD';
const accountIdentity = 'Cloud-Account-001';
const hardwareIdentity = {
  system_uuid: '00112233445566778899AABBCCDDEEFF',
  system_serial: 'SYSTEM-SERIAL',
  baseboard_manufacturer: 'BOARD-VENDOR',
  baseboard_product: 'BOARD-PRODUCT',
  baseboard_serial: 'BOARD-SERIAL-001'
};
const derived = deriveMachineCode(hardwareIdentity, machineGuid, accountIdentity);
assert.match(derived, MACHINE_CODE_PATTERN);
assert.strictEqual(
  deriveMachineCode(hardwareIdentity, machineGuid.toLowerCase(), accountIdentity.toLowerCase()),
  derived
);
assert.notStrictEqual(
  deriveMachineCode({ ...hardwareIdentity, baseboard_serial: 'BOARD-SERIAL-002' }, machineGuid, accountIdentity),
  derived,
  '同一账号在不同主板设备上必须得到不同机器码'
);
assert.notStrictEqual(
  deriveMachineCode(hardwareIdentity, 'B1B2C3D4-E5F6-47A8-9B01-23456789ABCD', accountIdentity),
  derived,
  '同一主板信息但不同 Windows 设备实例必须得到不同机器码'
);
assert.notStrictEqual(
  deriveMachineCode(hardwareIdentity, machineGuid, 'Cloud-Account-002'),
  derived,
  '同一设备的不同账号必须得到不同机器码'
);
assert.strictEqual(normalizeDeviceIdentity(`  ${machineGuid}  `), machineGuid.toLowerCase());
assert.strictEqual(normalizeAccountIdentity(`  ${accountIdentity}  `), accountIdentity.toLowerCase());
assert.strictEqual(normalizeHardwareIdentity({ baseboard_serial: '  ABC-001  ' }).baseboard_serial, 'abc-001');
assert.throws(() => normalizeDeviceIdentity('0000-0000'), /格式无效/);
assert.throws(() => normalizeAccountIdentity(''), /格式无效/);
assert.throws(() => normalizeHardwareIdentity({ baseboard_serial: 'To be filled by O.E.M.' }), /未读取到/);
assert.strictEqual(getMachineCodeAccountKey(accountIdentity), getMachineCodeAccountKey(accountIdentity.toLowerCase()));
assert.notStrictEqual(getMachineCodeAccountKey(accountIdentity), getMachineCodeAccountKey('Cloud-Account-002'));

const smbiosData = makeSmbiosTable();
const parsedHardware = parseSmbiosTable(smbiosData);
assert.deepStrictEqual(parsedHardware, {
  system_uuid: '00112233445566778899aabbccddeeff',
  system_serial: 'system-serial',
  baseboard_manufacturer: 'board-vendor',
  baseboard_product: 'board-product',
  baseboard_serial: 'board-serial-001'
});
const rawSmbiosHeader = Buffer.alloc(8);
rawSmbiosHeader[1] = 3;
rawSmbiosHeader[2] = 5;
rawSmbiosHeader.writeUInt32LE(smbiosData.length, 4);
assert.deepStrictEqual(
  parseSmbiosTable(Buffer.concat([rawSmbiosHeader, smbiosData])),
  parsedHardware,
  '必须兼容 Windows 注册表 RawSMBIOSData 的 8 字节头部'
);

const registryInvocations = [];
const registryRunner = (file, args, options) => {
  registryInvocations.push({ file, args, options });
  if (args.includes(WINDOWS_SMBIOS_DATA_KEY)) {
    return `\r\n    SMBiosData    REG_BINARY    ${smbiosData.toString('hex')}\r\n`;
  }
  return `\r\n${WINDOWS_MACHINE_GUID_KEY}\r\n    MachineGuid    REG_SZ    ${machineGuid}\r\n`;
};
assert.deepStrictEqual(readWindowsHardwareIdentity(registryRunner, 'win32'), parsedHardware);
assert.strictEqual(readWindowsMachineGuid(registryRunner, 'win32'), machineGuid.toLowerCase());
assert.strictEqual(registryInvocations.every(item => item.file === 'reg.exe'), true);
assert.strictEqual(registryInvocations.every(item => !Object.prototype.hasOwnProperty.call(item.options, 'shell')), true);
assert.deepStrictEqual(registryInvocations[0].args, [
  'query',
  WINDOWS_SMBIOS_DATA_KEY,
  '/v',
  'SMBiosData'
]);
assert.throws(() => readWindowsMachineGuid(() => '', 'linux'), /不支持/);
assert.throws(() => readWindowsHardwareIdentity(() => '', 'linux'), /不支持/);

let persisted = null;
let saveCount = 0;
let hardwareReadCount = 0;
let machineGuidReadCount = 0;
const storage = {
  accountIdentity,
  load: () => persisted,
  save: value => {
    saveCount++;
    persisted = value;
    return true;
  },
  readHardwareIdentity: () => {
    hardwareReadCount++;
    return hardwareIdentity;
  },
  readMachineGuid: () => {
    machineGuidReadCount++;
    return machineGuid;
  }
};
const first = getOrCreateMachineCode(storage);
const second = getOrCreateMachineCode(storage);
assert.strictEqual(first, derived);
assert.strictEqual(second, first);
assert.strictEqual(saveCount, 1, '已生成机器码不得重新保存');
assert.strictEqual(hardwareReadCount, 1, '已有机器码时不得再次读取主板信息');
assert.strictEqual(machineGuidReadCount, 1, '已有机器码时不得再次读取 MachineGuid');

assert.throws(
  () => getOrCreateMachineCode({ accountIdentity, load: () => 'broken', save: () => true }),
  /格式损坏/
);
assert.throws(
  () => getOrCreateMachineCode({
    accountIdentity,
    load: () => null,
    save: () => false,
    readHardwareIdentity: () => hardwareIdentity,
    readMachineGuid: () => machineGuid
  }),
  /无法持久化/
);
assert.throws(
  () => getOrCreateMachineCode({
    accountIdentity,
    load: () => null,
    save: () => true,
    readHardwareIdentity: () => { throw new Error('registry unavailable'); },
    readMachineGuid: () => machineGuid
  }),
  /无法根据本机主板、系统和账号信息生成机器码/
);
assert.strictEqual(isValidMachineCode('YC-7F3K-92MX'), true);
assert.strictEqual(isValidMachineCode('yc-7f3k-92mx'), false);

console.log('机器码测试通过：按需生成、主板/系统/账号组合派生、固定注册表读取、持久化复验与重启稳定均已覆盖');
