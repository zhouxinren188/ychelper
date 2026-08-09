'use strict';

const assert = require('assert');
const {
  buildCalendarCells,
  composeDateTimeValue,
  formatDateTimeRange,
  parseDateTimeValue
} = require('../src/js/dateTimeRangePicker');

assert.deepStrictEqual(
  parseDateTimeValue('2026-08-10T09:30:45'),
  { date: '2026-08-10', time: '09:30' }
);
assert.strictEqual(parseDateTimeValue('2026-02-30T09:30'), null);
assert.strictEqual(composeDateTimeValue('2026-08-10', '09:30', '00:00'), '2026-08-10T09:30');
assert.strictEqual(
  formatDateTimeRange('2026-08-10T09:30', '2026-08-12T18:05'),
  '2026-08-10 09:30 至 2026-08-12 18:05'
);
assert.strictEqual(formatDateTimeRange('', ''), '请选择开始和结束时间');

const august2026 = buildCalendarCells(2026, 7);
assert.strictEqual(august2026.length, 42);
assert.strictEqual(august2026[0].key, '2026-07-26');
assert.strictEqual(august2026[6].key, '2026-08-01');
assert.strictEqual(august2026[41].key, '2026-09-05');

console.log('日期时间范围选择器测试通过');
