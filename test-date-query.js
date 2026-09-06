/**
 * 日期查询功能测试
 * 验证 injectRequestInterceptor 的 patchBody 逻辑 和 applyDateFilterToPage 的 DOM 选择逻辑
 */

const { JSDOM } = require('jsdom');

let pass = true;
let testCount = 0;

function assert(name, condition, detail = '') {
  testCount++;
  if (condition) {
    console.log(`✅ 测试${testCount}通过: ${name}`);
  } else {
    console.error(`❌ 测试${testCount}失败: ${name}${detail ? ' - ' + detail : ''}`);
    pass = false;
  }
}

// ========== 1. 测试 patchBody 逻辑 (来自 injectRequestInterceptor) ==========
console.log('\n=== 1. patchBody 逻辑测试 ===\n');

function patchBody(body, dateFrom, dateTo) {
  if (!body || typeof body !== 'string') return body;
  try {
    const json = JSON.parse(body);
    if (json && json.productListQueryReq) {
      if (dateFrom && dateTo) {
        const start = dateFrom + ' 00:00:00';
        const end = dateTo + ' 23:59:59';
        json.productListQueryReq.onlineTime = [start, end];
        json.productListQueryReq.startOnlineTime = start;
        json.productListQueryReq.endOnlineTime = end;
      }
      if (json.productListQueryReq.pageSize != null) {
        json.productListQueryReq.pageSize = 100;
      }
      return JSON.stringify(json);
    }
  } catch(e) {}
  return body;
}

// 测试1.1: 正常注入日期
const body1 = JSON.stringify({
  productListQueryReq: { pageNum: 1, pageSize: 10, productState: '11' },
  accessContext: { source: 'web' }
});
const result1 = JSON.parse(patchBody(body1, '2026-04-16', '2026-04-16'));
assert('patchBody 注入 onlineTime 数组',
  Array.isArray(result1.productListQueryReq.onlineTime) && result1.productListQueryReq.onlineTime.length === 2,
  JSON.stringify(result1.productListQueryReq.onlineTime));
assert('patchBody 注入 startOnlineTime',
  result1.productListQueryReq.startOnlineTime === '2026-04-16 00:00:00');
assert('patchBody 注入 endOnlineTime',
  result1.productListQueryReq.endOnlineTime === '2026-04-16 23:59:59');
assert('patchBody 扩大 pageSize 到 100',
  result1.productListQueryReq.pageSize === 100);

// 测试1.2: 无日期参数时不修改日期字段
const body2 = JSON.stringify({
  productListQueryReq: { pageNum: 1, pageSize: 10, productState: '11' }
});
const result2 = JSON.parse(patchBody(body2, '', ''));
assert('patchBody 无日期时不注入 onlineTime',
  result2.productListQueryReq.onlineTime === undefined);
assert('patchBody 无日期时仍扩大 pageSize',
  result2.productListQueryReq.pageSize === 100);

// 测试1.3: 非 productListQueryReq 请求不修改
const body3 = JSON.stringify({ otherQuery: { foo: 'bar' } });
const result3 = patchBody(body3, '2026-04-16', '2026-04-16');
assert('patchBody 非目标请求不修改',
  result3 === body3);

// 测试1.4: 非法 JSON 不崩溃
const body4 = 'not json';
const result4 = patchBody(body4, '2026-04-16', '2026-04-16');
assert('patchBody 非法JSON原样返回',
  result4 === body4);

// 测试1.5: 空/非字符串 body
assert('patchBody null body 返回 null',
  patchBody(null, '2026-04-16', '2026-04-16') === null);
assert('patchBody undefined body 返回 undefined',
  patchBody(undefined, '2026-04-16', '2026-04-16') === undefined);

// ========== 2. 测试 applyDateFilterToPage DOM 脚本逻辑 ==========
console.log('\n=== 2. applyDateFilterToPage DOM 选择逻辑测试 ===\n');

// 模拟页面中 applyDateFilterToPage 的核心选择逻辑
function findDateInputs(doc) {
  const allInputs = Array.from(doc.querySelectorAll('input'));
  let dateInputs = [];

  // 策略1: antd RangePicker / DatePicker
  const pickerInputs = Array.from(doc.querySelectorAll('.ant-picker-input input, .ant-calendar-range input, [class*="RangePicker"] input, [class*="picker"] input'));
  if (pickerInputs.length >= 2) {
    dateInputs = pickerInputs.filter(inp => inp.tagName === 'INPUT').slice(0, 2);
  }

  // 策略2: placeholder 明确包含开始/结束/日期/时间
  if (dateInputs.length < 2) {
    dateInputs = allInputs.filter(inp => {
      const ph = (inp.placeholder || '').toLowerCase();
      return ph.includes('开始') || ph.includes('结束') || ph.includes('日期') || ph.includes('时间');
    }).slice(0, 2);
  }

  // 策略3: 通过 label 或父级 wrapper 文本找上架/创建日期
  if (dateInputs.length < 2) {
    dateInputs = allInputs.filter(inp => {
      const label = inp.closest('label');
      const labelText = label ? label.textContent.toLowerCase() : '';
      const wrapper = inp.closest('[class*="form-item"]') || inp.closest('[class*="field"]') || inp.closest('.ant-form-item') || inp.parentElement;
      const wrapperText = wrapper ? wrapper.textContent.toLowerCase() : '';
      return labelText.includes('日期') || labelText.includes('时间') || labelText.includes('上架') || labelText.includes('创建') ||
             wrapperText.includes('日期') || wrapperText.includes('时间') || wrapperText.includes('上架') || wrapperText.includes('创建');
    }).slice(0, 2);
  }

  // 策略4: input type="date" 或 type="datetime-local"
  if (dateInputs.length < 2) {
    dateInputs = allInputs.filter(inp => inp.type === 'date' || inp.type === 'datetime-local').slice(0, 2);
  }

  return dateInputs;
}

