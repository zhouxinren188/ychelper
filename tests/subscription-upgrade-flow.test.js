const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'subscription.html'), 'utf8');
const titlebarStyleSource = fs.readFileSync(path.join(root, 'src', 'css', 'window-titlebar.css'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

async function waitFor(predicate, message, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function createPage(orderResult, quoteResult = null) {
  let subscriptionListener = null;
  let minimizeCount = 0;
  let closeCount = 0;
  const paymentPayloads = [];
  const quotePayloads = [];
  const alerts = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'file:///subscription.html',
    beforeParse(window) {
      Object.defineProperty(window, 'electronAPI', {
        configurable: false,
        value: {
          onSubscriptionInfo(callback) { subscriptionListener = callback; },
          retrySessionEntry: async () => ({ success: false }),
          paymentSuccessEnter: async () => ({ success: false }),
          minimize() { minimizeCount += 1; },
          close() { closeCount += 1; },
          createPaymentOrder: async (payload) => {
            paymentPayloads.push(payload);
            return orderResult;
          },
          quoteSubscriptionUpgrade: async (payload) => {
            quotePayloads.push(payload);
            if (typeof quoteResult === 'function') return quoteResult(payload, quotePayloads.length);
            return quoteResult || {
              amount: orderResult.amount,
              original_amount: orderResult.original_amount,
              discount_amount: orderResult.discount_amount,
              billable_days: 14,
              plan: orderResult.plan || 'yearly',
              tier: payload.tier,
              order_type: 'upgrade'
            };
          },
          queryPaymentOrder: async () => ({ status: 'pending' }),
          generateQRCode: async () => 'data:image/png;base64,AA=='
        }
      });
      window.alert = message => alerts.push(String(message));
    }
  });
  await new Promise(resolve => dom.window.addEventListener('load', resolve, { once: true }));
  return {
    dom,
    sendSubscriptionInfo: subscriptionListener,
    paymentPayloads,
    quotePayloads,
    alerts,
    getWindowActionCounts: () => ({ minimizeCount, closeCount })
  };
}

(async () => {
  const page = await createPage({
    order_no: 'masked-order',
    code_url: 'weixin://masked',
    amount: 5001,
    original_amount: 9901,
    discount_amount: 4900,
    billable_days: 14,
    plan: 'yearly',
    tier: 'standard',
    order_type: 'upgrade'
  });
  page.sendSubscriptionInfo({
    status: 'active',
    tier: 'basic',
    subscription_plan: 'yearly',
    subscription_end: '2026-10-01T00:00:00.000Z',
    jd_username: 'masked-user',
    department_name: '测试事业部',
    department_id: 'masked-dept',
    is_first_payment: false
  });

  const document = page.dom.window.document;
  assert.strictEqual(document.querySelector('.sub-header h1'), null,
    '订阅内容区不应重复显示“云仓助手”');
  assert.strictEqual(document.querySelector('#subUser'), null,
    '订阅内容区不应显示账号');
  assert.strictEqual(document.querySelector('#subDept').textContent, '事业部: 测试事业部');
  assert.ok(document.querySelector('#subStatus'), '订阅状态必须保留');
  const subscriptionWindowBlock = mainSource.match(/subscriptionWindow = new BrowserWindow\(\{([\s\S]*?)\n  \}\);/);
  assert.ok(subscriptionWindowBlock, '应能定位订阅窗口配置');
  assert.match(subscriptionWindowBlock[1], /frame:\s*false/,
    '订阅窗口必须关闭原生标题栏');
  assert.ok(document.querySelector('#subscriptionTitlebar'), '订阅页应提供自绘标题栏');
  assert.ok(document.querySelector('#subscriptionTitlebar.modal-header'),
    '订阅窗口必须直接复用主界面弹窗标题栏结构');
  assert.strictEqual(
    document.querySelector('#subscriptionTitlebar > span').textContent,
    '云仓助手 - 订阅',
    '订阅窗口标题必须保留在弹窗标题栏左侧'
  );
  assert.ok(document.querySelector('#subscriptionClose.modal-close'),
    '订阅窗口必须复用主界面弹窗关闭按钮');
  assert.ok(!document.querySelector('#subscriptionMinimize'),
    '订阅弹窗不应额外保留主窗口式最小化按钮');
  assert.ok(document.querySelector('#subscriptionMain.subscription-main > .sub-container'),
    '订阅内容必须放在标题栏下方的独立滚动区域');
  assert.match(html, /body\s*\{[\s\S]*?height:\s*100vh[\s\S]*?flex-direction:\s*column[\s\S]*?overflow:\s*hidden/,
    '订阅窗口外层必须像主界面一样固定标题栏并禁止整窗滚动');
  assert.match(html, /\.subscription-main\s*\{[\s\S]*?overflow-y:\s*auto/,
    '只有标题栏下方的订阅内容区域允许滚动');
  document.querySelector('#subscriptionClose').click();
  assert.deepStrictEqual(page.getWindowActionCounts(), { minimizeCount: 0, closeCount: 1 });
  assert.match(titlebarStyleSource, /\.titlebar\s*\{[\s\S]*?height:\s*28px/,
    '主窗口和订阅窗口应共用收紧后的28px标题栏');
  assert.match(titlebarStyleSource, /\.titlebar\s*\{[\s\S]*?-webkit-app-region:\s*drag/,
    '共享标题栏必须支持拖动窗口');
  assert.match(titlebarStyleSource, /\.titlebar-right\s*\{[\s\S]*?-webkit-app-region:\s*no-drag/,
    '共享窗口控制区域不能吞掉点击事件');
  assert.match(titlebarStyleSource, /\.win-btn\s*\{[\s\S]*?height:\s*28px/,
    '共享窗口控制按钮高度必须与标题栏一致');
  assert.strictEqual(document.querySelector('[data-plan="yearly"]').classList.contains('selected'), true);
  assert.strictEqual(document.querySelector('#periodSelector').style.display, 'flex');

  document.querySelector('[data-tier="standard"]').click();
  assert.strictEqual(document.querySelector('#periodSelector').style.display, 'none');
  await waitFor(() => page.quotePayloads.length === 1 && /50\.01/.test(document.querySelector('#payBtn').textContent),
    '选择升级版本后应自动取得并展示升级报价');
  document.querySelector('[data-plan="monthly"]').click();
  assert.strictEqual(document.querySelector('[data-plan="yearly"]').classList.contains('selected'), true,
    '升级状态下即使触发隐藏卡片事件也不能改变当前订阅周期');
  assert.match(document.querySelector('#upgradeNote').textContent, /按年度标准和剩余14天补差/);
  assert.match(document.querySelector('#upgradeNote').textContent, /到期时间不变/);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(page.quotePayloads[0], 'plan'), false,
    '升级周期必须由服务器根据真实订阅决定');
  assert.strictEqual(page.paymentPayloads.length, 0, '自动报价不能创建微信支付单');
  assert.strictEqual(document.querySelector('#originalPrice').textContent, '99.01元');
  assert.strictEqual(document.querySelector('#discountPrice').textContent, '-49元');
  assert.strictEqual(document.querySelector('#finalPrice').textContent, '50.01元');

  document.querySelector('#payBtn').click();
  await waitFor(() => page.paymentPayloads.length === 1, '报价完成后一次点击应直接创建支付单');
  await waitFor(() => /50\.01元/.test(document.querySelector('#qrAmount').textContent),
    '创建支付单后应显示二维码金额');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(page.paymentPayloads[0], 'plan'), false);
  assert.strictEqual(page.paymentPayloads[0].tier, 'standard');
  assert.strictEqual(document.querySelector('#finalPriceLabel').textContent, '本次升级补差价');
  assert.match(document.querySelector('#qrAmount').textContent, /50\.01元/);
  page.dom.window.close();

  // 旧客户端缓存可能没有 subscription_plan。服务器报价才是权威来源，不能再回退为年度。
  const missingPlanPage = await createPage({ error: 'not_used' }, {
    amount: 4464,
    original_amount: 9240,
    discount_amount: 4776,
    billable_days: 14,
    plan: 'monthly',
    tier: 'standard',
    order_type: 'upgrade'
  });
  missingPlanPage.sendSubscriptionInfo({
    status: 'active',
    tier: 'basic',
    subscription_plan: '',
    subscription_end: '2026-09-05T14:13:59.000Z',
    jd_username: 'masked-user',
    department_id: 'masked-dept'
  });
  const missingPlanDocument = missingPlanPage.dom.window.document;
  missingPlanDocument.querySelector('[data-plan="quarterly"]').click();
  assert.strictEqual(missingPlanDocument.querySelector('[data-plan="quarterly"]').classList.contains('selected'), true);
  missingPlanDocument.querySelector('[data-tier="standard"]').click();
  await waitFor(() => missingPlanPage.quotePayloads.length === 1 &&
      /44\.64/.test(missingPlanDocument.querySelector('#payBtn').textContent),
    '缺少本地周期时也应自动接受服务器的月度报价');
  assert.strictEqual(missingPlanDocument.querySelector('#periodSelector').style.display, 'none');
  assert.strictEqual(missingPlanDocument.querySelector('[data-plan="monthly"]').classList.contains('selected'), true,
    '服务器返回的真实月度订阅必须覆盖陈旧或缺失的本地周期');
  assert.strictEqual(missingPlanDocument.querySelector('[data-plan="yearly"]').classList.contains('selected'), false,
    '本地周期缺失时禁止擅自回退年度');
  assert.match(missingPlanDocument.querySelector('#upgradeNote').textContent, /按月度标准和剩余14天补差/);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(missingPlanPage.quotePayloads[0], 'plan'), false);
  missingPlanPage.dom.window.close();

  const quoteErrorPage = await createPage({}, { error: '报价暂不可用' });
  quoteErrorPage.sendSubscriptionInfo({
    status: 'active',
    tier: 'basic',
    subscription_plan: 'monthly',
    subscription_end: '2026-10-01T00:00:00.000Z',
    jd_username: 'masked-user',
    department_id: 'masked-dept'
  });
  const quoteErrorDocument = quoteErrorPage.dom.window.document;
  quoteErrorDocument.querySelector('[data-tier="standard"]').click();
  await waitFor(() => quoteErrorPage.quotePayloads.length === 1 &&
      /重新计算升级差价/.test(quoteErrorDocument.querySelector('#payBtn').textContent),
    '自动报价失败后应提供可重试按钮');
  assert.strictEqual(quoteErrorPage.alerts.length, 0, '自动报价失败不应立即弹窗打断用户');
  quoteErrorDocument.querySelector('#payBtn').click();
  await waitFor(() => quoteErrorPage.quotePayloads.length === 2 &&
      quoteErrorDocument.querySelector('#payBtn').disabled === false,
    '点击重试应再次请求报价并在失败后恢复按钮');
  assert.strictEqual(quoteErrorPage.paymentPayloads.length, 0);
  assert.strictEqual(quoteErrorDocument.querySelector('#payBtn').disabled, false,
    '报价失败后必须恢复按钮，不能一直停留在计算中');
  assert.match(quoteErrorDocument.querySelector('#payBtn').textContent, /重新计算升级差价/);
  assert.strictEqual(quoteErrorPage.alerts.length, 1, '手动重试失败时应显示一次明确错误');
  quoteErrorPage.dom.window.close();

  const trialPage = await createPage({ error: 'not_used' });
  trialPage.sendSubscriptionInfo({ status: 'trial', tier: 'basic', is_first_payment: true });
  const trialDocument = trialPage.dom.window.document;
  trialDocument.querySelector('[data-plan="quarterly"]').click();
  assert.strictEqual(trialDocument.querySelector('[data-plan="quarterly"]').classList.contains('selected'), true);
  assert.strictEqual(trialDocument.querySelector('#upgradeNote').classList.contains('visible'), false);
  assert.strictEqual(trialPage.quotePayloads.length, 0, '试用订购不能调用升级报价');
  trialPage.dom.window.close();

  assert.match(mainSource, /subscription_plan: subResult\.subscription_plan \|\| ''/);
  assert.match(mainSource, /subscription_plan: result\.subscription_plan/);
  assert.match(mainSource, /subscription_plan: subInfo\.subscription_plan \|\| ''/);
  assert.match(mainSource, /ipcMain\.handle\('quote-subscription-upgrade'/);
  assert.match(mainSource, /\/api\/payment\/quote-upgrade/);
  assert.match(mainSource, /\/api\/payment\/quote-upgrade'[\s\S]*}, 10000\);/);
  assert.match(preloadSource, /quoteSubscriptionUpgrade/);

  console.log('订阅升级补差价界面流程测试通过');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
