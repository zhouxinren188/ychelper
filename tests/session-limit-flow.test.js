const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'subscription.html'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

async function createPage(retryResult) {
  let subscriptionListener = null;
  let closeCount = 0;
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'file:///subscription.html',
    beforeParse(window) {
      Object.defineProperty(window, 'electronAPI', {
        configurable: false,
        value: {
          onSubscriptionInfo(callback) { subscriptionListener = callback; },
          retrySessionEntry: async () => retryResult,
          paymentSuccessEnter: async () => retryResult,
          close() { closeCount += 1; },
          createPaymentOrder: async () => ({ error: 'not_used' }),
          quoteSubscriptionUpgrade: async (payload) => ({
            amount: 5000,
            original_amount: 9900,
            discount_amount: 4900,
            billable_days: 15,
            plan: 'monthly',
            tier: payload.tier,
            order_type: 'upgrade'
          }),
          queryPaymentOrder: async () => ({ status: 'pending' }),
          generateQRCode: async () => ''
        }
      });
      window.alert = () => {};
    }
  });
  await new Promise(resolve => dom.window.addEventListener('load', resolve, { once: true }));
  assert.strictEqual(typeof subscriptionListener, 'function');
  return {
    dom,
    sendSubscriptionInfo: subscriptionListener,
    getCloseCount: () => closeCount
  };
}

(async () => {
  const page = await createPage({ success: true });
  page.sendSubscriptionInfo({
    status: 'active',
    tier: 'basic',
    jd_username: 'masked-user',
    department_name: '测试事业部',
    entry_reason: 'concurrent_session_limit',
    session_reason: 'concurrent_session_limit',
    online_count: 1,
    max_sessions: 1,
    recommended_tier: 'standard'
  });

  const document = page.dom.window.document;
  assert.strictEqual(document.querySelector('#capacityAlert').classList.contains('visible'), true);
  assert.match(document.querySelector('#capacityAlert').textContent, /1\/1/);
  assert.strictEqual(document.querySelector('[data-tier="basic"]').classList.contains('disabled'), true);
  assert.strictEqual(document.querySelector('[data-tier="standard"]').classList.contains('selected'), true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(document.querySelector('#payBtn').textContent, /升级至标准版/);
  assert.strictEqual(document.querySelector('#upgradeNote').classList.contains('visible'), false,
    '在线名额已满时升级说明应合并到名额提示中，不能显示两个重复说明框');
  assert.match(document.querySelector('#capacityAlert').textContent, /在线设备已满（1\/1）/);
  assert.match(document.querySelector('#capacityAlert').textContent, /升级至标准版可增加名额/);
  assert.match(document.querySelector('#capacityAlert').textContent, /按月度标准和剩余15天补差/);
  assert.match(document.querySelector('#capacityAlert').textContent, /到期时间不变/);
  assert.strictEqual(document.querySelector('#retryEntryBtn').classList.contains('visible'), true);

  document.querySelector('#retryEntryBtn').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.strictEqual(page.getCloseCount(), 1, '重新检测成功后应关闭升级窗口并进入主界面');
  page.dom.window.close();

  const premiumPage = await createPage({
    success: false,
    reason: 'concurrent_session_limit'
  });
  premiumPage.sendSubscriptionInfo({
    status: 'active',
    tier: 'premium',
    entry_reason: 'concurrent_session_limit',
    online_count: 5,
    max_sessions: 5,
    recommended_tier: ''
  });
  const premiumDocument = premiumPage.dom.window.document;
  assert.strictEqual(premiumDocument.querySelector('#payBtn').disabled, true);
  assert.match(premiumDocument.querySelector('#payBtn').textContent, /无更高在线版本/);
  premiumPage.dom.window.close();

  assert.match(mainSource, /subResult\.session_granted !== false[\s\S]*subResult\.session_token/);
  assert.match(mainSource, /callApi\('POST', '\/api\/auth\/logout'/);
  assert.match(mainSource, /}, 30 \* 1000\);/);
  assert.match(mainSource, /ipcMain\.handle\('retry-session-entry'/);
  assert.match(html, /attemptSessionEntry\('paymentSuccessEnter'\);/);
  assert.match(preloadSource, /retrySessionEntry:\s*\(\) => ipcRenderer\.invoke\('retry-session-entry'\)/);

  console.log('在线名额超限升级流程测试通过');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
