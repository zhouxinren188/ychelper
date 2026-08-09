(function initSubscriptionAccess(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.subscriptionAccess = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createSubscriptionAccess() {
  function canUseAutomation(subscription) {
    const status = String(subscription?.status || '').trim().toLowerCase();
    const tier = String(subscription?.tier || '').trim().toLowerCase();
    return status === 'trial' || (status === 'active' && tier === 'premium');
  }

  return { canUseAutomation };
});
