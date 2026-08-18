'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const {
  collectUniqueSkuValues,
  groupGoodsByProduct,
  removeGoodsByTarget,
  selectGoodsPerProduct
} = require('../src/js/shopGoodsSelection');

const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src', 'js', 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src', 'css', 'style.css'), 'utf8');

const firstNPosition = indexHtml.indexOf('value="前N个"');
const randomNPosition = indexHtml.indexOf('value="N个"');
assert(firstNPosition >= 0 && randomNPosition > firstNPosition,
  'SKU前N个选项必须存在并位于随机N个之前');
assert.match(indexHtml, /id="smFirstQtyN"/,
  'SKU前N个必须有独立的数量输入框');
assert.match(renderer, /sm_goodsFirstQtyN/,
  'SKU前N个数量必须保存并在下次启动恢复');
assert.match(renderer, /class="sm-spu-check"/,
  'SPU主行必须使用独立的整组勾选框，不能复用第一条SKU索引');
assert(
  indexHtml.indexOf('<th>状态</th>') > 0 &&
  indexHtml.indexOf('<th>状态</th>') < indexHtml.indexOf('<th>操作日期</th>'),
  '状态列必须位于操作日期前'
);
assert.match(renderer, /item\.skuName \|\| item\.name/,
  '展开后的SKU标题必须优先显示SKU名称和规格选项');
assert.match(renderer, /sm-status-badge is-on-sale/,
  '售卖中商品必须显示状态徽标');
assert.match(renderer, /sm-status-badge is-off-shelf/,
  '已下架商品必须显示状态徽标');
assert.match(indexHtml, /id="smGoodsCtxMenu"/,
  '商品列表必须提供独立的右键操作菜单');
assert.match(renderer, /addEventListener\('contextmenu', handleSmGoodsContextMenu\)/,
  '商品列表必须绑定 SPU/SKU 右键菜单事件');
assert.match(indexHtml, /id="smCtxToggleSelection"/,
  '商品右键菜单必须提供勾选与取消勾选操作');
assert.match(renderer, /target\.isChecked \? '取消勾选' : '勾选'/,
  '右键菜单必须根据当前行勾选状态切换操作文案');
assert.match(styles, /\.sm-action-row\s*\{[^}]*justify-content:\s*center;/s,
  '快速打标查询操作按钮组必须居中对齐');
assert.match(styles, /\.sm-goods-ctx-menu \.ctx-menu-item:hover/,
  '商品右键菜单必须提供清晰的悬停反馈');
const selectedSkuFunction = renderer.slice(
  renderer.indexOf('function getSelectedSmSkus()'),
  renderer.indexOf('// ========== 导出 TXT ==========')
);
assert.match(selectedSkuFunction, /\.sm-sku-row \.sm-goods-check/,
  '导出和发送只能读取SKU子行，不能把SPU主行重复计入');

const goods = [
  ...[10, 20, 30, 40, 50, 60].map((price, index) => ({
    productCode: 'A', sku: `A${index + 1}`, price
  })),
  { productCode: 'B', sku: 'B1', price: 5 },
  { productCode: 'B', sku: 'B2', price: 1 },
  { productCode: 'B', sku: 'B3', price: 3 },
  { productCode: 'C', sku: 'C1', price: null },
  { productCode: 'C', sku: 'C2', price: null }
];

assert.deepStrictEqual(groupGoodsByProduct(goods).map(group => group.length), [6, 3, 2]);
assert.deepStrictEqual(
  selectGoodsPerProduct(goods, '第1个').map(item => item.sku),
  ['A1', 'B1', 'C1']
);
assert.deepStrictEqual(
  selectGoodsPerProduct(goods, '最后1个').map(item => item.sku),
  ['A6', 'B3', 'C2']
);
assert.deepStrictEqual(
  selectGoodsPerProduct(goods, '最低价').map(item => item.sku),
  ['A1', 'B2', 'C1']
);
assert.deepStrictEqual(
  selectGoodsPerProduct(goods, '最高价').map(item => item.sku),
  ['A6', 'B1', 'C1']
);
assert.deepStrictEqual(
  selectGoodsPerProduct(goods, '前N个', 2).map(item => item.sku),
  ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']
);

