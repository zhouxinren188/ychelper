const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function syncParentDirectory(targetPath, fsImpl = fs) {
  let directoryHandle = null;
  try {
    directoryHandle = fsImpl.openSync(path.dirname(targetPath), 'r');
    fsImpl.fsyncSync(directoryHandle);
  } catch (_) {
    // Windows may reject opening or flushing a directory handle. The file itself
    // has already been flushed, so directory flushing is best-effort only.
  } finally {
    if (directoryHandle !== null) {
      try { fsImpl.closeSync(directoryHandle); } catch (_) {}
    }
  }
}

function syncWrittenFile(targetPath, fsImpl = fs) {
  let fileHandle = null;
  try {
    fileHandle = fsImpl.openSync(targetPath, 'r+');
    fsImpl.fsyncSync(fileHandle);
  } finally {
    if (fileHandle !== null) {
      try { fsImpl.closeSync(fileHandle); } catch (_) {}
    }
  }
}

function writeFileDurably(targetPath, raw, { suffix = 'write', fsImpl = fs } = {}) {
  const token = crypto.randomBytes(6).toString('hex');
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.${token}.${suffix}.tmp`;
  let fileHandle = null;
  try {
    fileHandle = fsImpl.openSync(tempPath, 'w');
    fsImpl.writeFileSync(fileHandle, raw, 'utf8');
    fsImpl.fsyncSync(fileHandle);
    fsImpl.closeSync(fileHandle);
    fileHandle = null;
    fsImpl.renameSync(tempPath, targetPath);
    syncWrittenFile(targetPath, fsImpl);
    syncParentDirectory(targetPath, fsImpl);
  } finally {
    if (fileHandle !== null) {
      try { fsImpl.closeSync(fileHandle); } catch (_) {}
    }
    if (fsImpl.existsSync(tempPath)) {
      try { fsImpl.unlinkSync(tempPath); } catch (_) {}
    }
  }
}

function saveRecoveryGenerations({ latestPath, previousPath, raw, validateRaw, fsImpl = fs }) {
  if (fsImpl.existsSync(latestPath)) {
    try {
      const latestRaw = fsImpl.readFileSync(latestPath, 'utf8');
      if (latestRaw === raw) return;
      if (!validateRaw || validateRaw(latestRaw)) {
        writeFileDurably(previousPath, latestRaw, { suffix: 'previous', fsImpl });
      }
    } catch (_) {
      // A broken latest snapshot must never replace the older valid generation.
    }
  }
  writeFileDurably(latestPath, raw, { suffix: 'latest', fsImpl });
}

module.exports = {
  saveRecoveryGenerations,
  writeFileDurably
};
