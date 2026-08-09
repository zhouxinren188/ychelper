const assert = require('assert');
const { JSDOM } = require('jsdom');
const {
  WMS_WAREHOUSE_MULTI_LABEL_SELECTOR,
  WMS_WAREHOUSE_SECTION_SELECTOR,
  WMS_WAREHOUSE_SINGLE_LABEL_SELECTOR,
  classifyWmsPageUrl,
  isCompleteWmsWarehouseLabel,
  normalizeWmsWarehouseInfo,
  parseWarehouseLabel
} = require('../src/js/wmsPageState');

assert.strictEqual(
  classifyWmsPageUrl('https://unionwms.jdl.com/logon'),
  'warehouse-selection'
);
assert.strictEqual(
  classifyWmsPageUrl('https://unionwms.jdl.com/logon?from=passport'),
  'warehouse-selection'
);
assert.strictEqual(
  classifyWmsPageUrl('https://unionwms.jdl.com/default#/app-v/home/welcome'),
  'warehouse-workspace'
);
assert.strictEqual(
  classifyWmsPageUrl('https://unionwms.jdl.com/gray#/app-v/home/welcome'),
  'warehouse-workspace'
);
assert.strictEqual(
  classifyWmsPageUrl('https://unionwms.jdl.com.evil.example/default'),
  'other'
);

assert.deepStrictEqual(
  parseWarehouseLabel('宿迁沭阳禾思汇云仓3号库(800015947)'),
  {
    displayName: '宿迁沭阳禾思汇云仓3号库(800015947)',
    warehouseName: '宿迁沭阳禾思汇云仓3号库',
    warehouseNo: '800015947'
  }
);
assert.deepStrictEqual(
  parseWarehouseLabel('  测试仓（ABC_123）  '),
  { displayName: '测试仓（ABC_123）', warehouseName: '测试仓', warehouseNo: 'ABC_123' }
);
assert.deepStrictEqual(
  parseWarehouseLabel('仅仓库名称'),
  { displayName: '仅仓库名称', warehouseName: '仅仓库名称', warehouseNo: '' }
);
assert.strictEqual(isCompleteWmsWarehouseLabel('()'), false);
assert.strictEqual(isCompleteWmsWarehouseLabel('（ ）'), false);
assert.strictEqual(isCompleteWmsWarehouseLabel('仅仓库名称'), false);
assert.strictEqual(isCompleteWmsWarehouseLabel('宿迁沭阳禾思汇云仓3号库(800015947)'), true);
assert.deepStrictEqual(
  normalizeWmsWarehouseInfo({
    label: '宿迁沭阳禾思汇云仓3号库(800...',
    warehouseName: '宿迁沭阳禾思汇云仓3号库',
    warehouseNo: '800015947'
  }),
  {
    displayName: '宿迁沭阳禾思汇云仓3号库(800015947)',
    warehouseName: '宿迁沭阳禾思汇云仓3号库',
    warehouseNo: '800015947'
  }
);

const workspaceDom = new JSDOM(`
  <div class="right-menu">
    <div class="warehouse-container">
      <span class="warehouse-name">
        <section><div>宿迁沭阳禾思汇云仓3号库(800015947)</div></section>
      </span>
    </div>
  </div>
`);
assert.strictEqual(
  workspaceDom.window.document.querySelector(WMS_WAREHOUSE_SINGLE_LABEL_SELECTOR)?.textContent,
  '宿迁沭阳禾思汇云仓3号库(800015947)'
);

const multiWarehouseDom = new JSDOM(`
  <div class="right-menu">
    <div class="warehouse-container">
      <span class="warehouse-name">
        <section>
          <div class="el-tooltip el-dropdown">
            <span class="el-dropdown-link el-dropdown-selfdefine">
              <span>宿迁沭阳禾思汇云仓3号库(800015947)</span><i></i>
            </span>
            <ul style="display:none"><li>仓库1</li><li>仓库2</li><li>仓库3</li></ul>
          </div>
        </section>
      </span>
    </div>
  </div>
`);
assert.strictEqual(
  multiWarehouseDom.window.document.querySelector(WMS_WAREHOUSE_MULTI_LABEL_SELECTOR)?.textContent,
  '宿迁沭阳禾思汇云仓3号库(800015947)'
);
assert.ok(
  multiWarehouseDom.window.document.querySelector(WMS_WAREHOUSE_SECTION_SELECTOR)?.textContent.includes('仓库1')
);

const selectionDom = new JSDOM(`
  <div class="warehouse-name">
    <div>仓库1</div><div>仓库2</div><div>仓库3</div>
  </div>
`);
assert.strictEqual(
  selectionDom.window.document.querySelector(WMS_WAREHOUSE_MULTI_LABEL_SELECTOR),
  null
);
assert.strictEqual(
  selectionDom.window.document.querySelector(WMS_WAREHOUSE_SINGLE_LABEL_SELECTOR),
  null
);

console.log('WMS 页面状态测试通过');