const randomFive = selectGoodsPerProduct(goods, 'N个', 5, () => 0.25);
const randomCounts = randomFive.reduce((counts, item) => {
  counts[item.productCode] = (counts[item.productCode] || 0) + 1;
  return counts;
}, {});
assert.deepStrictEqual(randomCounts, { A: 5, B: 3, C: 2 });
assert.strictEqual(new Set(randomFive.map(item => item.sku)).size, randomFive.length);
assert.strictEqual(randomFive.length, 10);
assert.strictEqual(selectGoodsPerProduct(goods, '全部').length, goods.length);
assert.deepStrictEqual(
  collectUniqueSkuValues(goods, [0, 0, 1, 99, 2]),
  ['A1', 'A2', 'A3'],
  '选择结果必须去重，并忽略越界或空SKU'
);

// 单个SPU原有8个SKU，价格筛选后只剩4个时，“随机5个”应全部保留这4个，不重复补足。
const eightSkuProduct = Array.from({ length: 8 }, (item, index) => ({
  productCode: 'D',
  sku: `D${index + 1}`,
  price: (index + 1) * 10
}));
const fourAfterPriceFilter = eightSkuProduct.filter(item => item.price >= 50);
const upToFive = selectGoodsPerProduct(fourAfterPriceFilter, 'N个', 5, () => 0.5);
assert.strictEqual(fourAfterPriceFilter.length, 4);
assert.deepStrictEqual(upToFive.map(item => item.sku), ['D5', 'D6', 'D7', 'D8']);
assert.deepStrictEqual(
  selectGoodsPerProduct(fourAfterPriceFilter, '前N个', 5).map(item => item.sku),
  ['D5', 'D6', 'D7', 'D8']
);

const missingCodes = [{ sku: 'X1' }, { sku: 'X2' }];
assert.deepStrictEqual(
  selectGoodsPerProduct(missingCodes, '第1个').map(item => item.sku),
  ['X1', 'X2']
);

const removableGoods = [
  { productCode: 'A', sku: 'A1' },
  { productCode: 'A', sku: 'A2' },
  { productCode: 'B', sku: 'B1' }
];
assert.deepStrictEqual(
  removeGoodsByTarget(removableGoods, { type: 'spu', item: removableGoods[0] }).map(item => item.sku),
  ['B1'],
  '删除 SPU 时必须删除该商品下的全部 SKU'
);
assert.deepStrictEqual(
  removeGoodsByTarget(removableGoods, { type: 'sku', item: removableGoods[0] }).map(item => item.sku),
  ['A2', 'B1'],
  '删除 SKU 时只能删除当前 SKU'
);
assert.deepStrictEqual(
  removeGoodsByTarget(removableGoods, { type: 'spu', item: { productCode: ' A ' } }).map(item => item.sku),
  ['B1'],
  '删除 SPU 时必须规范化商品编码两侧空格'
);
const invalidRemovalResult = removeGoodsByTarget(removableGoods, { type: 'unknown', item: removableGoods[0] });
assert.deepStrictEqual(invalidRemovalResult, removableGoods, '无效删除目标不得改变商品内容');
assert.notStrictEqual(invalidRemovalResult, removableGoods, '无效删除目标也必须返回独立数组');
assert.deepStrictEqual(removableGoods.map(item => item.sku), ['A1', 'A2', 'B1'],
  '删除筛选不得原地修改原商品数组');

