const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('loginBtn');
const errorMsg = document.getElementById('errorMsg');

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