// 测试2.1: 典型京东店铺后台筛选区域 DOM
const html1 = `
<div class="search-form">
  <div class="ant-form-item">
    <label>商品名称</label>
    <input placeholder="请输入商品名称" class="ant-input" />
  </div>
  <div class="ant-form-item">
    <label>SKU编码</label>
    <input placeholder="请输入SKU编码" class="ant-input" />
  </div>
  <div class="ant-form-item">
    <label>商品编码</label>
    <input placeholder="请输入商品编码" class="ant-input" />
  </div>
  <div class="ant-form-item">
    <label>30天销量</label>
    <input placeholder="请输入销量" class="ant-input" />
  </div>
  <div class="ant-form-item">
    <label>上架时间</label>
    <div class="ant-picker ant-picker-range">
      <div class="ant-picker-input"><input placeholder="开始日期" /></div>
      <div class="ant-picker-input"><input placeholder="结束日期" /></div>
    </div>
  </div>
</div>
`;
const dom1 = new JSDOM(html1);
const inputs1 = findDateInputs(dom1.window.document);
assert('antd RangePicker 精确匹配到2个日期输入框',
  inputs1.length === 2, `实际找到 ${inputs1.length} 个`);
assert('RangePicker 第一个 placeholder 正确',
  inputs1[0].placeholder === '开始日期');
assert('RangePicker 第二个 placeholder 正确',
  inputs1[1].placeholder === '结束日期');

// 测试2.2: 没有 antd picker，但有 placeholder 提示
const html2 = `
<div>
  <input placeholder="请输入商品名称" />
  <input placeholder="SKU编码" />
  <input placeholder="开始时间" />
  <input placeholder="结束时间" />
</div>
`;
const dom2 = new JSDOM(html2);
const inputs2 = findDateInputs(dom2.window.document);
assert('placeholder 匹配到2个日期输入框',
  inputs2.length === 2, `实际找到 ${inputs2.length} 个`);
assert('placeholder 匹配第一个正确',
  inputs2[0].placeholder === '开始时间');
assert('placeholder 匹配第二个正确',
  inputs2[1].placeholder === '结束时间');

// 测试2.3: 通过 wrapper label 文本匹配
const html3 = `
<div>
  <div class="field"><label>商品名称</label><input /></div>
  <div class="field"><span>上架日期</span><input /></div>
  <div class="field"><span>创建时间</span><input /></div>
</div>
`;
const dom3 = new JSDOM(html3);
const inputs3 = findDateInputs(dom3.window.document);
assert('wrapper 文本匹配到2个日期输入框',
  inputs3.length === 2, `实际找到 ${inputs3.length} 个`);

// 测试2.4: type="date" 输入框
const html4 = `
<div>
  <input type="text" placeholder="商品名称" />
  <input type="date" />
  <input type="date" />
</div>
`;
const dom4 = new JSDOM(html4);
const inputs4 = findDateInputs(dom4.window.document);
assert('type=date 匹配到2个日期输入框',
  inputs4.length === 2, `实际找到 ${inputs4.length} 个`);
assert('type=date 不会误匹配 text 输入',
  !Array.from(inputs4).some(inp => inp.type === 'text'));

// 测试2.5: 完全没有日期输入框时返回空数组（关键：不会乱填）
const html5 = `
<div>
  <input placeholder="商品名称" />
  <input placeholder="SKU编码" />
  <input placeholder="商品编码" />
  <input placeholder="30天销量" />
</div>
`;
const dom5 = new JSDOM(html5);
const inputs5 = findDateInputs(dom5.window.document);
assert('无日期输入框时返回空数组（不会乱填前几个input）',
  inputs5.length === 0, `实际找到 ${inputs5.length} 个，这会误填到商品名称/SKU编码`);

// ========== 3. 测试 Debugger 诊断日志解析逻辑 ==========
console.log('\n=== 3. Debugger 诊断日志解析测试 ===\n');

function checkDateInRequest(postData, userDateFrom, userDateTo) {
  try {
    const bodyJson = JSON.parse(postData);
    if (bodyJson.productListQueryReq) {
      const req = bodyJson.productListQueryReq;
      const hasDate = !!(req.onlineTime || req.startOnlineTime || req.endOnlineTime);
      return {
        hasDate,
        dateRange: req.onlineTime || [req.startOnlineTime, req.endOnlineTime],
        shouldWarn: !hasDate && !!(userDateFrom || userDateTo)
      };
    }
  } catch(e) {}
  return { hasDate: false, dateRange: null, shouldWarn: false };
}

