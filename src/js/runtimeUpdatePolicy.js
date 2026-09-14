'use strict';

function createRuntimeUpdatePolicy(isNewerVersion) {
  if (typeof isNewerVersion !== 'function') {
    throw new TypeError('必须提供版本比较函数');
  }

  let pendingUpdate = null;

  function getPending() {
    return pendingUpdate ? { ...pendingUpdate } : null;
  }

  function shouldDownload(version) {
    const candidate = String(version || '').trim();
    if (!candidate) return false;
    return !pendingUpdate || isNewerVersion(candidate, pendingUpdate.version);
  }

  function register(update) {
    const version = String(update?.version || '').trim();
    if (!version) throw new TypeError('更新版本号不能为空');
    if (pendingUpdate && !isNewerVersion(version, pendingUpdate.version)) {
      return { accepted: false, pending: getPending() };
    }

    pendingUpdate = {
      version,
      action: update.action,
      installerPath: update.installerPath || null,
      changelog: String(update.changelog || ''),
      deferred: false
    };
    return { accepted: true, pending: getPending() };
  }

  function defer() {
    if (!pendingUpdate) return false;
    pendingUpdate.deferred = true;
    return true;
  }

  function clear() {
    pendingUpdate = null;
  }

  return { getPending, shouldDownload, register, defer, clear };
}

module.exports = { createRuntimeUpdatePolicy };
