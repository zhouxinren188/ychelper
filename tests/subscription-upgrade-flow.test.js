const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'subscription.html'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

async function createPage(orderResult) {
  let subscriptionListener = null;
  const paymentPayloads = [];
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
          queryPaymentOrder: async () => ({ status: 'pending' }),
          generateQRCode: async () => 'data:image/png;base64,AA=='
        }
      });
      window.alert = () => {};
    }
  });
  await new Promise(resolve => dom.window.addEventListener('load', resolve, { once: true }));
  return { dom, sendSubscriptionInfo: subscriptionListener, paymentPayloads };
}

(async () => {
  const page = await createPage({
    order_no: 'masked-order',
    code_url: 'weixin://masked',
    amount: 5001,
    original_amount: 9901,
    discount_amount: 4900,
    plan: 'monthly',
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
  document.querySelector('[data-plan="monthly"]').click();
  assert.strictEqual(document.querySelector('[data-plan="monthly"]').classList.contains('selected'), true);

  document.querySelector('[data-tier="standard"]').click();
  assert.match(document.querySelector('#upgradeNote').textContent, /月度标准/);
  assert.match(document.querySelector('#upgradeNote').textContent, /只收取从现在到/);
  assert.match(document.querySelector('#upgradeNote').textContent, /原到期时间不变/);
  assert.match(document.querySelector('#payBtn').textContent, /计算并升级至标准版/);

  document.querySelector('#payBtn').click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.strictEqual(page.paymentPayloads.length, 1);
  assert.strictEqual(page.paymentPayloads[0].plan, 'monthly');
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
  legacyPage.dom.window.close();

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

  console.log('订阅升级补差价界面流程测试通过');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