const testBodyWithDate = JSON.stringify({
  productListQueryReq: {
    onlineTime: ['2026-04-16 00:00:00', '2026-04-16 23:59:59'],
    startOnlineTime: '2026-04-16 00:00:00',
    endOnlineTime: '2026-04-16 23:59:59',
    pageNum: 1,
    pageSize: 100
  }
});
const diag1 = checkDateInRequest(testBodyWithDate, '2026-04-16', '2026-04-16');
assert('诊断逻辑识别已注入日期',
  diag1.hasDate === true && diag1.shouldWarn === false);

const testBodyWithoutDate = JSON.stringify({
  productListQueryReq: { pageNum: 1, pageSize: 10 }
});
const diag2 = checkDateInRequest(testBodyWithoutDate, '2026-04-16', '2026-04-16');
assert('诊断逻辑识别未注入日期并触发警告',
  diag2.hasDate === false && diag2.shouldWarn === true);

const testBodyNoQuery = JSON.stringify({ other: 'data' });
const diag3 = checkDateInRequest(testBodyNoQuery, '2026-04-16', '2026-04-16');
assert('非目标请求不触发警告',
  diag3.hasDate === false && diag3.shouldWarn === false);

const diag4 = checkDateInRequest(testBodyWithoutDate, '', '');
assert('用户未指定日期时不触发警告',
  diag4.hasDate === false && diag4.shouldWarn === false);

// ========== 4. 测试日期格式转换 ==========
console.log('\n=== 4. 日期格式转换测试 ===\n');

function formatDateForApi(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

assert('日期格式转换 2026-04-16',
  formatDateForApi('2026-04-16') === '2026-04-16');
assert('日期格式转换 2026/04/16',
  formatDateForApi('2026/04/16') === '2026-04-16');
assert('日期格式转换空字符串返回 null',
  formatDateForApi('') === null);
assert('日期格式转换非法字符串返回 null',
  formatDateForApi('invalid') === null);

// ========== 5. 测试 preload 响应捕获逻辑 ==========
console.log('\n=== 5. preload 响应捕获逻辑测试 ===\n');

// 模拟 shop-preload.js 的捕获逻辑
function simulatePreloadCapture() {
  const captured = {};

  function captureResponse(url, responseText) {
    if (!url || typeof url !== 'string') return;
    if (!url.includes('sff.jd.com')) return;
    if (url.includes('queryValidProductList')) {
      captured['queryValidProductList'] = responseText;
    }
    if (url.includes('querySkuList')) {
      captured[url] = responseText;
      captured['querySkuList_' + Date.now()] = responseText;
    }
  }

  return { captured, captureResponse };
}

const { captured, captureResponse } = simulatePreloadCapture();

// 模拟 queryValidProductList 响应
const mockProductResponse = JSON.stringify({
  code: 200,
  data: {
    data: [
      { productId: 1001, productName: '测试商品A' },
      { productId: 1002, productName: '测试商品B' }
    ]
  }
});

captureResponse('https://sff.jd.com/api?api=queryValidProductList', mockProductResponse);
assert('preload 捕获 queryValidProductList',
  captured['queryValidProductList'] === mockProductResponse);

// 模拟 querySkuList 响应
const mockSkuResponse = JSON.stringify({
  code: 200,
  data: { data: [{ skuId: '2001', skuName: 'SKU-1' }] }
});
captureResponse('https://sff.jd.com/api?api=querySkuList', mockSkuResponse);
assert('preload 捕获 querySkuList',
  Object.values(captured).includes(mockSkuResponse));

// 模拟非目标请求不应被捕获
captureResponse('https://other.jd.com/api', 'some data');
assert('preload 不捕获非 sff.jd.com 请求',
  !Object.values(captured).includes('some data'));

// 模拟轮询读取逻辑（模拟 waitForCapturedResponse）
function waitForCapturedResponse(captured, key, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (captured[key]) {
        clearInterval(interval);
        resolve(captured[key]);
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        resolve(null);
      }
    }, 100);
  });
}

(async () => {
  const result = await waitForCapturedResponse(captured, 'queryValidProductList', 1000);
  assert('轮询读取捕获的 queryValidProductList 成功',
    result === mockProductResponse);

  const notFound = await waitForCapturedResponse(captured, 'nonExistent', 200);
  assert('轮询读取不存在的 key 返回 null',
    notFound === null);

  // ========== 测试结果汇总 ==========
  console.log('\n=== 测试结果汇总 ===\n');
  if (pass) {
    console.log(`✅ 全部 ${testCount} 项测试通过`);
    process.exit(0);
  } else {
    console.log(`❌ ${testCount} 项测试中有失败项`);
    process.exit(1);
  }
})();
console.log('\n=== 测试结果汇总 ===\n');
if (pass) {
  console.log(`✅ 全部 ${testCount} 项测试通过`);
  process.exit(0);
} else {
  console.log(`❌ ${testCount} 项测试中有失败项`);
  process.exit(1);
}
