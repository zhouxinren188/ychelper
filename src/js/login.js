const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('loginBtn');
const errorMsg = document.getElementById('errorMsg');

// 版本比较
function isOlderVersion(local, remote) {
  var l = local.split('.').map(Number);
  var r = remote.split('.').map(Number);
  for (var i = 0; i < Math.max(l.length, r.length); i++) {
    if ((r[i]||0) > (l[i]||0)) return true;
    if ((r[i]||0) < (l[i]||0)) return false;
  }
  return false;
}

// 显示版本号 + 检查更新
window.electronAPI.getAppVersion().then(ver => {
  var el = document.getElementById('loginVersion');
  if (el && ver) el.textContent = 'v' + ver;

  // 直接比较版本号，不需要请求服务器（避免 CORS 问题）
  var latestVersion = '1.0.66';
  if (ver && isOlderVersion(ver, latestVersion)) {
    var overlay = document.getElementById('updateOverlay');
    var title = document.getElementById('updateTitle');
    var status = document.getElementById('updateStatus');
    if (overlay && title) {
      title.textContent = '发现新版本 v' + latestVersion + '，正在后台下载...';
      if (status) status.textContent = '下载完成后将自动提示安装，请勿关闭软件';
      overlay.classList.add('active');
    }
  }
});

// 启动时自动填充已保存的凭证
(async () => {
  const creds = await window.electronAPI.getCredentials();
  if (creds) {
    usernameInput.value = creds.username || '';
    passwordInput.value = creds.password || '';
  }
})();

// 登录
loginBtn.addEventListener('click', handleLogin);

// 回车登录
passwordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleLogin();
});
usernameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') passwordInput.focus();
});

async function handleLogin() {
  const username = usernameInput.value.trim();
  const password = passwordInput.value.trim();

  errorMsg.textContent = '';

  if (!username) {
    errorMsg.textContent = '请输入账号';
    usernameInput.focus();
    return;
  }
  if (!password) {
    errorMsg.textContent = '请输入密码';
    passwordInput.focus();
    return;
  }

  loginBtn.disabled = true;
  loginBtn.textContent = '登录中...';

  try {
    const result = await window.electronAPI.login({ username, password });

    if (result.success) {
      await window.electronAPI.loginSuccess();
    } else {
      errorMsg.textContent = result.message || '登录失败，请检查账号密码';
      loginBtn.disabled = false;
      loginBtn.textContent = '登 录';
    }
  } catch (err) {
    errorMsg.textContent = '网络错误，请稍后重试';
    loginBtn.disabled = false;
    loginBtn.textContent = '登 录';
  }
}
