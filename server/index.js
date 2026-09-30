'use strict';

/**
 * server/index.js — Express 入口
 *
 * 启动时自动建表；提供方案 / 陶片 / 接缝 REST API。
 * 所有写操作必须携带 X-Expected-Version（当前方案版本），
 * 版本不符返回 409，绝不静默覆盖他人修改。
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');

const dbm = require('./db');
const Geometry = require('../shared/geometry');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'workbench.db');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '20', 10);

dbm.init(DB_PATH);

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---- 静态资源：前端页面、共享几何库、上传的照片 ----
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/', (_req, res) => res.redirect('/index.html'));

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function num(v, field, { finite = true } = {}) {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || Number.isNaN(n) ||
      (finite && !Number.isFinite(n))) {
    throw new HttpError(400, 'BAD_REQUEST', `字段 ${field} 必须是数字`);
  }
  return n;
}

function str(v, fallback = '') {
  return v == null ? fallback : String(v);
}

function getProjectOr404(id) {
  const p = dbm.get().prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!p) throw new HttpError(404, 'NOT_FOUND', '方案不存在');
  return p;
}

/** 乐观锁校验：写请求必须声明它基于哪个版本 */
function checkVersion(project, expectedRaw) {
  const expected = parseInt(expectedRaw, 10);
  if (!Number.isInteger(expected)) {
    throw new HttpError(400, 'VERSION_REQUIRED',
      '写操作必须通过 X-Expected-Version 头携带当前方案版本');
  }
  if (expected !== project.version) {
    throw new HttpError(409, 'VERSION_CONFLICT',
      `版本冲突：你基于 v${expected}，当前已为 v${project.version}，请刷新后重试`,
      { expected, current: project.version });
  }
}

/** 变更落库后推进版本，返回新版本号 */
function bumpVersion(projectId) {
  dbm.get().prepare(
    `UPDATE projects SET version = version + 1,
       updated_at = datetime('now') WHERE id = ?`
  ).run(projectId);
  return dbm.get().prepare('SELECT version FROM projects WHERE id = ?')
    .get(projectId).version;
}

// ---------------- 方案 ----------------

app.get('/api/projects', (_req, res) => {
  const rows = dbm.get().prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM shards s WHERE s.project_id = p.id) AS shard_count,
      (SELECT COUNT(*) FROM seams m WHERE m.project_id = p.id
         AND m.status = 'adopted') AS adopted_seam_count
    FROM projects p ORDER BY p.updated_at DESC, p.id DESC
  `).all();
  res.json(rows);
});

app.post('/api/projects', (req, res) => {
  const name = str(req.body && req.body.name).trim();
  if (!name) throw new HttpError(400, 'BAD_REQUEST', '方案名称不能为空');
  const tolerance = num(req.body && req.body.tolerance_mm != null
    ? req.body.tolerance_mm : 2, 'tolerance_mm');
  if (tolerance <= 0) throw new HttpError(400, 'BAD_REQUEST', '容差必须为正数');
  const description = str(req.body && req.body.description);

  const info = dbm.get().prepare(
    `INSERT INTO projects (name, description, tolerance_mm)
     VALUES (?, ?, ?)`
  ).run(name, description, tolerance);
  res.status(201).json(getProjectOr404(info.lastInsertRowid));
});

function loadProjectDetail(id) {
  const project = getProjectOr404(id);
  const shards = dbm.get().prepare(
    'SELECT * FROM shards WHERE project_id = ? ORDER BY id').all(id);
  const seams = dbm.get().prepare(
    'SELECT * FROM seams WHERE project_id = ? ORDER BY id DESC').all(id)
    .map((m) => ({
      ...m,
      reject_chain: m.reject_chain ? JSON.parse(m.reject_chain) : []
    }));
  return { ...project, shards, seams };
}

app.get('/api/projects/:id', (req, res) => {
  res.json(loadProjectDetail(req.params.id));
});

app.patch('/api/projects/:id', (req, res) => {
  const project = getProjectOr404(req.params.id);
  checkVersion(project, req.get('X-Expected-Version'));

  const fields = [];
  const vals = [];
  const b = req.body || {};
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) throw new HttpError(400, 'BAD_REQUEST', '方案名称不能为空');
    fields.push('name = ?'); vals.push(name);
  }
  if (b.description !== undefined) {
    fields.push('description = ?'); vals.push(String(b.description));
  }
  if (b.tolerance_mm !== undefined) {
    const t = num(b.tolerance_mm, 'tolerance_mm');
    if (t <= 0) throw new HttpError(400, 'BAD_REQUEST', '容差必须为正数');
    fields.push('tolerance_mm = ?'); vals.push(t);
  }
  if (!fields.length) throw new HttpError(400, 'BAD_REQUEST', '没有可更新字段');

  dbm.tx(() => {
    dbm.get().prepare(
      `UPDATE projects SET ${fields.join(', ')} WHERE id = ?`)
      .run(...vals, project.id);
    bumpVersion(project.id);
  });
  res.json(loadProjectDetail(project.id));
});

app.delete('/api/projects/:id', (req, res) => {
  const project = getProjectOr404(req.params.id);
  checkVersion(project, req.get('X-Expected-Version'));
  const shards = dbm.get().prepare(
    'SELECT image_path FROM shards WHERE project_id = ?').all(project.id);

  dbm.tx(() => {
    dbm.get().prepare('DELETE FROM projects WHERE id = ?').run(project.id);
  });
  // 数据库行删除后再清理磁盘文件；删文件失败不影响结果
  shards.forEach((s) => {
    const fp = path.join(UPLOAD_DIR, path.basename(s.image_path));
    fs.rm(fp, { force: true }, () => {});
  });
  res.status(204).end();
});

// ---------------- 陶片 ----------------

const allowedMime = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif'
};

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ext = allowedMime[file.mimetype] || '';
      cb(null, `shard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    }
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (allowedMime[file.mimetype]) return cb(null, true);
    cb(new HttpError(400, 'BAD_REQUEST',
      '仅支持 PNG / JPEG / WebP / GIF 图片'));
  }
});

