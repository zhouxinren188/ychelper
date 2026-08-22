const assert = require('assert');
const fs = require('fs');
const path = require('path');

const styleSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'css', 'style.css'),
  'utf8'
);

const modalHeader = styleSource.match(/\.modal-header\s*\{([\s\S]*?)\}/);
assert.ok(modalHeader, '应保留通用弹窗标题栏样式');
assert.match(modalHeader[1], /min-height:\s*36px/,
  '通用弹窗标题栏应收紧为36px');
assert.match(modalHeader[1], /padding:\s*6px\s+14px/,
  '通用弹窗标题栏不应保留过大的上下留白');
assert.match(modalHeader[1], /line-height:\s*20px/,
  '标题文字应使用紧凑且稳定的行高');

const modalClose = styleSource.match(/\.modal-close\s*\{([\s\S]*?)\}/);
assert.ok(modalClose, '应保留通用弹窗关闭按钮样式');
assert.match(modalClose[1], /width:\s*24px/);
assert.match(modalClose[1], /height:\s*24px/);
assert.match(modalClose[1], /line-height:\s*1/);

console.log('通用弹窗标题栏紧凑样式测试通过');
