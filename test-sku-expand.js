/**
 * SKU 展开数据转换逻辑测试
 * 模拟 queryValidProductList + querySkuList 响应，验证数据映射正确性
 */

// ========== 模拟 queryValidProductList 响应数据 ==========
const mockProducts = [
  {
    productId: 10034520931618,
    productName: '测试商品A-多SKU',
    onlineTime: 1712345678000,
    logo: 'jfs/t1/123/456/789/12345.jpg',
    priceDetailVO: { jdPrice: '99.00' },
    productSkuInfoVO: { skuId: 10217181936800 }
  },
  {
    productId: 10034521075311,
    productName: '测试商品B-单SKU',
    onlineTime: 1713456789000,
    logo: '',
    priceDetailVO: { jdPrice: '49.50' },
    productSkuInfoVO: { skuId: 10217181936801 }
  },
  {
    productId: 10034520987484,
    productName: '测试商品C-多SKU无图',
    onlineTime: null,
    priceDetailVO: null,
    productSkuInfoVO: null
  }
];

// ========== 模拟 collectSkuData 返回的 SKU Map ==========
const mockSkuMap = new Map();

// 商品A有3个SKU
mockSkuMap.set('10034520931618', [
  {
    skuId: '10217181936804',
    skuName: '测试商品A-红色-大号',
    productId: '10034520931618',
    priceDetailVO: { jdPrice: '109.00' },
    onlineTime: '2024-04-15 10:30:00',
    saleAttrs: [
      { attrValueAlias: '红色', attrValueName: '红色' },
      { attrValueAlias: '大号', attrValueName: 'L' }
    ]
  },
  {
    skuId: '10217181936805',
    skuName: '测试商品A-蓝色-中号',
    productId: '10034520931618',
    priceDetailVO: { jdPrice: '99.00' },
    onlineTime: '2024-04-15 10:30:00',
    saleAttrs: [
      { attrValueAlias: '蓝色', attrValueName: '蓝色' },
      { attrValueAlias: '中号', attrValueName: 'M' }
    ]
  },
  {
    skuId: '10217181936806',
    skuName: '测试商品A-无规格',
    productId: '10034520931618',
    priceDetailVO: null,
    onlineTime: 1713156600000,
    saleAttrs: []
  }
]);

// 商品C有2个SKU
mockSkuMap.set('10034520987484', [
  {
    skuId: '10217181936807',
    skuName: '测试商品C-规格1',
    productId: '10034520987484',
    priceDetailVO: { jdPrice: '29.90' },
    onlineTime: '2024-05-01 08:00:00',
    saleAttrs: [{ attrValueName: '规格1' }]
  },
  {
    skuId: '10217181936808',
    skuName: '测试商品C-规格2',
    productId: '10034520987484',
    priceDetailVO: { jdPrice: '39.90' },
    onlineTime: null,
    saleAttrs: [{ attrValueName: '规格2' }]
  }
]);

// ========== 复制 main.js 中的数据提取逻辑 ==========
function extractGoods(items, skuMap) {
  const allGoods = [];
  for (const product of items) {
    const productName = product.productName || '';
    let listDate = '';
    if (product.onlineTime) {
      const ts = typeof product.onlineTime === 'number' ? product.onlineTime : parseInt(product.onlineTime);
      if (ts > 0) {
        const d = new Date(ts);
        listDate = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      }
    }

    let price = null;
    if (product.priceDetailVO && product.priceDetailVO.jdPrice != null) {
      price = parseFloat(product.priceDetailVO.jdPrice);
    }

    let imageUrl = product.logo || '';
    if (imageUrl && !imageUrl.startsWith('http')) {
      imageUrl = 'https://img14.360buyimg.com/n1/' + imageUrl.replace(/^\/+/,'');
    }

    const productCode = String(product.productId || '');
    const expandedSkus = skuMap.get(productCode);

    if (expandedSkus && expandedSkus.length > 0) {
      for (const skuItem of expandedSkus) {
        const skuId = String(skuItem.skuId || '');
        let skuPrice = price;
        if (skuItem.priceDetailVO && skuItem.priceDetailVO.jdPrice != null) {
          skuPrice = parseFloat(skuItem.priceDetailVO.jdPrice);
        }
        let skuListDate = listDate;
        if (skuItem.onlineTime) {
          const ot = skuItem.onlineTime;
          if (typeof ot === 'string' && ot.includes('-')) {
            skuListDate = ot.substring(0, 10);
          } else {
            const ts = typeof ot === 'number' ? ot : parseInt(ot);
            if (ts > 0) {
              const d = new Date(ts);
              skuListDate = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
            }
          }
        }
        let skuName = productName;
        if (skuItem.saleAttrs && Array.isArray(skuItem.saleAttrs)) {
          const attrs = skuItem.saleAttrs.map(a => a.attrValueAlias || a.attrValueName || '').filter(Boolean);
          if (attrs.length > 0) {
            skuName = productName + ' [' + attrs.join(', ') + ']';
          }
        }
        allGoods.push({
          sku: skuId,
          productCode: productCode,
          name: skuName,
          price: skuPrice,
          listDate: skuListDate,
          image: imageUrl
        });
      }
    } else {
      let skuId = '';
      if (product.productSkuInfoVO && product.productSkuInfoVO.skuId) {
        skuId = String(product.productSkuInfoVO.skuId);
      }
      allGoods.push({
        sku: skuId,
        productCode: productCode,
        name: productName,
        price: price,
        listDate: listDate,
        image: imageUrl
      });
    }
  }
  return allGoods;
}

