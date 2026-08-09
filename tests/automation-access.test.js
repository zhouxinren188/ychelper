const assert = require('assert');
const { canUseAutomation } = require('../src/js/subscriptionAccess');

assert.strictEqual(canUseAutomation({ status: 'trial', tier: 'basic' }), true);
assert.strictEqual(canUseAutomation({ status: 'trial', tier: 'standard' }), true);
assert.strictEqual(canUseAutomation({ status: 'active', tier: 'premium' }), true);
assert.strictEqual(canUseAutomation({ status: 'active', tier: 'basic' }), false);
assert.strictEqual(canUseAutomation({ status: 'active', tier: 'standard' }), false);
assert.strictEqual(canUseAutomation({ status: 'expired', tier: 'premium' }), false);
assert.strictEqual(canUseAutomation({}), false);

console.log('自动化处理版本权限测试通过');
