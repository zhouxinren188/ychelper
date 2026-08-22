const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'subscription.html'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

async function createPage(orderResult, quoteResult = null) {
  let subscriptionListener = null;
  const paymentPayloads = [];
  const quotePayloads = [];
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
          close() {},
          createPaymentOrder: async (payload) => {
            paymentPayloads.push(payload);
            return orderResult;
          },
          quoteSubscriptionUpgrade: async (payload) => {
            quotePayloads.push(payload);
            return quoteResult || {
              amount: orderResult.amount,
              original_amount: orderResult.original_amount,
              discount_amount: orderResult.discount_amount,
              plan: 'yearly',
              tier: payload.tier,
              order_type: 'upgrade'
            };
          },
          queryPaymentOrder: async () => ({ status: 'pending' }),
          generateQRCode: async () => 'data:image/png;base64,AA=='
        }
      });
      window.alert = () => {};
    }
  });
  await new Promise(resolve => dom.window.addEventListener('load', resolve, { once: true }));
  return { dom, sendSubscriptionInfo: subscriptionListener, paymentPayloads, quotePayloads };
}

(async () => {
  const page = await createPage({
    order_no: 'masked-order',
    code_url: 'weixin://masked',
    amount: 5001,
    original_amount: 9901,
    discount_amount: 4900,
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
    department_id: 'masked-dept',
    is_first_payment: false
  });

  const document = page.dom.window.document;
  assert.strictEqual(document.querySelector('[data-plan="yearly"]').classList.contains('selected'), true);
  assert.strictEqual(document.querySelector('#periodSelector').style.display, 'flex');

  document.querySelector('[data-tier="standard"]').click();
  assert.strictEqual(document.querySelector('#periodSelector').style.display, 'none');
  document.querySelector('[data-plan="monthly"]').click();
  assert.strictEqual(document.querySelector('[data-plan="yearly"]').classList.contains('selected'), true,
    '升级状态即使触发隐藏卡片事件也不能改变当前订阅周期');
  assert.match(document.querySelector('#upgradeNote').textContent, /当前订阅的年度计费标准/);
  assert.match(document.querySelector('#upgradeNote').textContent, /升级无需选择周期/);
  assert.match(document.querySelector('#upgradeNote').textContent, /只收取从现在到/);
  assert.match(document.querySelector('#upgradeNote').textContent, /原到期时间不变/);
  assert.match(document.querySelector('#payBtn').textContent, /计算升级至标准版的差价/);

  document.querySelector('#payBtn').click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.strictEqual(page.quotePayloads.length, 1);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(page.quotePayloads[0], 'plan'), false);
  assert.strictEqual(page.paymentPayloads.length, 0, '首次点击只计算差价，不能创建微信支付单');
  assert.match(document.querySelector('#payBtn').textContent, /50\.01/);
  assert.strictEqual(document.querySelector('#originalPrice').textContent, '99.01元');
  assert.strictEqual(document.querySelector('#discountPrice').textContent, '-49元');
  assert.strictEqual(document.querySelector('#finalPrice').textContent, '50.01元');

  document.querySelector('#payBtn').click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.strictEqual(page.paymentPayloads.length, 1);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(page.paymentPayloads[0], 'plan'), false);
  assert.strictEqual(page.paymentPayloads[0].tier, 'standard');
  assert.strictEqual(document.querySelector('#originalPrice').textContent, '99.01元');
  assert.strictEqual(document.querySelector('#discountPrice').textContent, '-49元');
  assert.strictEqual(document.querySelector('#finalPrice').textContent, '50.01元');
  assert.strictEqual(document.querySelector('#finalPriceLabel').textContent, '本次升级补差价');
  assert.match(document.querySelector('#qrAmount').textContent, /50\.01元/);
  page.dom.window.close();

  const legacyPage = await createPage({ error: 'not_used' });
  legacyPage.sendSubscriptionInfo({
    status: 'active',
    tier: 'basic',
    subscription_plan: '',
    subscription_end: '2026-10-01T00:00:00.000Z'
  });
  const legacyDocument = legacyPage.dom.window.document;
  assert.strictEqual(legacyDocument.querySelector('[data-plan="monthly"]').classList.contains('selected'), true);
  legacyDocument.querySelector('[data-plan="quarterly"]').click();
  assert.strictEqual(legacyDocument.querySelector('[data-plan="quarterly"]').classList.contains('selected'), true);
  legacyDocument.querySelector('[data-tier="standard"]').click();
  assert.strictEqual(legacyDocument.querySelector('#periodSelector').style.display, 'none');
  assert.strictEqual(legacyDocument.querySelector('[data-plan="yearly"]').classList.contains('selected'), true,
    '历史订阅缺少周期元数据时必须与服务器一致回退年度计价');
  legacyPage.dom.window.close();

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
  quoteErrorDocument.querySelector('#payBtn').click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.strictEqual(quoteErrorPage.paymentPayloads.length, 0);
  assert.strictEqual(quoteErrorDocument.querySelector('#payBtn').disabled, false,
    '报价失败后必须恢复按钮，不能一直停留在计算中');
  assert.match(quoteErrorDocument.querySelector('#payBtn').textContent, /计算升级至标准版的差价/);
  quoteErrorPage.dom.window.close();

  const trialPage = await createPage({ error: 'not_used' });
  trialPage.sendSubscriptionInfo({ status: 'trial', tier: 'basic', is_first_payment: true });
  const trialDocument = trialPage.dom.window.document;
  trialDocument.querySelector('[data-plan="quarterly"]').click();
  assert.strictEqual(trialDocument.querySelector('[data-plan="quarterly"]').classList.contains('selected'), true);
  assert.strictEqual(trialDocument.querySelector('#upgradeNote').classList.contains('visible'), false);
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
