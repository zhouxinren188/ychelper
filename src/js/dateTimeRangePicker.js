'use strict';

(function exposeDateTimeRangePicker(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.dateTimeRangePicker = api;
})(typeof window !== 'undefined' ? window : globalThis, function createApi() {
  const pad2 = value => String(value).padStart(2, '0');

  function dateToKey(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function parseDateTimeValue(value) {
    const match = String(value || '').match(
      /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::\d{2})?$/
    );
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const date = new Date(year, month - 1, day);
    if (
      date.getFullYear() !== year
      || date.getMonth() !== month - 1
      || date.getDate() !== day
      || hour > 23
      || minute > 59
    ) return null;
    return { date: `${match[1]}-${match[2]}-${match[3]}`, time: `${match[4]}:${match[5]}` };
  }

  function composeDateTimeValue(date, time, fallbackTime) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return '';
    const normalizedTime = /^\d{2}:\d{2}$/.test(String(time || '')) ? time : fallbackTime;
    return `${date}T${normalizedTime}`;
  }

  function formatDateTimeRange(startValue, endValue) {
    const start = parseDateTimeValue(startValue);
    const end = parseDateTimeValue(endValue);
    if (!start || !end) return '请选择开始和结束时间';
    return `${start.date} ${start.time} 至 ${end.date} ${end.time}`;
  }

  function buildCalendarCells(year, monthIndex) {
    const firstDay = new Date(year, monthIndex, 1);
    const firstCell = new Date(year, monthIndex, 1 - firstDay.getDay());
    return Array.from({ length: 42 }, (item, index) => {
      const date = new Date(
        firstCell.getFullYear(),
        firstCell.getMonth(),
        firstCell.getDate() + index
      );
      return {
        key: dateToKey(date),
        day: date.getDate(),
        currentMonth: date.getMonth() === monthIndex
      };
    });
  }

  function createDateTimeRangePicker(options = {}) {
    const doc = options.document || document;
    const byId = id => doc.getElementById(id);
    const rootElement = byId(options.rootId || 'smDateRangePicker');
    const startInput = byId(options.startInputId || 'smDateFrom');
    const endInput = byId(options.endInputId || 'smDateTo');
    const trigger = byId('smDateRangeTrigger');
    const triggerText = byId('smDateRangeText');
    const popover = byId('smDateRangePopover');
    const monthLabel = byId('smDateRangeMonth');
    const calendar = byId('smDateRangeCalendar');
    const startText = byId('smDateRangeStartText');
    const endText = byId('smDateRangeEndText');
    const startTimeInput = byId('smDateRangeStartTime');
    const endTimeInput = byId('smDateRangeEndTime');

    if (!rootElement || !startInput || !endInput || !trigger || !popover || !calendar) {
      return null;
    }

    let draftStartDate = '';
    let draftEndDate = '';
    let viewYear = new Date().getFullYear();
    let viewMonth = new Date().getMonth();

    function reportError(message) {
      if (typeof options.onError === 'function') options.onError(message);
    }

    function syncTrigger() {
      triggerText.textContent = formatDateTimeRange(startInput.value, endInput.value);
      trigger.classList.toggle('has-value', !!parseDateTimeValue(startInput.value));
    }

    function renderCalendar() {
      monthLabel.textContent = `${viewYear}年${viewMonth + 1}月`;
      calendar.innerHTML = '';
      const todayKey = dateToKey(new Date());
      for (const cell of buildCalendarCells(viewYear, viewMonth)) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.textContent = String(cell.day);
        button.dataset.date = cell.key;
        button.className = 'sm-date-range-day';
        if (!cell.currentMonth) button.classList.add('is-outside');
        if (cell.key === todayKey) button.classList.add('is-today');
        if (cell.key === draftStartDate) button.classList.add('is-start');
        if (cell.key === draftEndDate) button.classList.add('is-end');
        if (draftStartDate && draftEndDate && cell.key > draftStartDate && cell.key < draftEndDate) {
          button.classList.add('is-in-range');
        }
        if (cell.key === draftStartDate || cell.key === draftEndDate) {
          button.setAttribute('aria-pressed', 'true');
        }
        calendar.appendChild(button);
      }
      startText.textContent = draftStartDate || '未选择';
      endText.textContent = draftEndDate || '未选择';
    }

    function openPicker() {
      const savedStart = parseDateTimeValue(startInput.value);
      const savedEnd = parseDateTimeValue(endInput.value);
      draftStartDate = savedStart ? savedStart.date : '';
      draftEndDate = savedEnd ? savedEnd.date : '';
      startTimeInput.value = savedStart ? savedStart.time : '00:00';
      endTimeInput.value = savedEnd ? savedEnd.time : '23:59';

      const initial = savedStart ? savedStart.date : dateToKey(new Date());
      const [year, month] = initial.split('-').map(Number);
      viewYear = year;
      viewMonth = month - 1;
      renderCalendar();
      popover.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      rootElement.classList.add('is-open');
    }

    function closePicker() {
      popover.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      rootElement.classList.remove('is-open');
    }

    function selectDate(dateKey) {
      if (!draftStartDate || draftEndDate) {
        draftStartDate = dateKey;
        draftEndDate = '';
      } else if (dateKey < draftStartDate) {
        draftStartDate = dateKey;
        draftEndDate = '';
      } else {
        draftEndDate = dateKey;
      }
      renderCalendar();
    }

    function setCommittedValue(input, value) {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function confirmPicker() {
      if (!draftStartDate || !draftEndDate) {
        reportError('请依次选择开始日期和结束日期');
        return;
      }
      const startValue = composeDateTimeValue(draftStartDate, startTimeInput.value, '00:00');
      const endValue = composeDateTimeValue(draftEndDate, endTimeInput.value, '23:59');
      if (startValue > endValue) {
        reportError('开始时间不能晚于结束时间');
        return;
      }
      setCommittedValue(startInput, startValue);
      setCommittedValue(endInput, endValue);
      syncTrigger();
      closePicker();
    }

    function clearPicker() {
      setCommittedValue(startInput, '');
      setCommittedValue(endInput, '');
      syncTrigger();
      closePicker();
    }

    function shiftMonth(offset) {
      const shifted = new Date(viewYear, viewMonth + offset, 1);
      viewYear = shifted.getFullYear();
      viewMonth = shifted.getMonth();
      renderCalendar();
    }

    trigger.addEventListener('click', () => {
      if (popover.hidden) openPicker();
      else closePicker();
    });
    byId('smDateRangePrev').addEventListener('click', () => shiftMonth(-1));
    byId('smDateRangeNext').addEventListener('click', () => shiftMonth(1));
    calendar.addEventListener('click', event => {
      const dayButton = event.target.closest('[data-date]');
      if (dayButton) selectDate(dayButton.dataset.date);
    });
    byId('smDateRangeClear').addEventListener('click', clearPicker);
    byId('smDateRangeCancel').addEventListener('click', closePicker);
    byId('smDateRangeConfirm').addEventListener('click', confirmPicker);

    const onOutsidePointerDown = event => {
      if (!popover.hidden && !rootElement.contains(event.target)) closePicker();
    };
    const onEscape = event => {
      if (event.key === 'Escape' && !popover.hidden) closePicker();
    };
    doc.addEventListener('pointerdown', onOutsidePointerDown);
    doc.addEventListener('keydown', onEscape);

    syncTrigger();
    return {
      close: closePicker,
      open: openPicker,
      sync: syncTrigger,
      destroy() {
        doc.removeEventListener('pointerdown', onOutsidePointerDown);
        doc.removeEventListener('keydown', onEscape);
      }
    };
  }

  return {
    buildCalendarCells,
    composeDateTimeValue,
    createDateTimeRangePicker,
    formatDateTimeRange,
    parseDateTimeValue
  };
});