app.post('/api/projects/:id/shards', upload.single('image'), (req, res) => {
  const project = getProjectOr404(req.params.id);
  try {
    checkVersion(project, req.get('X-Expected-Version')
      || (req.body && req.body.expectedVersion));

    if (!req.file) throw new HttpError(400, 'BAD_REQUEST', '缺少照片文件（字段名 image）');
    const name = str(req.body.name).trim();
    if (!name) throw new HttpError(400, 'BAD_REQUEST', '陶片名称不能为空');

    const width = num(req.body.image_width, 'image_width');
    const height = num(req.body.image_height, 'image_height');
    const scalePx = num(req.body.scale_px, 'scale_px');
    const scaleMm = num(req.body.scale_mm, 'scale_mm');
    if (width <= 0 || height <= 0) {
      throw new HttpError(400, 'BAD_REQUEST', '照片宽高必须为正数');
    }
    if (scalePx <= 0 || scaleMm <= 0) {
      throw new HttpError(400, 'BAD_REQUEST', '比例尺长度必须为正数');
    }

    const note = str(req.body.note);
    const mmPerPx = scaleMm / scalePx;

    let newId;
    dbm.tx(() => {
      const info = dbm.get().prepare(
        `INSERT INTO shards
           (project_id, name, image_path, image_width, image_height,
            scale_px, scale_mm, mm_per_px, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(project.id, name, `/uploads/${path.basename(req.file.path)}`,
        Math.round(width), Math.round(height),
        scalePx, scaleMm, mmPerPx, note);
      newId = info.lastInsertRowid;
      bumpVersion(project.id);
    });
    res.status(201).json(loadProjectDetail(project.id));
  } catch (err) {
    // 校验失败时清掉已落盘的上传文件
    if (req.file) fs.rm(req.file.path, { force: true }, () => {});
    throw err;
  }
});

app.delete('/api/shards/:id', (req, res) => {
  const shard = dbm.get().prepare('SELECT * FROM shards WHERE id = ?')
    .get(req.params.id);
  if (!shard) throw new HttpError(404, 'NOT_FOUND', '陶片不存在');
  const project = getProjectOr404(shard.project_id);
  checkVersion(project, req.get('X-Expected-Version'));

  dbm.tx(() => {
    // 关联接缝由外键 ON DELETE CASCADE 一并删除
    dbm.get().prepare('DELETE FROM shards WHERE id = ?').run(shard.id);
    bumpVersion(project.id);
  });
  fs.rm(path.join(UPLOAD_DIR, path.basename(shard.image_path)),
    { force: true }, () => {});
  res.json(loadProjectDetail(project.id));
});

// ---------------- 接缝 ----------------

/**
 * 采纳一条接缝：
 * - 两端陶片此前不连通 -> 直接采纳，连通组合并；
 * - 已连通（新边形成环）-> 用后端同一份几何库计算闭合差：
 *     位置偏差 <= 方案容差：采纳为冗余一致约束；
 *     位置偏差 > 容差：拒绝采纳，保留 rejected 记录（含冲突链/闭合差），
 *                      当前布局不变。
 */
app.post('/api/projects/:id/seams', (req, res) => {
  const project = getProjectOr404(req.params.id);
  checkVersion(project, req.get('X-Expected-Version'));
  const b = req.body || {};

  const fromId = num(b.from_shard_id, 'from_shard_id');
  const toId = num(b.to_shard_id, 'to_shard_id');
  if (fromId === toId) {
    throw new HttpError(400, 'BAD_REQUEST', '接缝必须连接两片不同的陶片');
  }
  const rotation = num(b.rotation, 'rotation');
  const txMm = num(b.tx_mm, 'tx_mm');
  const tyMm = num(b.ty_mm, 'ty_mm');
  const seamNote = str(b.seam_note);
  const status = b.status === 'proposed' ? 'proposed' : 'adopted';

  const shards = dbm.get().prepare(
    'SELECT * FROM shards WHERE project_id = ?').all(project.id);
  const from = dbm.get().prepare(
    'SELECT * FROM shards WHERE id = ? AND project_id = ?')
    .get(fromId, project.id);
  const to = dbm.get().prepare(
    'SELECT * FROM shards WHERE id = ? AND project_id = ?')
    .get(toId, project.id);
  if (!from || !to) {
    throw new HttpError(400, 'BAD_REQUEST', '接缝两端必须是本方案中的陶片');
  }
  if (!(from.mm_per_px > 0) || !(to.mm_per_px > 0)) {
    throw new HttpError(400, 'BAD_REQUEST', '两片陶片都必须先标记毫米比例尺');
  }

  const adoptedEdges = dbm.get().prepare(
    `SELECT * FROM seams WHERE project_id = ? AND status = 'adopted'`)
    .all(project.id);

  let conflict = null;
  if (status === 'adopted') {
    conflict = Geometry.checkCycle(
      shards,
      adoptedEdges,
      { from_shard_id: fromId, to_shard_id: toId,
        rotation, tx_mm: txMm, ty_mm: tyMm },
      project.tolerance_mm
    );
  }

  let insertedStatus = status;
  if (conflict && conflict.closed && !conflict.passes) {
    insertedStatus = 'rejected';
  }

  let newId;
  dbm.tx(() => {
    const info = dbm.get().prepare(
      `INSERT INTO seams
         (project_id, from_shard_id, to_shard_id, rotation, tx_mm, ty_mm,
          seam_note, status, reject_reason, reject_chain, reject_misclosure_mm)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      project.id, fromId, toId, rotation, txMm, tyMm, seamNote,
      insertedStatus,
      insertedStatus === 'rejected'
        ? `环闭合位置偏差 ${conflict.translation_mm.toFixed(2)}mm 超过容差 ${project.tolerance_mm}mm`
        : '',
      insertedStatus === 'rejected'
        ? JSON.stringify(conflict.existing_chain) : '',
      insertedStatus === 'rejected' ? conflict.translation_mm : null
    );
    newId = info.lastInsertRowid;
    bumpVersion(project.id);
  });

  if (insertedStatus === 'rejected') {
    // 422 + 冲突详情；布局保持原样（rejected 不参与布局）
    return res.status(422).json({
      error: {
        code: 'SEAM_CYCLE_CONFLICT',
        message: `接缝形成环，推算位置偏差 ${conflict.translation_mm.toFixed(2)}mm，`
          + `超过方案容差 ${project.tolerance_mm}mm，已拒绝采纳，布局保持不变`,
        seam_id: newId,
        translation_mm: conflict.translation_mm,
        rotation_deg: conflict.rotation_deg,
        tolerance_mm: conflict.tolerance_mm,
        conflict_chain: conflict.existing_chain
      },
      project: loadProjectDetail(project.id)
    });
  }

  res.status(201).json(loadProjectDetail(project.id));
});

/** 撤销接缝（或删除任何状态的接缝记录），随后重新计算连通组与布局 */
app.delete('/api/seams/:id', (req, res) => {
  const seam = dbm.get().prepare('SELECT * FROM seams WHERE id = ?')
    .get(req.params.id);
  if (!seam) throw new HttpError(404, 'NOT_FOUND', '接缝不存在');
  const project = getProjectOr404(seam.project_id);
  checkVersion(project, req.get('X-Expected-Version'));

  dbm.tx(() => {
    dbm.get().prepare('DELETE FROM seams WHERE id = ?').run(seam.id);
    bumpVersion(project.id);
  });
  // 不沿用任何缓存布局：客户端拿到新数据后由共享几何库重算
  res.json(loadProjectDetail(project.id));
});

// ---- 错误处理 ----
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details }
    });
  }
  if (err && err.name === 'MulterError') {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? `图片超过 ${MAX_UPLOAD_MB}MB 上限` : `上传失败：${err.message}`;
    return res.status(400).json({ error: { code: 'UPLOAD_FAILED', message: msg } });
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
});

app.listen(PORT, () => {
  console.log(`陶片拼接工作台已启动: http://0.0.0.0:${PORT}`);
  console.log(`数据目录: ${DATA_DIR}`);
});
