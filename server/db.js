'use strict';

/**
 * server/db.js — SQLite 持久化。
 * 容器首次启动时若数据库文件不存在，会自动执行下面的建表语句，
 * 无需手工迁移。
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

let db;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  tolerance_mm REAL NOT NULL DEFAULT 2.0,           -- 环闭合位置容差（毫米）
  version      INTEGER NOT NULL DEFAULT 1,         -- 乐观锁版本，每次变更 +1
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shards (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  image_path   TEXT NOT NULL,                       -- /uploads 下的相对路径
  image_width  INTEGER NOT NULL,                    -- 照片像素宽
  image_height INTEGER NOT NULL,                    -- 照片像素高
  scale_px     REAL NOT NULL,                       -- 比例尺线段像素长度
  scale_mm     REAL NOT NULL,                       -- 比例尺代表的真实毫米数
  mm_per_px    REAL NOT NULL,                       -- = scale_mm / scale_px
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shards_project ON shards(project_id);

-- 接缝：to 片局部点 = R(rotation) * from 片局部点 + (tx_mm, ty_mm)
-- status: proposed（仅记录，未参与拼合）/ adopted（已采纳，决定布局）
CREATE TABLE IF NOT EXISTS seams (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_shard_id   INTEGER NOT NULL REFERENCES shards(id) ON DELETE CASCADE,
  to_shard_id     INTEGER NOT NULL REFERENCES shards(id) ON DELETE CASCADE,
  rotation        REAL NOT NULL,                    -- 度，逆时针为正
  tx_mm           REAL NOT NULL,
  ty_mm           REAL NOT NULL,
  seam_note       TEXT NOT NULL DEFAULT '',         -- 接缝说明
  status          TEXT NOT NULL DEFAULT 'adopted'
                    CHECK (status IN ('proposed', 'adopted', 'rejected')),
  -- 被环校验拒绝时记录冲突链与闭合差，便于界面指出冲突
  reject_reason   TEXT NOT NULL DEFAULT '',
  reject_chain    TEXT NOT NULL DEFAULT '',         -- JSON: 冲突接缝 id 链
  reject_misclosure_mm REAL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_seams_project ON seams(project_id);
CREATE INDEX IF NOT EXISTS idx_seams_from ON seams(from_shard_id);
CREATE INDEX IF NOT EXISTS idx_seams_to ON seams(to_shard_id);
`;

function init(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(path.join(path.dirname(dbPath), 'uploads'), { recursive: true });

  db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

function get() {
  if (!db) throw new Error('数据库尚未初始化');
  return db;
}

/** 在一个事务里执行 fn；乐观锁版本不符时回滚并抛出 409 */
function tx(fn) {
  return get().transaction(fn)();
}

module.exports = { init, get, tx };
