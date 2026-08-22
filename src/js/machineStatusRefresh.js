(function exposeMachineStatusRefresh(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MachineStatusRefresh = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createApi() {
  'use strict';

  const DEFAULT_REFRESH_INTERVAL_MS = 2000;

  function createMachineStatusRefreshController(options = {}) {
    if (typeof options.getStatus !== 'function' || typeof options.renderStatus !== 'function') {
      throw new TypeError('machine status refresh requires getStatus and renderStatus');
    }

    const getStatus = options.getStatus;
    const renderStatus = options.renderStatus;
    const renderError = typeof options.renderError === 'function'
      ? options.renderError
      : error => renderStatus({ success: false, error: error && error.message ? error.message : '状态读取失败' });
    const isActive = typeof options.isActive === 'function' ? options.isActive : () => true;
    const setIntervalFn = typeof options.setIntervalFn === 'function' ? options.setIntervalFn : setInterval;
    const clearIntervalFn = typeof options.clearIntervalFn === 'function' ? options.clearIntervalFn : clearInterval;
    const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs >= 500
      ? Math.floor(options.intervalMs)
      : DEFAULT_REFRESH_INTERVAL_MS;

    let timer = null;
    let inFlight = null;
    let disposed = false;

    async function refreshNow() {
      if (disposed || !isActive()) return null;
      if (inFlight) return inFlight;

      inFlight = Promise.resolve()
        .then(() => getStatus())
        .then(status => {
          if (!disposed) renderStatus(status);
          return status;
        })
        .catch(error => {
          if (!disposed) renderError(error);
          return null;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    }

    function stopTimer() {
      if (timer === null) return;
      clearIntervalFn(timer);
      timer = null;
    }

    function sync() {
      if (disposed) return Promise.resolve(null);
      if (!isActive()) {
        stopTimer();
        return Promise.resolve(null);
      }
      if (timer === null) {
        timer = setIntervalFn(() => {
          refreshNow();
        }, intervalMs);
      }
      return refreshNow();
    }

    function dispose() {
      disposed = true;
      stopTimer();
    }

    function getState() {
      return {
        active: !disposed && isActive(),
        refreshing: inFlight !== null,
        timer_active: timer !== null,
        disposed
      };
    }

    return { sync, refreshNow, dispose, getState };
  }

  return { DEFAULT_REFRESH_INTERVAL_MS, createMachineStatusRefreshController };
});
