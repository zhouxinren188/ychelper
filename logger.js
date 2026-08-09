'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const logDir = path.join(app.getPath('userData'), 'logs');
const MAX_LOG_SIZE = 10 * 1024 * 1024;
const MAX_LOG_DAYS = 7;
const streams = new Map();

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

function getDateString(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function getTimestamp(date = new Date()) {
  return `${getDateString(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function safeTerminal(method, ...args) {
  try {
    originalConsole[method](...args);
  } catch (err) {
    if (err?.code !== 'EPIPE') {
      try { originalConsole.error('[Logger] 原终端输出失败:', err?.message || String(err)); } catch (_) {}
    }
  }
}

function formatValue(value) {
  if (value instanceof Error) {
    return `${value.message || value.name || 'Error'}${value.stack ? `\n${value.stack}` : ''}`;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch (_) {
      try { return String(value); } catch (_) { return '[无法格式化的对象]'; }
    }
  }
  try { return String(value); } catch (_) { return '[无法格式化的值]'; }
}

function formatArgs(args) {
  return args.map(formatValue).join(' ');
}

function maskSecret(value) {
  const text = String(value || '');
  if (!text) return '***';
  return `${text.slice(0, Math.min(6, text.length))}***`;
}

function sanitize(input) {
  let text = String(input == null ? '' : input);
  const keyNames = 'cookie|cookies|token|access[_-]?token|refresh[_-]?token|pt_key|authorization|jwt|password|passwd|pwd|用户密码|密码|口令';

  // 完整请求头可能包含空格或分号，先整体处理。
  text = text.replace(/\b(set-cookie|cookie|authorization)\s*:\s*([^\r\n]+)/gi,
    (match, key, value) => `${key}: ${maskSecret(value.trim())}`);
  text = text.replace(/\b(cookie|cookies)\s*=\s*([^\r\n]+)/gi,
    (match, key, value) => `${key}=${maskSecret(value.trim())}`);

  // JSON/对象字符串中的敏感字段。
  const quotedPattern = new RegExp(`((?:["']?)(?:${keyNames})(?:["']?)\\s*[:=]\\s*["'])([^"']*)(["'])`, 'gi');
  text = text.replace(quotedPattern, (match, prefix, value, suffix) => `${prefix}${maskSecret(value)}${suffix}`);

  // 查询参数、表单字段以及未加引号的键值。
  const plainPattern = new RegExp(`(\\b(?:${keyNames})\\b\\s*[:=]\\s*)(?!["'])([^\\s,;}&\\]]+)`, 'gi');
  text = text.replace(plainPattern, (match, prefix, value) => `${prefix}${maskSecret(value)}`);
  text = text.replace(/((?:用户密码|密码|口令)\s*[:=]\s*["']?)([^\s,"';}&\]]+)/g,
    (match, prefix, value) => `${prefix}${maskSecret(value)}`);

  text = text.replace(/(pt_key=)([^\s;'"&]+)/gi, (match, prefix, value) => `${prefix}${maskSecret(value)}`);
  text = text.replace(/(\bBearer\s+)([A-Za-z0-9._~+\/-]+)/gi, (match, prefix, value) => `${prefix}${maskSecret(value)}`);
  text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    value => maskSecret(value));
  return text;
}

function ensureLogDirectory() {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    return true;
  } catch (err) {
    safeTerminal('error', '[Logger] 无法创建日志目录:', err?.message || String(err));
    return false;
  }
}

function rotateExistingFile(logPath) {
  try {
    if (!fs.existsSync(logPath)) return;
    const rotatedPath = logPath.replace(/\.log$/i, '.1.log');
    if (fs.existsSync(rotatedPath)) fs.unlinkSync(rotatedPath);
    fs.renameSync(logPath, rotatedPath);
  } catch (err) {
    safeTerminal('error', '[Logger] 日志轮转失败:', err?.message || String(err));
  }
}

function closeOldDateStreams(currentDate) {
  for (const [key, state] of streams.entries()) {
    if (state.date === currentDate) continue;
    streams.delete(key);
    try { state.stream.end(); } catch (_) {}
  }
}

function createStream(name, date) {
  if (!ensureLogDirectory()) return null;
  closeOldDateStreams(date);
  const filename = `${name}-${date}.log`;
  const logPath = path.join(logDir, filename);

  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size >= MAX_LOG_SIZE) {
      rotateExistingFile(logPath);
    }
    const size = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
    const stream = fs.createWriteStream(logPath, { flags: 'a' });
    const state = { name, date, filename, logPath, stream, size, rotating: false, queue: [], broken: false };
    stream.on('error', (err) => {
      state.broken = true;
      safeTerminal('error', `[Logger] 写入 ${filename} 失败:`, err?.message || String(err));
    });
    streams.set(filename, state);
    return state;
  } catch (err) {
    safeTerminal('error', `[Logger] 打开 ${filename} 失败:`, err?.message || String(err));
    return null;
  }
}

function getStreamState(name) {
  const date = getDateString();
  const filename = `${name}-${date}.log`;
  const existing = streams.get(filename);
  if (existing && !existing.broken) return existing;
  if (existing) streams.delete(filename);
  return createStream(name, date);
}

function writePreparedLine(name, line) {
  const state = getStreamState(name);
  if (!state || state.broken) return;
  const bytes = Buffer.byteLength(line, 'utf8');

  if (state.rotating) {
    state.queue.push(line);
    return;
  }

  if (state.size > 0 && state.size + bytes > MAX_LOG_SIZE) {
    state.rotating = true;
    state.queue.push(line);
    try {
      state.stream.once('close', () => {
        const queued = state.queue.splice(0);
        streams.delete(state.filename);
        rotateExistingFile(state.logPath);
        for (const queuedLine of queued) writePreparedLine(name, queuedLine);
      });
      state.stream.end();
    } catch (err) {
      state.rotating = false;
      state.broken = true;
      safeTerminal('error', '[Logger] 关闭日志流失败:', err?.message || String(err));
    }
    return;
  }

  try {
    state.stream.write(line);
    state.size += bytes;
  } catch (err) {
    state.broken = true;
    safeTerminal('error', `[Logger] 写入 ${state.filename} 失败:`, err?.message || String(err));
  }
}

function writeLog(name, level, source, message) {
  try {
    const safeLevel = String(level || 'INFO').toUpperCase();
    const safeSource = sanitize(source || 'main').replace(/[\r\n]+/g, ' ');
    const safeMessage = sanitize(message);
    writePreparedLine(name, `[${getTimestamp()}] [${safeLevel}] [${safeSource}] ${safeMessage}\n`);
  } catch (_) {
    // 日志系统自身的错误绝不能影响主程序。
  }
}

function cleanupOldLogs() {
  if (!ensureLogDirectory()) return;
  const cutoff = Date.now() - MAX_LOG_DAYS * 24 * 60 * 60 * 1000;
  try {
    for (const filename of fs.readdirSync(logDir)) {
      if (!/^(?:main|renderer|error|scrape)-\d{4}-\d{2}-\d{2}(?:\.1)?\.log$/i.test(filename)) continue;
      const filePath = path.join(logDir, filename);
      try {
        if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
      } catch (_) {}
    }
  } catch (_) {}
}

function overrideConsole() {
  console.log = (...args) => {
    safeTerminal('log', ...args);
    writeLog('main', 'INFO', 'main', formatArgs(args));
  };
  console.info = (...args) => {
    safeTerminal('info', ...args);
    writeLog('main', 'INFO', 'main', formatArgs(args));
  };
  console.warn = (...args) => {
    safeTerminal('warn', ...args);
    writeLog('main', 'WARN', 'main', formatArgs(args));
  };
  console.error = (...args) => {
    safeTerminal('error', ...args);
    writeLog('error', 'ERROR', 'main', formatArgs(args));
  };
}

function setupProcessErrorCapture() {
  process.stdout?.on('error', err => {
    if (err?.code !== 'EPIPE') writeLog('error', 'ERROR', 'main', `stdout error: ${formatValue(err)}`);
  });
  process.stderr?.on('error', err => {
    if (err?.code !== 'EPIPE') writeLog('error', 'ERROR', 'main', `stderr error: ${formatValue(err)}`);
  });
  process.on('uncaughtException', err => {
    if (err?.code === 'EPIPE') return;
    const message = `uncaughtException: ${formatValue(err)}`;
    writeLog('error', 'ERROR', 'main', message);
    safeTerminal('error', message);
  });
  process.on('unhandledRejection', reason => {
    const message = `unhandledRejection: ${formatValue(reason)}`;
    writeLog('error', 'ERROR', 'main', message);
    safeTerminal('error', message);
  });
}

function rendererSource(contents, sourceId) {
  const fallback = contents?.getType ? contents.getType() : 'unknown';
  if (!sourceId) return `renderer:${fallback}`;
  try {
    const parsed = new URL(sourceId);
    const file = path.basename(parsed.pathname) || parsed.hostname;
    return `renderer:${file || fallback}`;
  } catch (_) {
    return `renderer:${path.basename(String(sourceId)) || fallback}`;
  }
}

function setupRendererLogCapture() {
  app.on('web-contents-created', (event, contents) => {
    contents.on('console-message', (details, ...legacyArgs) => {
      const [legacyLevel, legacyMessage, legacyLine, legacySourceId] = legacyArgs;
      const usesCurrentSignature = details && typeof details.message === 'string' && typeof details.level === 'string';
      const message = usesCurrentSignature ? details.message : legacyMessage;
      const levelValue = usesCurrentSignature ? details.level : legacyLevel;
      const sourceId = usesCurrentSignature ? details.sourceId : legacySourceId;
      const lineNumber = usesCurrentSignature ? details.lineNumber : legacyLine;
      const numericLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
      const textLevels = { debug: 'DEBUG', info: 'INFO', warning: 'WARN', error: 'ERROR' };
      const level = typeof levelValue === 'number'
        ? (numericLevels[levelValue] || 'INFO')
        : (textLevels[String(levelValue || '').toLowerCase()] || 'INFO');
      const source = rendererSource(contents, sourceId);
      const suffix = Number.isFinite(Number(lineNumber)) ? ` (line ${lineNumber})` : '';
      if (level === 'ERROR') {
        writeLog('error', 'ERROR', source, `${message || ''}${suffix}`);
      } else {
        writeLog('renderer', level, source, `${message || ''}${suffix}`);
      }
    });

    contents.on('render-process-gone', (event, details) => {
      writeLog('error', 'ERROR', `renderer:${contents.getType?.() || 'unknown'}`,
        `render-process-gone: ${formatValue(details)}`);
    });
  });
}

const logger = {
  log(level, message, source = 'main') {
    const normalizedLevel = String(level || 'INFO').toUpperCase();
    const target = normalizedLevel === 'ERROR' ? 'error' : 'main';
    writeLog(target, normalizedLevel, source, formatValue(message));
  },
  error(message, error) {
    const details = error === undefined ? formatValue(message) : `${formatValue(message)}: ${formatValue(error)}`;
    writeLog('error', 'ERROR', 'main', details);
  },
  scrape(message) {
    writeLog('scrape', 'INFO', 'scrape', formatValue(message));
  },
  logDir
};

ensureLogDirectory();
overrideConsole();
setupProcessErrorCapture();
setupRendererLogCapture();
cleanupOldLogs();
const cleanupTimer = setInterval(cleanupOldLogs, 6 * 60 * 60 * 1000);
cleanupTimer.unref?.();

console.log(`[Logger] 日志目录: ${logDir}`);

module.exports = logger;
