// Real NSIS upgrade, using immutable local artifact mirrors and a private pending
// feed. Production update metadata is not changed until this smoke passes.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const asar = require('@electron/asar');
const puppeteer = require('puppeteer-core');
const root = path.resolve(process.argv[2]);
const version = process.argv[3] || '1.0.94';
const resume = process.argv.includes('--resume');
const dist = path.resolve('dist');
const install = path.join(root, 'install');
const profile = path.join(root, 'userData');
const executablePath = path.join(install, '云仓助手.exe');
const origin = 'http://150.158.54.108:3000';
const id = '00000000-0000-4000-8000-000000000094';
const trace = resume ? JSON.parse(fs.readFileSync(path.join(root, 'trace.json'), 'utf8')).trace : [];
const errors = [];
const sockets = new Set();
const browsers = new Set();
let browser;
let server;
let launchArgs;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function sha(buffer) { return crypto.createHash('sha512').update(buffer).digest('base64'); }
function installedVersion() {
  try { const file = path.join(install, 'resources/app.asar'); asar.uncache(file); return JSON.parse(asar.extractFile(file, 'package.json')).version; } catch { return ''; }
}
function event(type, detail = '') { trace.push({ time: new Date().toISOString(), type, detail }); console.log(type, detail); }
async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  assert.strictEqual(response.status, 200, url);
  return response.json();
}
function serveFile(req, res, file) {
  const size = fs.statSync(file).size;
  const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' };
  if (req.method === 'HEAD') { res.writeHead(200, { ...headers, 'Content-Length': size }); res.end(); return; }
  const ranges = req.headers.range && req.headers.range.replace(/^bytes=/, '').split(',').map(item => {
    const [start, end] = item.trim().split('-'); return { start: Number(start), end: end ? Number(end) : size - 1 };
  });
  if (ranges?.some(range => !Number.isInteger(range.start) || range.start < 0 || range.end < range.start || range.end >= size)) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return;
  }
  if (ranges?.length > 1) {
    const boundary = 'releaseSmokeBoundary';
    const fd = fs.openSync(file, 'r');
    try {
      const chunks = [];
      for (const range of ranges) {
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes ${range.start}-${range.end}/${size}\r\n\r\n`));
        const chunk = Buffer.alloc(range.end - range.start + 1);
        fs.readSync(fd, chunk, 0, chunk.length, range.start); chunks.push(chunk, Buffer.from('\r\n'));
      }
      chunks.push(Buffer.from(`--${boundary}--\r\n`));
      const body = Buffer.concat(chunks);
      res.writeHead(206, { ...headers, 'Content-Type': `multipart/byteranges; boundary=${boundary}`, 'Content-Length': body.length }); res.end(body);
    } finally { fs.closeSync(fd); }
  } else {
    const range = ranges?.[0];
    res.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': range ? range.end - range.start + 1 : size, ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${size}` } : {}) });
    fs.createReadStream(file, range ? { start: range.start, end: range.end } : {}).pipe(res);
  }
}
function stopOnlyFixture() {
  const command = `$root='${root.replace(/'/g, "''")}'; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root+[IO.Path]::DirectorySeparatorChar) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' });
}
async function reconnect() {
  if (browser?.connected) return browser;
  try {
    const [port, endpoint] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
    browser = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${port}${endpoint}`, defaultViewport: null, protocolTimeout: 10000 });
    browsers.add(browser); return browser;
  } catch { return null; }
}
async function main() {
  if (!resume) assert.strictEqual(installedVersion(), '1.0.66');
  else {
    assert.ok(['1.0.68', version].includes(installedVersion()));
    assert.ok(trace.some(entry => entry.type === 'REAL_NSIS_INSTALLED_VERSION' && entry.detail === '1.0.66'));
    assert.ok(trace.some(entry => entry.type === 'REAL_NSIS_INSTALLED_VERSION' && entry.detail === '1.0.68'));
    event('RESUMED_VERIFIED_INSTALLATION', installedVersion());
  }
  const bootstrap = await json(`${origin}/api/update/check?version=1.0.66&verify=1`);
  const bridge = await json(`${origin}/api/update/full-check?version=1.0.66&verify=1`);
  const pending = await json(`${origin}/updates/full-update-meta-${version}.pending.json`);
  assert.strictEqual(bootstrap.version, '1.0.66.3');
  assert.strictEqual(bridge.version, '1.0.68');
  assert.strictEqual(pending.version, version);
  assert.strictEqual(pending.changelog, fs.readFileSync(path.resolve('release-notes', `${version}.md`), 'utf8').trim());
  for (const [name, metadata] of [[`update-${bootstrap.version}.zip`, bootstrap], ['ychelper-setup-1.0.68.exe', bridge], [`ychelper-setup-${version}.exe`, pending]]) {
    const data = fs.readFileSync(path.join(dist, name)); assert.strictEqual(data.length, metadata.size); assert.strictEqual(sha(data), metadata.sha512);
  }
  const candidateFeed = `version: ${version}\nfiles:\n  - url: api/update/file/ychelper-setup-${version}.exe\n    sha512: ${pending.sha512}\n    size: ${pending.size}\npath: api/update/file/ychelper-setup-${version}.exe\nsha512: ${pending.sha512}\nreleaseDate: '${pending.updatedAt}'\n`;
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      const clientVersion = url.searchParams.get('version');
      if (url.pathname.startsWith('/api/update/')) trace.push({ time: new Date().toISOString(), type: 'UPDATE_HTTP', path: url.pathname, clientVersion });
      if (url.pathname === '/api/update/download' && installedVersion() === '1.0.66') {
        event('IMMUTABLE_LEGACY_BRIDGE_DOWNLOADED', bootstrap.version);
        serveFile(req, res, path.join(dist, `update-${bootstrap.version}.zip`)); return;
      }
      if (url.pathname === '/latest.yml' && ['1.0.68', version].includes(installedVersion())) {
        event('PRIVATE_PENDING_FULL_FEED', installedVersion());
        res.writeHead(200, { 'Content-Type': 'text/yaml', 'Cache-Control': 'no-store' }); res.end(candidateFeed); return;
      }
      if (['/api/update/full-check', '/api/update/login-check'].includes(url.pathname) && clientVersion && clientVersion !== '1.0.66' && clientVersion !== '1.0.66.3') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        // Node-based downloaders do not honor Chromium's --proxy-server flag.
        // Point only this private feed at the same verified immutable bytes.
        const downloadUrl = `http://127.0.0.1:${server.address().port}/api/update/file/ychelper-setup-${version}.exe`;
        res.end(JSON.stringify(clientVersion === version ? { needUpdate: false } : { needUpdate: true, ...pending, downloadUrl })); return;
      }
      const name = path.basename(url.pathname);
      if (/^ychelper-setup-\d+\.\d+\.\d+\.exe(?:\.blockmap)?$/.test(name) && fs.existsSync(path.join(dist, name))) {
        if (!name.endsWith('.blockmap')) event('IMMUTABLE_INSTALLER_HTTP', `${name}${req.headers.range ? ' Range' : ''}`);
        serveFile(req, res, path.join(dist, name)); return;
      }
      const headers = { ...req.headers }; delete headers.host; delete headers.connection; delete headers['accept-encoding'];
      const response = await fetch(url, { method: req.method, headers, signal: AbortSignal.timeout(45000) });
      const body = Buffer.from(await response.arrayBuffer());
      const forwarded = Object.fromEntries(response.headers); delete forwarded['content-encoding']; delete forwarded['transfer-encoding'];
      res.writeHead(response.status, { ...forwarded, 'Content-Length': body.length }); res.end(body);
    } catch (error) { errors.push('proxy: ' + error.message); res.writeHead(502); res.end(error.message); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  launchArgs = ['--remote-debugging-port=0', '--user-data-dir=' + profile, '--proxy-server=http://127.0.0.1:' + server.address().port];
  // Keep supported userData/proxy/debug flags in the temporary installation's
  // shortcuts so the actual NSIS force-run restart cannot use developer data.
  const shortcutCommand = `$root='${root.replace(/'/g, "''")}'; $exe='${executablePath.replace(/'/g, "''")}'; $flags='${launchArgs.map(arg => `"${arg}"`).join(' ').replace(/'/g, "''")}'; $shell=New-Object -ComObject WScript.Shell; foreach($file in @((Join-Path ([Environment]::GetFolderPath('Desktop')) '云仓助手.lnk'),(Join-Path (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs') '云仓助手.lnk'))){ $link=$shell.CreateShortcut($file); if($link.TargetPath -ne $exe){throw 'Shortcut is not this fixture'}; $link.Arguments=$flags; $link.WindowStyle=7; $link.Save() }`;
  execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(shortcutCommand, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'pipe' });
  if (!resume) {
  fs.mkdirSync(path.join(profile, 'cookies'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    credentials: { username: 'release-fixture-account', password: 'fixture-password', rememberPassword: true },
    credentialList: [{ username: 'release-fixture-account', password: 'fixture-password' }],
    merchantAccounts: [{ id, username: 'release-fixture-account', password: 'fixture-password' }],
    lastMerchantAccountId: id, _cookieMigrated: true, dataSchemaVersion: 0,
    cookies: 'release_fixture=not-a-real-login', sellerId: '20000000094',
    userData: { departmentName: '发布测试事业部', departmentId: 'CBU94', selectedDeptId: 'CBU94',
      deptPairs: [{ id: '94', deptNo: 'CBU94', deptName: '发布测试事业部', sellerId: '20000000094' }],
      shops: [{ shopId: 'CSP0020000000094', shopName: '发布测试店铺', spShopNo: '225737397', deptId: '94', deptNo: 'CBU94', sellerId: '' }],
      warehouses: [{ warehouseId: '800000094', warehouseName: '发布测试仓库' }] },
    subscriptionInfo: { status: 'trial', tier: 'premium', days_remaining: 7 }, shopAccounts: [], wmsAccounts: []
  }));
  fs.writeFileSync(path.join(profile, 'cookies', `merchant-${id}.json`), JSON.stringify({ accountId: id, type: 'merchant', cookies: [{ name: 'release_fixture', value: 'not-a-real-login', domain: '.example.invalid', path: '/' }] }));
  }
  browser = await puppeteer.launch({ executablePath, headless: false, defaultViewport: null, ignoreDefaultArgs: true, args: launchArgs, timeout: 30000, protocolTimeout: 10000 });
  browsers.add(browser);
  let lastVersion = '';
  let confirmed = false;
  const seen = new Set(trace.filter(entry => entry.type === 'REAL_NSIS_INSTALLED_VERSION').map(entry => entry.detail));
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    const current = installedVersion();
    if (current && current !== lastVersion) { lastVersion = current; seen.add(current); event('REAL_NSIS_INSTALLED_VERSION', current); }
    const connection = await reconnect();
    if (connection) {
      const pages = await connection.pages().catch(() => []);
      for (const page of pages) {
        if (!page.url().includes('/src/login.html')) continue;
        if (!page.__releaseObserved) { page.__releaseObserved = true; page.on('pageerror', error => errors.push(error.message)); }
        if (current === '1.0.68' && !confirmed) {
          confirmed = await page.evaluate(() => {
            const button = [...document.querySelectorAll('button')].find(button => button.textContent.includes('立即安装') && button.getBoundingClientRect().width > 0 && getComputedStyle(button).visibility !== 'hidden');
            if (!button) return false; button.click(); return true;
          }).catch(() => false);
          if (confirmed) event('HISTORICAL_1.0.68_INSTALL_CONFIRMATION', 'clicked');
        }
        if (current === version) {
          const ready = await page.evaluate(expected => document.getElementById('loginVersion')?.textContent.includes(expected) && document.getElementById('username')?.value === 'release-fixture-account', version).catch(() => false);
          if (!ready) continue;
          assert.ok(seen.has('1.0.66') && seen.has('1.0.68'), 'Must complete the actual oldest bridge installation');
          const retained = await page.evaluate(async () => ({ userData: await window.electronAPI.getUserData(), credentials: await window.electronAPI.getCredentials(), cookies: await window.electronAPI.getCookies(), accounts: await window.electronAPI.getMerchantAccounts() }));
          assert.strictEqual(retained.credentials.password, 'fixture-password');
          assert.strictEqual(retained.userData.deptPairs[0].sellerId, '20000000094');
          assert.ok(String(retained.cookies).includes('release_fixture'));
          assert.ok(retained.accounts.some(account => account.id === id));
          assert.ok(fs.existsSync(path.join(profile, 'cookies', `merchant-${id}.json`)));
          const layout = await page.evaluate(() => { const rect = document.getElementById('loginBtn').getBoundingClientRect(); return { width: innerWidth, height: innerHeight, buttonBottom: rect.bottom, buttonRight: rect.right }; });
          assert.deepStrictEqual([layout.width, layout.height], [620, 400]);
          assert.ok(layout.buttonBottom <= layout.height && layout.buttonRight <= layout.width);
          // NSIS starts the isolated shortcut minimized; pointer scrolling waits
          // for animation frames that Chromium suspends in minimized windows.
          await page.evaluate(() => { document.getElementById('username').value = ''; document.getElementById('loginBtn').click(); });
          await page.waitForFunction(() => document.getElementById('loginTip')?.textContent.includes('账号'));
          assert.deepStrictEqual(errors, []);
          event('REAL_UPGRADE_AUTO_RESTART_CREDENTIALS_COOKIE_CONFIG_LAYOUT_PASS', version);
          fs.writeFileSync(path.join(dist, `release-real-upgrade-${version}.json`), JSON.stringify({ version, root, seen: [...seen], layout, errors, trace, passed: true }, null, 2));
          return;
        }
      }
    }
    await delay(500);
  }
  throw new Error('Real oldest upgrade timed out: ' + JSON.stringify(trace.slice(-20)));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  stopOnlyFixture();
  for (const connection of browsers) { try { connection.disconnect(); } catch {} }
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise(resolve => server.close(resolve));
  fs.writeFileSync(path.join(root, 'trace.json'), JSON.stringify({ errors, trace }, null, 2));
});