// ========== 运行测试 ==========
console.log('=== SKU 展开数据转换测试 ===\n');

const result = extractGoods(mockProducts, mockSkuMap);

console.log(`输入: ${mockProducts.length} 个商品`);
console.log(`SKU展开数据: 商品A=${mockSkuMap.get('10034520931618').length}个SKU, 商品C=${mockSkuMap.get('10034520987484').length}个SKU, 商品B=无展开`);
console.log(`输出: ${result.length} 条记录\n`);

let pass = true;

// 测试1: 总记录数
const expectedCount = 3 + 1 + 2; // A有3个 + B无展开1个 + C有2个
if (result.length !== expectedCount) {
  console.error(`❌ 测试1失败: 期望 ${expectedCount} 条, 实际 ${result.length} 条`);
  pass = false;
} else {
  console.log(`✅ 测试1通过: 总记录数 = ${result.length}`);
}

// 测试2: 商品A的SKU展开
const aRecords = result.filter(r => r.productCode === '10034520931618');
if (aRecords.length !== 3) {
  console.error(`❌ 测试2失败: 商品A期望3条SKU, 实际 ${aRecords.length} 条`);
  pass = false;
} else {
  console.log(`✅ 测试2通过: 商品A展开为 ${aRecords.length} 条SKU`);
}

// 测试3: 商品A的SKU ID正确
const aSkuIds = aRecords.map(r => r.sku);
if (!aSkuIds.includes('10217181936804') || !aSkuIds.includes('10217181936805')) {
  console.error(`❌ 测试3失败: SKU ID不匹配`, aSkuIds);
  pass = false;
} else {
  console.log(`✅ 测试3通过: SKU ID正确`);
}

// 测试4: 商品A的SKU名称包含规格属性
const aRecord0 = aRecords.find(r => r.sku === '10217181936804');
if (!aRecord0 || !aRecord0.name.includes('[红色, 大号]')) {
  console.error(`❌ 测试4失败: SKU名称应包含规格属性`, aRecord0?.name);
  pass = false;
} else {
  console.log(`✅ 测试4通过: SKU名称含规格 = "${aRecord0.name}"`);
}

// 测试5: 商品A的SKU价格从priceDetailVO取
const aRecord1 = aRecords.find(r => r.sku === '10217181936804');
if (aRecord1.price !== 109.00) {
  console.error(`❌ 测试5失败: 期望价格109.00, 实际`, aRecord1.price);
  pass = false;
} else {
  console.log(`✅ 测试5通过: SKU价格 = ${aRecord1.price}`);
}

// 测试6: 商品A第三个SKU无priceDetailVO时回退到商品价格
const aRecord2 = aRecords.find(r => r.sku === '10217181936806');
if (aRecord2.price !== 99.00) {
  console.error(`❌ 测试6失败: 期望回退价格99.00, 实际`, aRecord2.price);
  pass = false;
} else {
  console.log(`✅ 测试6通过: 无SKU价格时回退到商品价格 = ${aRecord2.price}`);
}

// 测试7: 商品B未展开（单SKU回退）
const bRecords = result.filter(r => r.productCode === '10034521075311');
if (bRecords.length !== 1 || bRecords[0].sku !== '10217181936801') {
  console.error(`❌ 测试7失败: 商品B应回退到productSkuInfoVO.skuId`, bRecords);
  pass = false;
} else {
  console.log(`✅ 测试7通过: 商品B未展开时回退skuId = ${bRecords[0].sku}`);
}

// 测试8: 商品C的日期字符串解析
const cRecords = result.filter(r => r.productCode === '10034520987484');
const cRecord0 = cRecords.find(r => r.sku === '10217181936807');
if (cRecord0.listDate !== '2024-05-01') {
  console.error(`❌ 测试8失败: 期望日期2024-05-01, 实际`, cRecord0.listDate);
  pass = false;
} else {
  console.log(`✅ 测试8通过: 字符串日期解析 = "${cRecord0.listDate}"`);
}

// 测试9: 商品C无onlineTime时listDate为空
const cRecord1 = cRecords.find(r => r.sku === '10217181936808');
if (cRecord1.listDate !== '') {
  console.error(`❌ 测试9失败: 无日期时期望空字符串, 实际`, cRecord1.listDate);
  pass = false;
} else {
  console.log(`✅ 测试9通过: 无日期时listDate为空`);
}

// 测试10: 图片URL补全
if (!aRecord0.image.startsWith('https://img14.360buyimg.com/n1/')) {
  console.error(`❌ 测试10失败: 图片URL未补全`, aRecord0.image);
  pass = false;
} else {
  console.log(`✅ 测试10通过: 图片URL补全 = "${aRecord0.image.substring(0, 50)}..."`);
}

// 测试11: 商品C无logo时image为空
const cRecordImage = cRecords[0].image;
if (cRecordImage !== '') {
  console.error(`❌ 测试11失败: 无logo时期望空, 实际`, cRecordImage);
  pass = false;
} else {
  console.log(`✅ 测试11通过: 无logo时image为空`);
}

console.log('\n=== 测试结果 ===');
if (pass) {
  console.log('✅ 全部 11 项测试通过');
  process.exit(0);
} else {
  console.log('❌ 有测试未通过');
  process.exit(1);
}
