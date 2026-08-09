const assert = require('assert');
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const preloadSource = fs.readFileSync(path.join(rootDir, 'preload.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(rootDir, 'main.js'), 'utf8');

function collectMatches(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function unique(values) {
  return [...new Set(values)].sort();
}

const exposedMethods = collectMatches(
  preloadSource,
  /^\s{2}([A-Za-z_$][\w$]*):\s*/gm
);
const duplicateMethods = unique(
  exposedMethods.filter((name, index) => exposedMethods.indexOf(name) !== index)
);
assert.deepStrictEqual(duplicateMethods, [], `preload.js 存在重复接口: ${duplicateMethods.join(', ')}`);

const rendererSources = [
  fs.readFileSync(path.join(rootDir, 'src', 'js', 'renderer.js'), 'utf8'),
  ...fs.readdirSync(path.join(rootDir, 'src'))
    .filter((name) => name.endsWith('.html'))
    .map((name) => fs.readFileSync(path.join(rootDir, 'src', name), 'utf8'))
];
const usedMethods = unique(rendererSources.flatMap((source) =>
  collectMatches(source, /window\.electronAPI\.([A-Za-z_$][\w$]*)/g)
));
const missingMethods = usedMethods.filter((name) => !exposedMethods.includes(name));
assert.deepStrictEqual(
  missingMethods,
  [],
  `渲染层调用了 preload.js 未暴露的接口: ${missingMethods.join(', ')}`
);

const invokedChannels = unique(collectMatches(
  preloadSource,
  /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g
));
const handledChannels = unique(collectMatches(
  mainSource,
  /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g
));
const missingHandlers = invokedChannels.filter((channel) => !handledChannels.includes(channel));
assert.deepStrictEqual(
  missingHandlers,
  [],
  `preload.js 调用了 main.js 未注册的 IPC handle: ${missingHandlers.join(', ')}`
);

const sentChannels = unique(collectMatches(
  preloadSource,
  /ipcRenderer\.send\(\s*['"]([^'"]+)['"]/g
));
const receivedChannels = unique(collectMatches(
  mainSource,
  /ipcMain\.on\(\s*['"]([^'"]+)['"]/g
));
const missingListeners = sentChannels.filter((channel) => !receivedChannels.includes(channel));
assert.deepStrictEqual(
  missingListeners,
  [],
  `preload.js 发送了 main.js 未监听的 IPC channel: ${missingListeners.join(', ')}`
);

console.log(`IPC 契约测试通过：${usedMethods.length} 个渲染接口，${invokedChannels.length} 个 invoke 通道，${sentChannels.length} 个 send 通道`);
