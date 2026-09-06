'use strict';

const fs = require('fs');
const { spawn } = require('child_process');

const MAX_STDOUT_BUFFER = 128 * 1024 * 1024;

class ShopSffTransportClient {
  constructor({ executablePath }) {
    this.executablePath = String(executablePath || '');
    this.child = null;
    this.stdoutBuffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  ensureStarted() {
    if (this.closed) throw new Error('店铺查询兼容传输模块已关闭');
    if (this.child && !this.child.killed) return;
    if (!this.executablePath || !fs.existsSync(this.executablePath)) {
      throw new Error('店铺查询兼容传输模块不存在，请重新安装完整版本');
    }

    const child = spawn(this.executablePath, [], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;
    this.stdoutBuffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.handleStdout(chunk));
    child.stderr.on('data', () => {});
    child.on('error', error => this.handleProcessFailure(error));
    child.on('exit', () => this.handleProcessFailure(new Error('店铺查询兼容传输模块已退出')));
  }

  handleStdout(chunk) {
    this.stdoutBuffer += String(chunk || '');
    if (this.stdoutBuffer.length > MAX_STDOUT_BUFFER) {
      this.restartAfterFailure(new Error('店铺查询兼容传输响应过大'));
      return;
    }
    while (true) {
      const lineEnd = this.stdoutBuffer.indexOf('\n');
      if (lineEnd < 0) return;
      const line = this.stdoutBuffer.slice(0, lineEnd).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(lineEnd + 1);
      if (!line) continue;
      let response;
      try { response = JSON.parse(line); } catch (error) {
        this.restartAfterFailure(new Error('店铺查询兼容传输返回格式无效'));
        return;
      }
      const requestId = Number(response && response.id) || 0;
      const item = this.pending.get(requestId);
      if (!item) continue;
      clearTimeout(item.timer);
      this.pending.delete(requestId);
      if (!response.ok) {
        const error = new Error(String(response.message || '店铺查询兼容传输失败'));
        error.code = String(response.errorCode || 'transport_error');
        item.reject(error);
        continue;
      }
      item.resolve({
        status: Number(response.status) || 0,
        headers: { location: String(response.location || '') },
        body: String(response.body || '')
      });
    }
  }

  handleProcessFailure(error) {
    if (!this.child) return;
    this.child = null;
    this.stdoutBuffer = '';
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
  }

  restartAfterFailure(error) {
    const child = this.child;
    this.handleProcessFailure(error);
    if (child && !child.killed) child.kill();
  }

  request({ api, bodyText, h5st, dsmEid, userAgent, cookie, timeoutMs }) {
    this.ensureStarted();
    const requestId = this.nextId++;
    const normalizedTimeoutMs = Math.max(1000, Math.min(60000, Number(timeoutMs) || 30000));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.restartAfterFailure(new Error('店铺查询兼容传输超时'));
        reject(new Error('店铺接口请求超时'));
      }, normalizedTimeoutMs + 5000);
      this.pending.set(requestId, { resolve, reject, timer });
      const payload = JSON.stringify({
        id: requestId,
        api: String(api || ''),
        bodyText: String(bodyText || ''),
        h5st: String(h5st || ''),
        dsmEid: String(dsmEid || ''),
        userAgent: String(userAgent || ''),
        cookie: String(cookie || ''),
        timeoutMs: normalizedTimeoutMs
      });
      this.child.stdin.write(`${payload}\n`, 'utf8', error => {
        if (!error) return;
        const item = this.pending.get(requestId);
        if (!item) return;
        clearTimeout(item.timer);
        this.pending.delete(requestId);
        item.reject(new Error('店铺查询兼容传输写入失败'));
      });
    });
  }

  close() {
    this.closed = true;
    const child = this.child;
    this.handleProcessFailure(new Error('店铺查询兼容传输已关闭'));
    if (child && !child.killed) child.kill();
  }
}

module.exports = { ShopSffTransportClient };
