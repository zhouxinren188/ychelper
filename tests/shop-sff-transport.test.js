'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { compile } = require('../scripts/compile-shop-sff-transport');
const { ShopSffTransportClient } = require('../shop-sff-transport');

const root = path.resolve(__dirname, '..');
const executable = compile();
assert.strictEqual(fs.existsSync(executable), true, '兼容传输模块必须能够构建');

const rawHeaders = execFileSync(executable, ['--self-test'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
  timeout: 10000
}).replace(/^\uFEFF/, '');

const lines = rawHeaders.split(/\r?\n/).filter(Boolean);
assert.strictEqual(lines[0], 'POST /api?v=1.0 HTTP/1.0');
assert.deepStrictEqual(lines.slice(1).map(line => line.split(':')[0]), [
  'Accept',
  'User-Agent',
  'Cookie',
  'Content-Type',
  'dsm-platform',
  'h5st',
  'dsm-eid',
  'Host',
  'Content-Length',
  'Connection'
]);
assert.match(rawHeaders, /Chrome\/131\.0\.0\.0/);
assert.match(rawHeaders, /Connection: Keep-Alive/i);

const protocolLine = execFileSync(executable, [], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
  timeout: 10000,
  input: `${JSON.stringify({ id: 42, api: 'not.allowed', bodyText: '{}' })}\n`
}).trim().replace(/^\uFEFF/, '');
const protocolResponse = JSON.parse(protocolLine);
assert.strictEqual(protocolResponse.id, 42, '无效请求也必须按原请求 ID 结算，不能让主进程永久等待');
assert.strictEqual(protocolResponse.ok, false);
assert.strictEqual(protocolResponse.errorCode, 'invalid_request');

const source = fs.readFileSync(path.join(root, 'native', 'shop-sff-transport', 'ShopSffTransport.cs'), 'utf8');
assert.match(source, /SecurityProtocolType\.Tls12/);
assert.match(source, /ProtocolVersion = HttpVersion\.Version10/);
assert.match(source, /https:\/\/sff\.jd\.com\/api/);
assert.match(source, /IsAllowedApi\(input\.api\)/);
assert.match(source, /IsAllowedUserAgent\(input\.userAgent\)/);
assert.match(source, /request\.UserAgent = input\.userAgent/);
assert.doesNotMatch(source, /ServerCertificateValidationCallback|DangerousAcceptAnyServerCertificateValidator/);

const invalidUserAgentLine = execFileSync(executable, [], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
  timeout: 10000,
  input: `${JSON.stringify({
    id: 43,
    api: 'dsm.product.manage.SkuInfoReadViewService.querySkuList',
    bodyText: '{}',
    h5st: 'probe',
    dsmEid: 'probe',
    userAgent: 'Mozilla/5.0 Chrome/134.0.0.0 Electron/35.0.0 Safari/537.36',
    cookie: 'thor=probe',
    timeoutMs: 1000
  })}\n`
}).trim().replace(/^\uFEFF/, '');
const invalidUserAgentResponse = JSON.parse(invalidUserAgentLine);
assert.strictEqual(invalidUserAgentResponse.id, 43);
assert.strictEqual(invalidUserAgentResponse.ok, false);
assert.strictEqual(invalidUserAgentResponse.errorCode, 'invalid_request');

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.strictEqual(packageJson.build.files.includes('shop-sff-transport.js'), true);
assert.strictEqual(
  packageJson.build.extraResources.some(item => item.to === 'shop-sff-transport/ShopSffTransport.exe'),
  true,
  '完整安装包必须携带兼容传输模块'
);

async function testClientProtocol() {
  const client = new ShopSffTransportClient({ executablePath: executable });
  try {
    await assert.rejects(
      client.request({
        api: 'not.allowed',
        bodyText: '{}',
        h5st: 'probe',
        dsmEid: 'probe',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        cookie: 'thor=probe',
        timeoutMs: 1000
      }),
      error => error && error.code === 'invalid_request'
    );
  } finally {
    client.close();
  }
}

testClientProtocol()
  .then(() => console.log('shop-sff-transport tests passed'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
