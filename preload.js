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
  saveCredentials: (cred) => ipcRenderer.invoke('save-credentials', cred),

  // 快捷模式
  getModes: () => ipcRenderer.invoke('get-modes'),
  saveMode: (mode) => ipcRenderer.invoke('save-mode', mode),
  deleteMode: (modeName) => ipcRenderer.invoke('delete-mode', modeName),

  // 文件
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),

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

  // WMS 仓库端
  openWmsLogin: (cred) => ipcRenderer.invoke('open-wms-login', cred),
  getWmsLoginStatus: () => ipcRenderer.invoke('get-wms-login-status'),
  onWmsLoginSuccess: (callback) => ipcRenderer.on('wms-login-success', (event, data) => callback(data)),
  wmsQueryOrders: (params) => ipcRenderer.invoke('wms-query-orders', params),
  getWmsCredentials: () => ipcRenderer.invoke('get-wms-credentials'),
  saveWmsCredentials: (cred) => ipcRenderer.invoke('save-wms-credentials', cred),
  getWmsLocation: () => ipcRenderer.invoke('get-wms-location'),
  saveWmsLocation: (loc) => ipcRenderer.invoke('save-wms-location', loc),
  wmsAcceptOrder: (params) => ipcRenderer.invoke('wms-accept-order', params)
});