const contextMenuDom = new JSDOM(`
  <div id="smGoodsCtxMenu" style="display:none">
    <button id="smCtxToggleSelection">勾选</button>
    <button id="smCtxDelete">删除</button>
  </div>
  <span id="smSelectedCount"></span>
  <input id="smSelectAll" type="checkbox" />
  <table><tbody id="smGoodsTableBody">
    <tr class="sm-spu-row" data-group-key="A" data-item-idx="0">
      <td><input class="sm-spu-check" type="checkbox" /></td>
    </tr>
    <tr class="sm-sku-row" data-group-key="A" data-item-idx="0">
      <td><input class="sm-goods-check" type="checkbox" /></td>
    </tr>
    <tr class="sm-sku-row" data-group-key="A" data-item-idx="1">
      <td><input class="sm-goods-check" type="checkbox" /></td>
    </tr>
  </tbody></table>
`);
const contextDocument = contextMenuDom.window.document;
const contextMenuTestScope = {
  window: contextMenuDom.window,
  document: contextDocument,
  smGoodsCtxMenu: contextDocument.querySelector('#smGoodsCtxMenu'),
  smCtxToggleSelection: contextDocument.querySelector('#smCtxToggleSelection'),
  smCtxDelete: contextDocument.querySelector('#smCtxDelete'),
  smGoodsTableBody: contextDocument.querySelector('#smGoodsTableBody'),
  smSelectedCount: contextDocument.querySelector('#smSelectedCount'),
  smGoodsContextTarget: null,
  smQueryRunning: false,
  smGoods: removableGoods,
  smFilteredGoods: removableGoods,
  showToast: () => {},
  $: selector => contextDocument.querySelector(selector)
};
contextMenuTestScope.getSmSkuRowsForGroup = groupKey =>
  Array.from(contextMenuTestScope.smGoodsTableBody.querySelectorAll('.sm-sku-row'))
    .filter(row => row.dataset.groupKey === groupKey);
const contextMenuFunctions = renderer.slice(
  renderer.indexOf('function hideSmGoodsContextMenu()'),
  renderer.indexOf('function deleteSmGoodsContextTarget()')
);
const selectionSyncFunction = renderer.slice(
  renderer.indexOf('function syncSmSelectionCheckboxes()'),
  renderer.indexOf('function applySmQtyFilter()')
);
vm.runInNewContext(`${contextMenuFunctions}\n${selectionSyncFunction}`, contextMenuTestScope);

const contextSpuRow = contextDocument.querySelector('.sm-spu-row');
const contextSkuRows = Array.from(contextDocument.querySelectorAll('.sm-sku-row'));
const contextSkuChecks = contextSkuRows.map(row => row.querySelector('.sm-goods-check'));
const contextSpuCheck = contextSpuRow.querySelector('.sm-spu-check');

contextSkuChecks[0].checked = true;
contextSkuChecks[1].checked = false;
contextMenuTestScope.syncSmSelectionCheckboxes();
assert.strictEqual(contextSpuCheck.indeterminate, true, '部分 SKU 勾选时 SPU 必须处于半选状态');
const createContextMenuEvent = target => ({
  target,
  clientX: 12,
  clientY: 18,
  preventDefault() {}
});
contextMenuTestScope.handleSmGoodsContextMenu(createContextMenuEvent(contextSpuRow));
assert.strictEqual(contextMenuTestScope.smCtxToggleSelection.textContent, '勾选',
  'SPU 半选时右键菜单必须显示勾选');
contextMenuTestScope.toggleSmGoodsContextSelection();
assert.deepStrictEqual(contextSkuChecks.map(checkbox => checkbox.checked), [true, true],
  'SPU 右键勾选必须勾选整组 SKU');

contextMenuTestScope.handleSmGoodsContextMenu(createContextMenuEvent(contextSpuRow));
assert.strictEqual(contextMenuTestScope.smCtxToggleSelection.textContent, '取消勾选',
  'SPU 全选时右键菜单必须显示取消勾选');
contextMenuTestScope.toggleSmGoodsContextSelection();
assert.deepStrictEqual(contextSkuChecks.map(checkbox => checkbox.checked), [false, false],
  'SPU 右键取消勾选必须取消整组 SKU');

contextMenuTestScope.handleSmGoodsContextMenu(createContextMenuEvent(contextSkuRows[0]));
contextMenuTestScope.toggleSmGoodsContextSelection();
assert.deepStrictEqual(contextSkuChecks.map(checkbox => checkbox.checked), [true, false],
  'SKU 右键勾选只能改变当前 SKU');

console.log('店铺商品“每个SPU取SKU”筛选测试通过');
