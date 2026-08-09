/**
 * Cookie 存储管理模块（主进程）
 * 为商家端、仓库端、店铺账号提供独立的 cookie 文件存储与恢复功能
 */

const { app, session, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

// Cookie 文件存储目录
const COOKIE_DIR = path.join(app.getPath('userData'), 'cookies');
const ENCRYPTED_COOKIE_PREFIX = 'YCH-COOKIE-ENC-V1:';

function encodeCookieData(data) {
  const json = JSON.stringify(data);
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('Cookie 加密不可用，暂以明文保存');
    return JSON.stringify(data, null, 2);
  }
  return ENCRYPTED_COOKIE_PREFIX + safeStorage.encryptString(json).toString('base64');
}

function decodeCookieData(raw, filePath) {
  if (raw.startsWith(ENCRYPTED_COOKIE_PREFIX)) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统安全存储当前不可用，无法解密 Cookie');
    }
    const encrypted = Buffer.from(raw.slice(ENCRYPTED_COOKIE_PREFIX.length), 'base64');
    return JSON.parse(safeStorage.decryptString(encrypted));
  }

  const data = JSON.parse(raw);
  if (safeStorage.isEncryptionAvailable() && filePath) {
    fs.writeFileSync(filePath, encodeCookieData(data), 'utf-8');
    console.log(`Cookie 文件已迁移为加密格式: ${path.basename(filePath)}`);
  }
  return data;
}

// 各账号类型对应的 domain 列表
const DOMAIN_MAP = {
  merchant: ['.jdl.com', '.jd.com'],
  wms: ['.jdl.com', '.jd.com'],
  shop: ['.jd.com']
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateAccountIdentity(type, id) {
  if (!Object.prototype.hasOwnProperty.call(DOMAIN_MAP, type)) {
    throw new Error('无效的账号类型');
  }
  if (!UUID_PATTERN.test(String(id || ''))) {
    throw new Error('无效的账号 ID');
  }
}

/**
 * 确保 cookie 存储目录存在
 */
function ensureCookieDir() {
  if (!fs.existsSync(COOKIE_DIR)) {
    fs.mkdirSync(COOKIE_DIR, { recursive: true });
    console.log('Cookie 存储目录已创建:', COOKIE_DIR);
  }
}

/**
 * 启动时迁移所有历史明文 Cookie 文件，避免只有当前使用的账号被延迟迁移。
 * 无法解析或命名不符合规范的文件保持原样，防止误覆盖用户数据。
 */
function migrateLegacyCookieFiles() {
  ensureCookieDir();
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('Cookie 加密不可用，跳过历史文件迁移');
    return { migrated: 0, skipped: 0, failed: 0 };
  }

  const validFilename = /^(merchant|wms|shop)-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i;
  const result = { migrated: 0, skipped: 0, failed: 0 };

  for (const filename of fs.readdirSync(COOKIE_DIR)) {
    if (!validFilename.test(filename)) {
      result.skipped++;
      continue;
    }

    const filePath = path.join(COOKIE_DIR, filename);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      if (raw.startsWith(ENCRYPTED_COOKIE_PREFIX)) {
        result.skipped++;
        continue;
      }

      const data = JSON.parse(raw);
      const tempPath = `${filePath}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tempPath, encodeCookieData(data), 'utf-8');
        fs.renameSync(tempPath, filePath);
      } finally {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      }
      result.migrated++;
    } catch (err) {
      result.failed++;
      console.error(`Cookie 历史文件迁移失败 [${filename}]:`, err.message);
    }
  }

  console.log(`Cookie 历史文件迁移完成: 已迁移 ${result.migrated}, 已跳过 ${result.skipped}, 失败 ${result.failed}`);
  return result;
}

/**
 * 获取 cookie 文件路径
 * @param {string} type - 账号类型: merchant / wms / shop
 * @param {string} id - 本地账号 UUID（不是服务端商家 ID）
 * @returns {string}
 */
function getCookieFilePath(type, id) {
  validateAccountIdentity(type, id);
  return path.join(COOKIE_DIR, `${type}-${id}.json`);
}

/**
 * 获取指定账号的 Electron session 分区名
 * @param {string} type - 账号类型
 * @param {string} id - 本地账号 UUID（不是服务端商家 ID）
 * @returns {string}
 */
function getPartitionName(type, id) {
  validateAccountIdentity(type, id);
  return `persist:${type}-${id}`;
}

/**
 * 从 Electron session 导出 cookie 到文件
 * @param {Electron.Session} ses - Electron session 实例
 * @param {string} type - 账号类型
 * @param {string} id - 账号 UUID
 * @returns {Promise<boolean>}
 */
async function exportCookies(ses, type, id) {
  try {
    ensureCookieDir();
    // 导出 session 中所有 cookie（不限域名，确保不遗漏关键 auth cookie）
    let allCookies = await ses.cookies.get({});

    // 去重（同 name+domain+path 只保留一条）
    const seen = new Set();
    const uniqueCookies = [];
    for (const c of allCookies) {
      const key = `${c.name}|${c.domain}|${c.path}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueCookies.push({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          expirationDate: c.expirationDate || undefined,
          httpOnly: !!c.httpOnly,
          secure: !!c.secure,
          sameSite: c.sameSite || 'unspecified'
        });
      }
    }

    if (uniqueCookies.length === 0) {
      console.log(`Cookie 导出: ${type}-${id} 无 cookie 可导出`);
      return false;
    }

    const data = {
      accountId: id,
      type: type,
      exportedAt: Date.now(),
      cookies: uniqueCookies
    };

    const filePath = getCookieFilePath(type, id);
    fs.writeFileSync(filePath, encodeCookieData(data), 'utf-8');
    console.log(`Cookie 导出: ${type}-${id} 共 ${uniqueCookies.length} 条 cookie 已保存`);
    return true;
  } catch (err) {
    console.error(`Cookie 导出失败 [${type}-${id}]:`, err.message);
    return false;
  }
}

