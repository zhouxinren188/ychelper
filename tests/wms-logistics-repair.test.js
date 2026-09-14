'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
const excelGenerator = require('../src/js/excelGenerator');
const {
  buildWmsMissingLogisticsQuery,
  getWmsScanRecord,
  needsWmsLogisticsRepair,
  normalizeWmsMissingLogisticsItems
} = require('../src/js/wmsLogisticsRepair');

const scanResponse = {
  success: true,
  resultValue: [
    { inboundNo: 'CPL-1', ownerNo: 'CBU-1', newSkuCollectType: '1' }
  ]
};
const scanRecord = getWmsScanRecord(scanResponse, 'CPL-1');
assert.strictEqual(scanRecord.ownerNo, 'CBU-1');
assert.strictEqual(needsWmsLogisticsRepair(scanRecord), true);
assert.strictEqual(needsWmsLogisticsRepair({ newSkuCollectType: 0 }), false);
assert.deepStrictEqual(
  buildWmsMissingLogisticsQuery(' CPL-1 ', ' 80001 '),
  { navigatorNo: 'CPL-1', probe_anchor_warehouseNo: '80001' }
);

assert.deepStrictEqual(
  normalizeWmsMissingLogisticsItems({
    resultValue: [
      { sku: ' CMG1 ', isvSku: 'SKU1', skuName: '商品1' },
      { sku: 'CMG1', isvSku: 'SKU1-重复' },
      { sku: 'CMG2', isvSku: 'SKU2' },
      { sku: '' }
    ]
  }),
  [
    { sku: 'CMG1', isvSku: 'SKU1', skuName: '商品1' },
    { sku: 'CMG2', isvSku: 'SKU2', skuName: '' }
  ]
);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ych-wms-logistics-test-'));
try {
  excelGenerator.setOutputDir(tempDir);
  const filePath = excelGenerator.generateGoodsLogistics(['CMG1'], {
    departmentId: 'CBU-IGNORED',
    length: 210,
    width: 150,
    height: 100,
    weight: 0.5,
    useDepartmentGoodsCode: true,
    outputFileName: '../auto-repair-test.xls'
  });
  assert.strictEqual(path.dirname(filePath), tempDir, '输出文件名不得越过配置的输出目录');
  const workbook = XLSX.readFile(filePath);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
    header: 1,
    raw: true,
    defval: ''
  });
  assert.deepStrictEqual(rows[1], ['CMG1', '', '', 210, 150, 100, '', 0.5]);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

const rootDir = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(rootDir, 'main.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(rootDir, 'src', 'js', 'renderer.js'), 'utf8');
assert.match(mainSource, /\/receiving\/orderCenter\/queryInboundOrderNewSku/);
assert.match(mainSource, /needsLogistics:\s*true/);
assert.doesNotMatch(rendererSource, /ownerNo !== currentDeptNo/);
assert.match(rendererSource, /for \(const requirement of requirements\)/);
assert.match(rendererSource, /WMS_LOGISTICS_REPAIR_COOLDOWN_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/);
assert.match(rendererSource, /1分钟后自动重试/);

console.log('WMS 缺物流属性自动补录测试通过');
