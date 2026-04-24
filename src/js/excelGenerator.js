/**
 * Excel 模板生成模块
 * 根据模板格式自动填充数据并生成 .xls 文件
 */

const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

// 输出目录（应用数据目录下的 output 文件夹）
let outputDir = '';

function setOutputDir(dir) {
  outputDir = dir;
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
}

/**
 * 生成 PopGoodsImportTemplate.xls
 * 导入店铺商品：3列全部填充 SKU
 */
function generatePopGoodsImport(skus) {
  const header = ['POP店铺商品编号', '商家商品标识', '商品条码'];
  const rows = [header];

  skus.forEach(sku => {
    rows.push([sku, sku, sku]);
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'POP商品导入');

  const filePath = path.join(outputDir, 'PopGoodsImportTemplate.xls');
  XLSX.writeFile(wb, filePath, { bookType: 'xls' });
  return filePath;
}

/**
 * 生成 GoodsLogisticsTemplate.xls
 * 维护物流属性：事业部编码 + SKU + 长宽高 + 毛重
 */
function generateGoodsLogistics(skus, { departmentId, length, width, height }) {
  const header = [
    '事业部商品编码\n（若此列不为空，以此编码获取的商品为准）',
    '事业部编码\n（事业部商品编码为空时必填）',
    '商家商品编号\n（事业部商品编码为空时必填）',
    '长(mm)\n（必填，大于0）',
    '宽(mm)\n（必填，大于0）',
    '高(mm)\n（必填，大于0）',
    '净重(kg)',
    '毛重(kg)\n（必填，大于0）'
  ];
  const rows = [header];

  skus.forEach(sku => {
    rows.push([
      '',                          // 第1列：不填
      departmentId,                // 第2列：事业部编号
      sku,                         // 第3列：SKU
      parseFloat(length) || 0,     // 第4列：长
      parseFloat(width) || 0,      // 第5列：宽
      parseFloat(height) || 0,     // 第6列：高
      '',                          // 第7列：净重，不填
      0.5                          // 第8列：毛重，默认0.5
    ]);
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '商品物流属性导入');

  const filePath = path.join(outputDir, 'GoodsLogisticsTemplate.xls');
  XLSX.writeFile(wb, filePath, { bookType: 'xls' });
  return filePath;
}

/**
 * 生成 updateShopGoodsImportTemplate.xls
 * 京配打标生效 / 取消京配打标
 * @param {Array} items - [{ shopProductId, enable }] shopProductId=店铺商品编号, enable=true(生效)/false(取消)
 */
function generateUpdateShopGoods(items) {
  const header = [
    '店铺商品编号（CSG编码）必填',
    '商品状态(1启用，2停用)',
    '京配搜索（0否，1是）'
  ];
  const rows = [header];

  items.forEach(item => {
    const val = item.enable ? 1 : 0;
    rows.push([
      item.shopProductId,  // 第1列：店铺商品编号
      val,                 // 第2列：1或0
      val                  // 第3列：1或0
    ]);
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'POP商品导入');

  const filePath = path.join(outputDir, 'updateShopGoodsImportTemplate.xls');
  XLSX.writeFile(wb, filePath, { bookType: 'xls' });
  return filePath;
}

/**
 * 生成 采购入库单商品导入模板.xls
 * 启用采购入库
 */
function generatePurchaseImport(skus, { departmentId, supplierId, warehouseId, purchaseQty }) {
  const header = [
    '事业部编号', '供应商编号', '入库库房编号', '商家采购单号',
    '事业部商品编码', '商家商品编码', '商品数量',
    '商家包装规格编码', '包装单位编码', '是否需要提供装卸业务',
    '单据类型编号', '是否按板回传', '代贴条码', '商品价格'
  ];
  const rows = [header];

  // 生成单号：ADD + 当前时间 yyyyMMddHHmmss
  const now = new Date();
  const orderNo = 'ADD' +
    now.getFullYear() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');

  skus.forEach(sku => {
    rows.push([
      departmentId,            // 第1列：事业部编号
      supplierId,              // 第2列：供应商编号
      warehouseId,             // 第3列：仓房编号
      orderNo,                 // 第4列：ADD+时间
      '',                      // 第5列：不填
      sku,                     // 第6列：SKU
      parseInt(purchaseQty) || 1, // 第7列：采购数量
      '',                      // 第8列：不填
      '',                      // 第9列：不填
      '',                      // 第10列：不填
      '',                      // 第11列：不填
      '否',                    // 第12列：否
      '空',                    // 第13列：空
      ''                       // 第14列：不填
    ]);
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);

  // 第二个sheet：配置项
  const configRows = [
    ['配置项：', '', ''],
    ['MERGE_SKU', '是否合并相同SKU：', '否']
  ];
  const wsConfig = XLSX.utils.aoa_to_sheet(configRows);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '采购单导入模板');
  XLSX.utils.book_append_sheet(wb, wsConfig, '配置项');

  const filePath = path.join(outputDir, '采购入库单商品导入模板.xls');
  XLSX.writeFile(wb, filePath, { bookType: 'xls' });
  return filePath;
}

module.exports = {
  setOutputDir,
  generatePopGoodsImport,
  generateGoodsLogistics,
  generateUpdateShopGoods,
  generatePurchaseImport
};