/**
 * 从文件导入 cookie 到 Electron session（先清空目标 session 的 cookie）
 * @param {Electron.Session} ses - Electron session 实例
 * @param {string} type - 账号类型
 * @param {string} id - 账号 UUID
 * @returns {Promise<boolean>}
 */
async function importCookies(ses, type, id) {
  try {
    const filePath = getCookieFilePath(type, id);
    if (!fs.existsSync(filePath)) {
      console.log(`Cookie 导入: ${type}-${id} 文件不存在`);
      return false;
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = decodeCookieData(raw, filePath);

    if (!data.cookies || !Array.isArray(data.cookies) || data.cookies.length === 0) {
      console.log(`Cookie 导入: ${type}-${id} 文件中无 cookie 数据`);
      return false;
    }

    // 清空目标 session 的 cookie
    await ses.clearStorageData({ storages: ['cookies'] });

    let importCount = 0;
    for (const c of data.cookies) {
      try {
        // sameSite='no_restriction' 要求 secure=true（Chrome 80+ 策略）
        let sameSite = c.sameSite || 'unspecified';
        if (sameSite === 'no_restriction' && !c.secure) {
          sameSite = 'lax';
        }
        const cookieDetails = {
          url: `http${c.secure ? 's' : ''}://${c.domain.replace(/^\./, '')}${c.path || '/'}`,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          httpOnly: !!c.httpOnly,
          secure: !!c.secure,
          sameSite: sameSite
        };
        if (c.expirationDate) {
          cookieDetails.expirationDate = c.expirationDate;
        }
        await ses.cookies.set(cookieDetails);
        importCount++;
      } catch (e) {
        // 单条 cookie 导入失败不影响整体
        console.log(`Cookie 导入: 跳过 ${c.name}@${c.domain}: ${e.message}`);
      }
    }

    console.log(`Cookie 导入: ${type}-${id} 共导入 ${importCount}/${data.cookies.length} 条 cookie`);
    return importCount > 0;
  } catch (err) {
    console.error(`Cookie 导入失败 [${type}-${id}]:`, err.message);
    return false;
  }
}

/**
 * 检查 cookie 文件是否存在且包含有效数据
 * @param {string} type - 账号类型
 * @param {string} id - 账号 UUID
 * @returns {boolean}
 */
function validateCookieFile(type, id) {
  try {
    const filePath = getCookieFilePath(type, id);
    if (!fs.existsSync(filePath)) return false;

    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = decodeCookieData(raw, filePath);

    if (!data.cookies || !Array.isArray(data.cookies) || data.cookies.length === 0) {
      return false;
    }

    // 检查是否有至少一条未过期的 cookie
    const now = Date.now() / 1000; // cookie expirationDate 是秒级时间戳
    const hasValid = data.cookies.some(c => {
      if (!c.expirationDate) return true; // session cookie 视为有效
      return c.expirationDate > now;
    });

    return hasValid;
  } catch (err) {
    return false;
  }
}

/**
 * 删除 cookie 文件
 * @param {string} type - 账号类型
 * @param {string} id - 账号 UUID
 * @returns {boolean}
 */
function deleteCookieFile(type, id) {
  try {
    const filePath = getCookieFilePath(type, id);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`Cookie 文件已删除: ${type}-${id}`);
    }
    return true;
  } catch (err) {
    console.error(`Cookie 文件删除失败 [${type}-${id}]:`, err.message);
    return false;
  }
}

/**
 * 清除指定分区的 session 数据（cookie + storage）
 * @param {string} partitionName - 分区名 (e.g. 'persist:shop-xxx')
 */
async function clearPartition(partitionName) {
  try {
    const ses = session.fromPartition(partitionName);
    await ses.clearStorageData();
    console.log(`Session 分区已清除: ${partitionName}`);
  } catch (err) {
    console.error(`Session 分区清除失败 [${partitionName}]:`, err.message);
  }
}

module.exports = {
  ensureCookieDir,
  migrateLegacyCookieFiles,
  getCookieFilePath,
  getPartitionName,
  exportCookies,
  importCookies,
  validateCookieFile,
  deleteCookieFile,
  clearPartition,
  COOKIE_DIR,
  DOMAIN_MAP
};
