/**
 * Storage — SQLite 单例 + DataRoot 抽象
 *
 * 使用 Node 22+ 内置 node:sqlite (零原生依赖, 无需 node-gyp/VS 工具链).
 * 退出时 closeStorage() 释放.
 *
 * DataRoot 解析顺序:
 * 1. POLARIS_SKY_DATA_ROOT env
 * 2. %APPDATA%/Polaris-sky (Win) / ~/.local/share/Polaris-sky (Linux) / ~/Library/Application Support/Polaris-sky (Mac)
 * 3. ./data (fallback)
 *
 * 表: kv(domain, key, value, updated_at) — 给 cap.kv 用
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

// ============================================================================
// DataRoot
// ============================================================================

function resolveDataRoot(): string {
  const envRoot = process.env.POLARIS_SKY_DATA_ROOT;
  if (envRoot) return envRoot;

  const plat = platform();
  let base: string;
  if (plat === 'win32') {
    base = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(base, 'Polaris-sky');
  }
  if (plat === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Polaris-sky');
  }
  // linux
  base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'Polaris-sky');
}

export const dataRoot: string = resolveDataRoot();
mkdirSync(dataRoot, { recursive: true });
mkdirSync(join(dataRoot, 'history'), { recursive: true });

// ============================================================================
// SQLite 单例 (node:sqlite)
// ============================================================================

const dbPath = join(dataRoot, 'sky.db');
const _db = new DatabaseSync(dbPath);
_db.exec('PRAGMA journal_mode = WAL;');
_db.exec('PRAGMA synchronous = NORMAL;');

_db.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    domain TEXT NOT NULL,
    key    TEXT NOT NULL,
    value  TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(domain, key)
  );
`);
_db.exec('CREATE INDEX IF NOT EXISTS idx_kv_domain ON kv(domain);');

export const db = _db;

export function closeStorage(): void {
  try { _db.close(); } catch { /* ignore */ }
}
