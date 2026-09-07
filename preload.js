const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 窗口控制
  minimize: () => ipcRenderer.send('window-minimize'),
  close: () => ipcRenderer.send('window-close'),

  // 登录
  openWebLogin: (cred) => ipcRenderer.invoke('open-web-login', cred),
  getUserData: () => ipcRenderer.invoke('get-user-data'),
  getCookies: () => ipcRenderer.invoke('get-cookies'),
  getCsrfToken: () => ipcRenderer.invoke('get-csrf-token'),
  getCredentials: () => ipcRenderer.invoke('get-credentials'),
  getCredentialList: () => ipcRenderer.invoke('get-credential-list'),
  saveCredentials: (cred) => ipcRenderer.invoke('save-credentials', cred),

  // 商家端多账号管理
  getMerchantAccounts: () => ipcRenderer.invoke('get-merchant-accounts'),
  saveMerchantAccount: (account) => ipcRenderer.invoke('save-merchant-account', account),
  deleteMerchantAccount: (id) => ipcRenderer.invoke('delete-merchant-account', id),
  switchMerchantAccount: (account) => ipcRenderer.invoke('switch-merchant-account', account),

  // 快捷模式
  getModes: () => ipcRenderer.invoke('get-modes'),
  saveMode: (mode) => ipcRenderer.invoke('save-mode', mode),
  deleteMode: (modeName) => ipcRenderer.invoke('delete-mode', modeName),

  // 文件
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  saveFailedLabelSkus: (params) => ipcRenderer.invoke('save-failed-label-skus', params),

  // Excel 生成
  generateExcel: (params) => ipcRenderer.invoke('generate-excel', params),
  openOutputDir: () => ipcRenderer.invoke('open-output-dir'),

  // Excel 上传
  uploadExcel: (params) => ipcRenderer.invoke('upload-excel', params),

  // 查询店铺商品（CSG编码）
  queryShopGoods: (params) => ipcRenderer.invoke('query-shop-goods', params),

  // 保存库存比例配置
  saveStockConfig: (params) => ipcRenderer.invoke('save-stock-config', params),

  // 批量启用/停用店铺商品
  batchToggleShopGoods: (params) => ipcRenderer.invoke('batch-toggle-shop-goods', params),

  // 批量启用/停用商品主数据
  batchToggleMasterData: (params) => ipcRenderer.invoke('batch-toggle-master-data', params),

  // 京配打标生效/取消
  jdLabelGoods: (params) => ipcRenderer.invoke('jd-label-goods', params),

  // WMS 仓库端
  openWmsLogin: (cred) => ipcRenderer.invoke('open-wms-login', cred),
  openWmsPrintOutbound: () => ipcRenderer.invoke('open-wms-print-outbound'),
  checkWmsSession: () => ipcRenderer.invoke('check-wms-session'),
  restoreWmsSession: () => ipcRenderer.invoke('restore-wms-session'),
  getWmsLoginStatus: () => ipcRenderer.invoke('get-wms-login-status'),
  onWmsLoginSuccess: (callback) => ipcRenderer.on('wms-login-success', (event, data) => callback(data)),
  wmsQueryOrders: (params) => ipcRenderer.invoke('wms-query-orders', params),
  executeWmsOutboundPrint: (params) => ipcRenderer.invoke('wms-prepare-outbound-print', params),
  outboundWmsOrder: (params) => ipcRenderer.invoke('wms-outbound-order', params),
  getWmsCredentials: () => ipcRenderer.invoke('get-wms-credentials'),
  saveWmsCredentials: (cred) => ipcRenderer.invoke('save-wms-credentials', cred),
  getWmsAccounts: () => ipcRenderer.invoke('get-wms-accounts'),
  saveWmsAccount: (account) => ipcRenderer.invoke('save-wms-account', account),
  deleteWmsAccount: (id) => ipcRenderer.invoke('delete-wms-account', id),
  switchWmsAccount: (account) => ipcRenderer.invoke('switch-wms-account', account),
  getWmsLocation: () => ipcRenderer.invoke('get-wms-location'),
  saveWmsLocation: (loc) => ipcRenderer.invoke('save-wms-location', loc),
  wmsAcceptOrder: (params) => ipcRenderer.invoke('wms-accept-order', params),

  // 店铺管理
  getShopAccounts: () => ipcRenderer.invoke('get-shop-accounts'),
  saveShopAccount: (account) => ipcRenderer.invoke('save-shop-account', account),
  deleteShopAccount: (id) => ipcRenderer.invoke('delete-shop-account', id),
  openShopLogin: (cred) => ipcRenderer.invoke('open-shop-login', cred),
  openShopBackend: (accountId) => ipcRenderer.invoke('open-shop-backend', accountId),
  getShopLoginStatus: () => ipcRenderer.invoke('get-shop-login-status'),
  checkShopAccountsStatus: () => ipcRenderer.invoke('check-shop-accounts-status'),
  switchShopAccount: (account) => ipcRenderer.invoke('switch-shop-account', account),
  onShopLoginSuccess: (callback) => ipcRenderer.on('shop-login-success', (event, data) => callback(data)),
  shopQueryGoods: (params) => ipcRenderer.invoke('shop-query-goods', params),
  onShopQueryProgress: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('shop-query-progress', listener);
    return () => ipcRenderer.removeListener('shop-query-progress', listener);
  },
  exportSkuTxt: (params) => ipcRenderer.invoke('export-sku-txt', params),
  getSmStats: () => ipcRenderer.invoke('get-sm-stats'),
  updateSmStats: (data) => ipcRenderer.invoke('update-sm-stats', data),

  // 异常订单
  queryAbnormalOrders: (params) => ipcRenderer.invoke('query-abnormal-orders', params),
  handleAbnormalOrder: (params) => ipcRenderer.invoke('handle-abnormal-order', params),

  // 订阅系统
  checkSubscription: (params) => ipcRenderer.invoke('check-subscription', params),
  createPaymentOrder: (params) => {
    return ipcRenderer.invoke('create-payment-order', JSON.stringify(params));
  },
  quoteSubscriptionUpgrade: (params) => {
    return ipcRenderer.invoke('quote-subscription-upgrade', JSON.stringify(params));
  },
  queryPaymentOrder: (orderNo) => ipcRenderer.invoke('query-payment-order', orderNo),
  generateQRCode: (text) => ipcRenderer.invoke('generate-qrcode', text),
  getSubscriptionInfo: () => ipcRenderer.invoke('get-subscription-info'),
  openSubscription: () => ipcRenderer.invoke('open-subscription'),
  getDeviceId: () => ipcRenderer.invoke('get-device-id'),
  getMachineCode: () => ipcRenderer.invoke('get-machine-code'),
  generateMachineCode: () => ipcRenderer.invoke('generate-machine-code'),
  getOrderCommandStatus: () => ipcRenderer.invoke('get-order-command-status'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  retrySessionEntry: () => ipcRenderer.invoke('retry-session-entry'),
  paymentSuccessEnter: () => ipcRenderer.invoke('payment-success-enter'),
  onSessionKicked: (callback) => ipcRenderer.on('session-kicked', () => callback()),
  onSubscriptionExpired: (callback) => ipcRenderer.on('subscription-expired', () => callback()),
  onSubscriptionInfo: (callback) => ipcRenderer.on('subscription-info', (event, data) => callback(data)),
  onDeptList: (callback) => ipcRenderer.on('dept-list', (event, data) => callback(data)),
  selectDepartment: (dept) => ipcRenderer.send('select-department', dept),
  checkDepartmentSubscription: (deptNo) => ipcRenderer.invoke('check-department-subscription', deptNo),

  // 热更新进度
  onUpdateProgress: (callback) => ipcRenderer.on('update-progress', (event, data) => callback(data)),

  // 退出确认
  onShowCloseConfirm: (callback) => ipcRenderer.on('show-close-confirm', () => callback()),
  confirmClose: () => ipcRenderer.send('confirm-close'),

  // 更新下载（服务器端）
  onShowUpdateDownloading: (callback) => ipcRenderer.on('show-update-downloading', (event, data) => callback(data)),
  onUpdateDownloadProgress: (callback) => ipcRenderer.on('update-download-progress', (event, data) => callback(data)),
  onShowUpdateInstall: (callback) => ipcRenderer.on('show-update-install', (event, data) => callback(data)),
  onShowUpdateDownloadFailed: (callback) => ipcRenderer.on('show-update-download-failed', (event, data) => callback(data)),
  confirmUpdateInstall: () => ipcRenderer.send('confirm-update-install'),
  confirmUpdateInstallByPath: () => ipcRenderer.send('confirm-update-install-by-path'),
  openExternalDownload: (url) => ipcRenderer.send('open-external-download', url)
});
