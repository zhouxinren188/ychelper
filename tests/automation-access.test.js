const assert = require('assert');
const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');
const { canUseAutomation } = require('../src/js/subscriptionAccess');

assert.strictEqual(canUseAutomation({ status: 'trial', tier: 'basic' }), true);
assert.strictEqual(canUseAutomation({ status: 'trial', tier: 'standard' }), true);
assert.strictEqual(canUseAutomation({ status: 'active', tier: 'premium' }), true);
assert.strictEqual(canUseAutomation({ status: 'active', tier: 'basic' }), false);
assert.strictEqual(canUseAutomation({ status: 'active', tier: 'standard' }), true);
assert.strictEqual(canUseAutomation({ status: 'expired', tier: 'premium' }), false);
assert.strictEqual(canUseAutomation({}), false);

const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(root, 'src', 'css', 'style.css'), 'utf8');
const subscriptionHtml = fs.readFileSync(path.join(root, 'src', 'subscription.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src', 'js', 'renderer.js'), 'utf8');
const packagedAsar = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');

assert.match(subscriptionHtml,
  /<span>自动验收<\/span>\s*<span class="yes">✓<\/span>\s*<span class="yes">✓<\/span>\s*<span class="yes">✓<\/span>/,
  '版本功能对比必须使用“自动验收”名称并保持全版本支持');
assert.match(subscriptionHtml,
  /<span>快速打标、自动定时打标<\/span>\s*<span class="no">—<\/span>\s*<span class="yes">✓<\/span>\s*<span class="yes">✓<\/span>/,
  '版本功能对比必须标明快速打标及自动定时打标支持标准版和高级版');
assert.match(renderer,
  /function canUseFeature\(feature\) \{\s*if \(currentSubscriptionStatus === 'trial'\) return true;/,
  '试用状态必须放行全部功能，不能按基础版档位拦截打单出库');

assert.match(indexHtml,
  /<div class="ao-action-bar sm-action-group">\s*<button class="btn sm-action-btn sm-action-btn-primary" id="aoQueryBtn">查询<\/button>\s*<button class="btn sm-action-btn" id="aoResetBtn">重置<\/button>\s*<button class="btn sm-action-btn" id="aoBatchBtn">批量处理<\/button>/,
  '异常订单的查询、重置、批量处理必须复用快速打标按钮组样式');
assert.doesNotMatch(styleCss, /\.ao-action-bar\s*\{[^}]*gap\s*:/,
  '异常订单按钮组不得保留会拆散分段按钮的间距');
assert.match(styleCss,
  /\.sm-filter-actions \.sm-btn-group\s*\{[^}]*flex:\s*0 0 240px;[^}]*width:\s*240px;[^}]*max-width:\s*100%;/,
  '快速打标的店铺管理按钮组必须缩短为 240px，并在窄屏下保持自适应');
assert.ok(fs.statSync(path.join(root, 'src', 'index.html')).size
    <= asar.statFile(packagedAsar, 'src\\index.html').size,
  '热更新后的异常订单页面不得超过当前完整版本 ASAR 记录长度');
assert.ok(fs.statSync(path.join(root, 'src', 'css', 'style.css')).size
    <= asar.statFile(packagedAsar, 'src\\css\\style.css').size,
  '热更新后的样式文件不得超过当前完整版本 ASAR 记录长度');

console.log('自动化处理版本权限与异常订单按钮组测试通过');
