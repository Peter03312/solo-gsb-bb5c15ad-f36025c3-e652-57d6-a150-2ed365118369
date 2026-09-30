'use strict';

/* global Geometry */

const G = Geometry;
const projectId = Number(new URLSearchParams(location.search).get('id'));

const state = { project: null, shards: [], seams: [], version: 0 };
const images = new Map();          // shardId -> HTMLImageElement
const sel = { shardId: null, seamId: null };
let renderData = null;             // 上一次画布布局（供命中测试）

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const ctx = stage.getContext('2d');
const host = $('canvasHost');

// ---------------- 通用 ----------------

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toast(msg, cls = '') {
  const el = document.createElement('div');
  el.className = `toast ${cls}`;
  el.textContent = msg;
  $('toast').appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

function shardName(id) {
  const s = state.shards.find((x) => x.id === id);
  return s ? s.name : `#${id}`;
}

async function jsonOrThrow(res) {
  const body = await res.json().catch(() => ({}));
  const err = new Error(body.error ? body.error.message : '请求失败');
  err.body = body;
  err.status = res.status;
  throw err;
}

const api = {
  async getProject() {
    const res = await fetch(`/api/projects/${projectId}`);
    if (!res.ok) throw await jsonOrThrow(res);
    return res.json();
  },
  async mutate(method, url, body, isForm) {
    const headers = { 'X-Expected-Version': String(state.version) };
    let payload = body;
    if (!isForm) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { method, headers, body: payload });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const err = new Error(j.error ? j.error.message : '请求失败');
      err.status = res.status; err.body = j; throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  },
  saveProject(patch) {
    return this.mutate('PATCH', `/api/projects/${projectId}`, JSON.stringify(patch));
  },
  deleteProject() {
    return this.mutate('DELETE', `/api/projects/${projectId}`);
  },
  deleteShard(id) {
    return this.mutate('DELETE', `/api/shards/${id}`);
  },
  async uploadShard(form) {
    return this.mutate('POST', `/api/projects/${projectId}/shards`, form, true);
  },
  async createSeam(payload) {
    return this.mutate('POST', `/api/projects/${projectId}/seams`,
      JSON.stringify(payload));
  },
  deleteSeam(id) {
    return this.mutate('DELETE', `/api/seams/${id}`);
  }
};

function applyProject(p) {
  state.project = p;
  state.shards = p.shards;
  state.seams = p.seams;
  state.version = p.version;
  document.title = `${p.name} · 陶片拼接工作台`;
  $('projName').textContent = p.name;
  $('projTol').textContent = `环闭合容差 ${p.tolerance_mm} mm`;
  $('versionPill').textContent = `v${p.version}`;
  syncImages();
  renderSidebars();
  renderChainPanel();
  scheduleDraw();
}

function syncImages() {
  const alive = new Set(state.shards.map((s) => s.id));
  for (const id of [...images.keys()]) {
    if (!alive.has(id)) images.delete(id);
  }
  state.shards.forEach((s) => {
    if (!images.has(s.id)) {
      const img = new Image();
      img.onload = () => scheduleDraw();
      img.src = s.image_path;
      images.set(s.id, img);
    }
  });
}

// ---------------- 画布布局 ----------------

const PAD = 24, HEADER = 28, GAP = 18;
const GROUP_W = 620, SINGLE_W = 210, SINGLE_H = 190;

/**
 * 用共享几何库算出连通组及毫米布局，再把各组排布到画布面板上。
 * 撤销 / 采纳后每次都从头重算，不沿用任何旧布局。
 */
function buildRenderData() {
  const adopted = state.seams.filter((s) => s.status === 'adopted');
  const groups = G.computeLayout(state.shards, adopted);
  const contentW = Math.max(host.clientWidth - 20, 860);

  const panels = [];
  let cursorY = 10;

  // 多片连通组
  groups.filter((g) => g.nodeIds.length > 1).forEach((g, i) => {
    const p = makeGroupPanel(g, GROUP_W, cursorY, 12, `连通组 ${i + 1}（${g.nodeIds.length} 片）`);
    panels.push(p);
    cursorY += p.height + GAP;
  });

  // 未连通陶片：各自独立面板，换行排列
  const singles = groups.filter((g) => g.nodeIds.length === 1);
  if (singles.length) {
    cursorY += 6;
    const perRow = Math.max(1, Math.floor((contentW - 24) / (SINGLE_W + 12)));
    singles.forEach((g, i) => {
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const x = 12 + col * (SINGLE_W + 12);
      const y = cursorY + 20 + row * (SINGLE_H + 12);
      panels.push(makeGroupPanel(g, SINGLE_W, y, x, null,
        SINGLE_H - HEADER - PAD * 2));
    });
    const rows = Math.ceil(singles.length / perRow);
    cursorY += 20 + rows * (SINGLE_H + 12);
  }

  const canvasW = contentW;
  const canvasH = Math.max(cursorY + 20, 400);
  return { panels, canvasW, canvasH, groups };
}

function makeGroupPanel(group, width, y, x, title, maxContentH) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  group.nodeIds.forEach((id) => {
    const node = state.shards.find((s) => s.id === id);
    G.shardWorldCorners(node, group.matrices.get(id)).forEach((c) => {
      minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x); maxY = Math.max(maxY, c.y);
    });
  });
  const wMm = Math.max(maxX - minX, 0.001);
  const hMm = Math.max(maxY - minY, 0.001);
  let scale = (width - PAD * 2) / wMm;
  if (maxContentH != null) {
    // 固定高度面板（未连通单片）
    scale = Math.min(scale, maxContentH / hMm);
  } else {
    // 连通组：按宽缩放，高度随内容，设上限避免过长
    scale = Math.min(scale, 460 / hMm);
  }

  const contentH = hMm * scale;
  const ox = x + PAD + (-minX) * scale;
  const oy = y + HEADER + PAD + (-minY) * scale;
  const height = (maxContentH != null ? maxContentH : contentH) + HEADER + PAD * 2;

  // 世界毫米 -> 屏幕像素
  const w2s = [scale, 0, 0, scale, ox, oy];
  return {
    group, x, y, width, height, title, scale, w2s,
    box: { x, y, w: width, h: height }
  };
}

let drawQueued = false;
function scheduleDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(); });
}

function draw() {
  renderData = buildRenderData();
  const dpr = window.devicePixelRatio || 1;
  stage.width = Math.round(renderData.canvasW * dpr);
  stage.height = Math.round(renderData.canvasH * dpr);
  stage.style.width = `${renderData.canvasW}px`;
  stage.style.height = `${renderData.canvasH}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, renderData.canvasW, renderData.canvasH);

  renderData.panels.forEach((panel) => {
    drawPanel(panel);
  });
  drawGhost();
}

function drawPanel(panel) {
  const { x, y, width: w, height: h } = panel;
  // 面板底
  ctx.fillStyle = '#fbf8f1';
  ctx.strokeStyle = '#d3c7b3';
  ctx.lineWidth = 1;
  roundRect(x, y, w, h, 8); ctx.fill(); ctx.stroke();

  ctx.fillStyle = '#8a7b68';
  ctx.font = '12px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(panel.title || '未连通陶片（未被任何采纳接缝连接）', x + 12, y + 14);

  // 接缝先画在图片下方
  drawEdges(panel);

  panel.group.nodeIds.forEach((id) => drawShard(panel, id));

  drawScaleBar(panel);
}

function drawShard(panel, id) {
  const node = state.shards.find((s) => s.id === id);
  const M = panel.group.matrices.get(id);
  const img = images.get(id);

  ctx.save();
  applyWorldTransform(panel, M);
  // 以下在陶片局部像素坐标系中绘制
  if (img && img.complete && img.naturalWidth) {
    ctx.globalAlpha = 0.92;
    ctx.drawImage(img, 0, 0, node.image_width, node.image_height);
    ctx.globalAlpha = 1;
  } else {
    ctx.fillStyle = '#e6dccb';
    ctx.fillRect(0, 0, node.image_width, node.image_height);
  }
  ctx.lineWidth = 1.5 / (panel.scale * node.mm_per_px);
  ctx.strokeStyle = sel.shardId === id ? '#b5532c' : '#5b4b3a';
  ctx.strokeRect(0, 0, node.image_width, node.image_height);

  // 名称写在片内顶部
  const fontSize = 12 / (panel.scale * node.mm_per_px);
  ctx.font = `${fontSize}px sans-serif`;
  const tw = ctx.measureText(node.name).width;
  ctx.fillStyle = 'rgba(255,255,255,.8)';
  ctx.fillRect(2, 2, tw + 8, fontSize + 6);
  ctx.fillStyle = '#3a2f25';
  ctx.textBaseline = 'top';
  ctx.fillText(node.name, 6, 5);
  ctx.restore();
}

/** 把“局部像素 -> 世界毫米”的矩阵经面板映射送入 ctx */
function applyWorldTransform(panel, M) {
  const s = panel.scale;
  ctx.translate(panel.w2s[4], panel.w2s[5]);
  ctx.scale(s, s);
  ctx.transform(M[0], M[1], M[2], M[3], M[4], M[5]);
}

function drawEdges(panel) {
  const chainStepIds = chainStepIds();

  state.seams.filter((m) => m.status === 'adopted').forEach((m) => {
    if (!panel.group.nodeIds.includes(m.from_shard_id) ||
        !panel.group.nodeIds.includes(m.to_shard_id)) return;
    const a = G.apply(panel.w2s,
      panel.group.matrices.get(m.from_shard_id)[4],
      panel.group.matrices.get(m.from_shard_id)[5]);
    const b = G.apply(panel.w2s,
      panel.group.matrices.get(m.to_shard_id)[4],
      panel.group.matrices.get(m.to_shard_id)[5]);

    const highlighted = sel.seamId === m.id || chainStepIds.includes(m.id);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = highlighted ? '#c98a16' : 'rgba(47,109,143,.75)';
    ctx.lineWidth = highlighted ? 3.5 : 2;
    ctx.setLineDash([]);
    ctx.stroke();

    // 接缝编号
    ctx.fillStyle = highlighted ? '#c98a16' : '#2f6d8f';
    ctx.font = '11px sans-serif';
    ctx.textBaseline = 'bottom';
    const label = `#${m.id}`;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.fillRect(mx - tw / 2 - 3, my - 14, tw + 6, 14);
    ctx.fillStyle = highlighted ? '#c98a16' : '#2f6d8f';
    ctx.fillText(label, mx - tw / 2, my - 1);
  });
}

function drawScaleBar(panel) {
  const targetPx = 90;
  const candidates = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  let lenMm = candidates[candidates.length - 1];
  for (const c of candidates) {
    if (c * panel.scale >= targetPx) { lenMm = c; break; }
  }
  const x0 = panel.x + 14;
  const y0 = panel.y + panel.height - 14;
  const x1 = x0 + lenMm * panel.scale;
  ctx.strokeStyle = '#3a2f25'; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x0, y0); ctx.lineTo(x1, y0);
  ctx.moveTo(x0, y0 - 4); ctx.lineTo(x0, y0 + 4);
  ctx.moveTo(x1, y0 - 4); ctx.lineTo(x1, y0 + 4);
  ctx.stroke();
  ctx.fillStyle = '#5b4b3a'; ctx.font = '11px sans-serif';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${lenMm} mm`, x0, y0 - 6);
}

/** 输入参数时实时预览新接缝推出的 B 片位置与闭合差 */
function drawGhost() {
  const cand = readCandidate(false);
  if (!cand) return;
  const fromPanel = panelOf(cand.from_shard_id);
  const toNode = state.shards.find((s) => s.id === cand.to_shard_id);
  if (!fromPanel || !toNode) return;

  // 接缝是毫米空间刚体 X；M_from = T_from · S_from，故
  // T_pred = T_from · X = M_from · S_from^-1 · X
  // M_pred = T_pred · S_to（to 片用自己的毫米/像素缩放）
  const MFrom = fromPanel.group.matrices.get(cand.from_shard_id);
  const fromNode = state.shards.find((s) => s.id === cand.from_shard_id);
  const X = G.localToWorld(1, cand.rotation, cand.tx_mm, cand.ty_mm);
  const TPred = G.multiply(
    G.multiply(MFrom, G.scaleMatrix(1 / fromNode.mm_per_px)), X);
  const MPred = G.multiply(TPred, G.scaleMatrix(toNode.mm_per_px));

  ctx.save();
  applyWorldTransform(fromPanel, MPred);
  // 此时坐标系是局部像素；按每像素在屏幕上的放大率折算虚线/线宽
  const pxScale = fromPanel.scale * toNode.mm_per_px;
  ctx.setLineDash([6 / pxScale, 5 / pxScale]);
  ctx.lineWidth = 2 / pxScale;
  ctx.strokeStyle = '#c98a16';
  ctx.strokeRect(0, 0, toNode.image_width, toNode.image_height);
  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------------- 命中测试与选择 ----------------

function panelOf(shardId) {
  if (!renderData) return null;
  return renderData.panels.find((p) => p.group.nodeIds.includes(shardId)) || null;
}

function pickShard(cssX, cssY) {
  if (!renderData) return null;
  let hit = null;
  renderData.panels.forEach((panel) => {
    panel.group.nodeIds.forEach((id) => {
      const node = state.shards.find((s) => s.id === id);
      const w2l = G.invert(G.multiply(panel.w2s, panel.group.matrices.get(id)));
      const p = G.apply(w2l, cssX, cssY);
      if (p.x >= 0 && p.y >= 0 && p.x <= node.image_width && p.y <= node.image_height) {
        hit = id; // 后绘制的在上层
      }
    });
  });
  return hit;
}

function pickSeam(cssX, cssY) {
  if (!renderData) return null;
  let best = null, bestD = 7;
  renderData.panels.forEach((panel) => {
    state.seams.filter((m) => m.status === 'adopted').forEach((m) => {
      if (!panel.group.nodeIds.includes(m.from_shard_id)) return;
      const Mf = panel.group.matrices.get(m.from_shard_id);
      const Mt = panel.group.matrices.get(m.to_shard_id);
      const a = G.apply(panel.w2s, Mf[4], Mf[5]);
      const b = G.apply(panel.w2s, Mt[4], Mt[5]);
      const d = distToSegment(cssX, cssY, a.x, a.y, b.x, b.y);
      if (d < bestD) { bestD = d; best = m.id; }
    });
  });
  return best;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy || 1;
  let t = ((px - x1) * dx + (py - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

stage.addEventListener('click', (e) => {
  const rect = stage.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const seamId = pickSeam(x, y);
  if (seamId != null) { sel.seamId = seamId; sel.shardId = null; }
  else {
    const shardId = pickShard(x, y);
    sel.shardId = shardId;
    if (shardId != null) sel.seamId = null;
  }
  renderSidebars();
  renderChainPanel();
  draw();
});

window.addEventListener('resize', scheduleDraw);

// ---------------- 侧栏 ----------------

function calibratedShards() {
  return state.shards.filter((s) => s.mm_per_px > 0);
}

function renderSidebars() {
  // 陶片列表
  $('shardList').innerHTML = state.shards.map((s) => `
    <div class="shard-item ${sel.shardId === s.id ? 'selected' : ''}">
      <div class="n">${esc(s.name)}</div>
      <div class="m">${s.image_width}×${s.image_height}px ·
        1px = ${s.mm_per_px.toFixed(3)}mm
        ${s.note ? '· ' + esc(s.note) : ''}</div>
      <div class="mini-btns">
        <button data-act="setFrom" data-id="${s.id}">设为 A</button>
        <button data-act="setTo" data-id="${s.id}">设为 B</button>
        <button data-act="pick" data-id="${s.id}">定位</button>
        <button class="danger" data-act="delShard" data-id="${s.id}">删除</button>
      </div>
    </div>`).join('') || '<p class="hint">尚未上传陶片。</p>';

  // 接缝表单下拉
  const cal = calibratedShards();
  const opts = cal.map((s) =>
    `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  const fromSel = $('fromShard'), toSel = $('toShard');
  const keepFrom = fromSel.value, keepTo = toSel.value;
  fromSel.innerHTML = opts; toSel.innerHTML = opts;
  if ([...fromSel.options].some((o) => o.value === keepFrom)) fromSel.value = keepFrom;
  else if (cal[0]) fromSel.value = String(cal[0].id);
  if ([...toSel.options].some((o) => o.value === keepTo)) toSel.value = keepTo;
  else if (cal[1]) toSel.value = String(cal[1].id);
  else if (cal[0] && fromSel.value === String(cal[0].id)) {
    // 只有一片时 B 留空，避免 A、B 同片
    toSel.value = '';
  }

  // 接缝列表
  $('seamList').innerHTML = state.seams.map((m) => {
    const statusText = { adopted: '已采纳', proposed: '仅记录', rejected: '已拒绝' }[m.status];
    let extra = '';
    if (m.status === 'rejected' && m.reject_chain && m.reject_chain.length) {
      const chain = m.reject_chain.map((cid) => `#${cid}`).join(' → ');
      extra = `<div class="chain">冲突链：${chain}；闭合位置偏差 ${m.reject_misclosure_mm != null ? m.reject_misclosure_mm.toFixed(2) : '?'} mm &gt; ${state.project.tolerance_mm} mm，布局未改变</div>`;
    }
    const actions = m.status === 'adopted'
      ? `<button data-act="undo" data-id="${m.id}">撤销</button>`
      : m.status === 'proposed'
        ? `<button data-act="adoptSeam" data-id="${m.id}">采纳</button>
           <button class="danger" data-act="delSeam" data-id="${m.id}">删除</button>`
        : `<button class="danger" data-act="delSeam" data-id="${m.id}">清除记录</button>`;
    return `
    <div class="seam-item ${m.status} ${sel.seamId === m.id ? 'selected' : ''}">
      <span class="st">[${statusText} #${m.id}]</span>
      ${esc(shardName(m.from_shard_id))} → ${esc(shardName(m.to_shard_id))}
      <div class="m">旋转 ${m.rotation}° · 平移 (${m.tx_mm}, ${m.ty_mm}) mm</div>
      ${m.seam_note ? `<div class="note">📝 ${esc(m.seam_note)}</div>` : ''}
      ${extra}
      <div class="mini-btns" style="margin-top:5px">
        <button data-act="selSeam" data-id="${m.id}">高亮</button>
        ${actions}
      </div>
    </div>`;
  }).join('') || '<p class="hint">还没有接缝记录。</p>';
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const act = btn.dataset.act;
  if (act === 'setFrom') { $('fromShard').value = id; updateGhostInfo(); }
  if (act === 'setTo') { $('toShard').value = id; updateGhostInfo(); }
  if (act === 'pick') { sel.shardId = id; renderSidebars(); renderChainPanel(); draw(); }
  if (act === 'delShard' && confirm(`删除陶片「${shardName(id)}」？与之关联的接缝将一并删除。`)) {
    await guard(() => api.deleteShard(id));
  }
  if (act === 'undo' && confirm(`撤销接缝 #${id}？连通组与位置将重新计算。`)) {
    await guard(() => api.deleteSeam(id));
  }
  if (act === 'delSeam') {
    await guard(() => api.deleteSeam(id));
  }
  if (act === 'adoptSeam') {
    const m = state.seams.find((x) => x.id === id);
    await guard(() => submitSeam('adopted', m));
  }
  if (act === 'selSeam') {
    sel.seamId = id; sel.shardId = null;
    renderSidebars(); renderChainPanel(); draw();
  }
});

/** 选中陶片到组锚点所依据的接缝链 */
function chainStepIds() {
  if (sel.shardId == null || !renderData) return [];
  const panel = panelOf(sel.shardId);
  if (!panel) return [];
  return panel.group.paths.get(sel.shardId).map((s) => s.edgeId);
}

function renderChainPanel() {
  const box = $('chainPanel');
  if (sel.shardId == null) {
    box.innerHTML = '<p class="hint">在画布或左侧点选一片陶片，查看其到连通组锚点所依据的接缝链。</p>';
    return;
  }
  const panel = panelOf(sel.shardId);
  if (!panel) { box.innerHTML = '<p class="hint">布局未就绪。</p>'; return; }
  const path = panel.group.paths.get(sel.shardId);
  if (!path.length) {
    box.innerHTML = `<p class="hint">「${esc(shardName(sel.shardId))}」是该连通组的锚点（基准片），或尚未与任何陶片连通。</p>`;
    return;
  }
  const anchor = panel.group.nodeIds[0];
  let html = `<p class="hint">锚点：<b>${esc(shardName(anchor))}</b>，到「${esc(shardName(sel.shardId))}」共 ${path.length} 条接缝：</p>`;
  path.forEach((step, i) => {
    const m = step.edge;
    const a = step.dir === 1 ? m.from_shard_id : m.to_shard_id;
    const b = step.dir === 1 ? m.to_shard_id : m.from_shard_id;
    html += `<div class="chain-step">${i + 1}. 接缝 <b>#${m.id}</b>：${esc(shardName(a))} → ${esc(shardName(b))}
      <div class="m">旋转 ${m.rotation}° · 平移 (${m.tx_mm}, ${m.ty_mm}) mm${m.seam_note ? ' · ' + esc(m.seam_note) : ''}</div></div>`;
  });
  box.innerHTML = html;
}

// ---------------- 接缝表单 / 实时闭合差 ----------------

function readCandidate(verbose) {
  const from = Number($('fromShard').value);
  const to = Number($('toShard').value);
  if (!from || !to || from === to) {
    if (verbose) toast('请选择两片不同的、已标定比例尺的陶片', 'error');
    return null;
  }
  return {
    from_shard_id: from,
    to_shard_id: to,
    rotation: Number($('rot').value),
    tx_mm: Number($('tx').value),
    ty_mm: Number($('ty').value),
    seam_note: $('seamNote').value
  };
}

function updateGhostInfo() {
  const c = readCandidate(false);
  const box = $('ghostInfo');
  if (!c) {
    box.innerHTML = '选择两片陶片并输入映射参数后，画布上虚线预览 B 片位置。';
    draw();
    return;
  }
  const adopted = state.seams.filter((m) => m.status === 'adopted');
  const r = G.checkCycle(state.shards, adopted, c, state.project.tolerance_mm);
  if (r.closed) {
    const ok = r.passes;
    box.innerHTML = `该接缝将形成环：闭合位置偏差
      <b class="${ok ? 'good' : 'bad'}">${r.translation_mm.toFixed(2)} mm</b>
      （旋转差 ${r.rotation_deg.toFixed(2)}°），容差 ${state.project.tolerance_mm} mm —
      ${ok ? '一致，可采纳为冗余约束。' : '超差，采纳将被拒绝。'}`;
  } else {
    box.innerHTML = '两片此前未连通，采纳后将合并为一个连通组。';
  }
  draw();
}

['fromShard', 'toShard', 'rot', 'tx', 'ty'].forEach((id) => {
  $(id).addEventListener('input', updateGhostInfo);
  $(id).addEventListener('change', updateGhostInfo);
});

async function submitSeam(status, preset) {
  const c = preset || readCandidate(true);
  if (!c) return;
  if (!Number.isFinite(c.rotation) || !Number.isFinite(c.tx_mm) || !Number.isFinite(c.ty_mm)) {
    return toast('旋转和平移必须是数字', 'error');
  }
  await guard(() => api.createSeam({ ...c, status }), true);
  if (!preset) $('seamNote').value = '';
}

$('adoptBtn').addEventListener('click', () => submitSeam('adopted'));
$('proposeBtn').addEventListener('click', () => submitSeam('proposed'));

/**
 * 执行写操作：
 * - 409 版本冲突：弹模态框，绝不重试覆盖；
 * - 422 环闭合冲突：载入返回的最新方案，高亮被拒绝记录。
 */
async function guard(fn, isSeamCreate) {
  try {
    const p = await fn();
    if (p) applyProject(p);
    return true;
  } catch (err) {
    if (err.status === 409) {
      const d = err.body && err.body.error && err.body.error.details;
      $('conflictText').textContent = d
        ? err.body.error.message
        : err.message;
      $('conflictModal').hidden = false;
    } else if (isSeamCreate && err.status === 422 && err.body) {
      const info = err.body.error;
      if (err.body.project) applyProject(err.body.project);
      sel.seamId = info.seam_id; sel.shardId = null;
      renderSidebars(); renderChainPanel(); draw();
      toast(`接缝被拒绝：${info.message}；冲突链 ${info.conflict_chain.map((x) => '#' + x).join(' → ')}`, 'error');
    } else {
      toast(err.message, 'error');
      // 失败后重新拉取，保证本地版本号与服务端一致
      try { applyProject(await api.getProject()); } catch (_) {}
    }
    return false;
  }
}

// ---------------- 上传与比例尺标定 ----------------

const marker = { img: null, p1: null, p2: null, displayW: 0, displayH: 0 };

$('uploadBtn').addEventListener('click', () => {
  $('fileInput').value = '';
  marker.img = null; marker.p1 = marker.p2 = null;
  drawScaleCanvas();
  $('confirmUpload').disabled = true;
  $('uploadModal').hidden = false;
});
$('cancelUpload').addEventListener('click', () => { $('uploadModal').hidden = true; });

$('fileInput').addEventListener('change', () => {
  const file = $('fileInput').files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    if (!$('shardName').value) {
      $('shardName').value = file.name.replace(/\.[^.]+$/, '').slice(0, 40);
    }
    marker.img = img; marker.p1 = marker.p2 = null;
    drawScaleCanvas();
    URL.revokeObjectURL(url);
  };
  img.src = url;
});

const sc = $('scaleCanvas');
sc.addEventListener('click', (e) => {
  if (!marker.img) return;
  const rect = sc.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (sc.width / rect.width);
  const y = (e.clientY - rect.top) * (sc.height / rect.height);
  if (!marker.p1 || marker.p2) { marker.p1 = { x, y }; marker.p2 = null; }
  else { marker.p2 = { x, y }; }
  drawScaleCanvas();
  $('confirmUpload').disabled = !(marker.p1 && marker.p2 && Number($('scaleMm').value) > 0);
});
$('scaleMm').addEventListener('input', () => {
  $('confirmUpload').disabled = !(marker.p1 && marker.p2 && Number($('scaleMm').value) > 0);
});

function drawScaleCanvas() {
  const c = sc.getContext('2d');
  c.fillStyle = '#ece5d8';
  c.fillRect(0, 0, sc.width, sc.height);
  if (!marker.img) {
    c.fillStyle = '#8a7b68'; c.font = '14px sans-serif';
    c.fillText('选择照片后，在比例尺两端各点一下', 20, sc.height / 2);
    return;
  }
  const s = Math.min(sc.width / marker.img.naturalWidth,
    sc.height / marker.img.naturalHeight);
  marker.displayW = marker.img.naturalWidth * s;
  marker.displayH = marker.img.naturalHeight * s;
  marker.scaleToNatural = 1 / s;
  const ox = (sc.width - marker.displayW) / 2;
  const oy = (sc.height - marker.displayH) / 2;
  c.drawImage(marker.img, ox, oy, marker.displayW, marker.displayH);
  c.strokeStyle = '#333'; c.strokeRect(ox, oy, marker.displayW, marker.displayH);
  if (marker.p1) {
    c.fillStyle = '#b23a2f';
    c.beginPath(); c.arc(marker.p1.x, marker.p1.y, 4, 0, Math.PI * 2); c.fill();
  }
  if (marker.p2) {
    c.beginPath(); c.arc(marker.p2.x, marker.p2.y, 4, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#b23a2f'; c.lineWidth = 2;
    c.beginPath();
    c.moveTo(marker.p1.x, marker.p1.y); c.lineTo(marker.p2.x, marker.p2.y);
    c.stroke();
    const px = Math.hypot(marker.p2.x - marker.p1.x, marker.p2.y - marker.p1.y) / s;
    c.fillStyle = '#b23a2f'; c.font = '13px sans-serif'; c.textBaseline = 'bottom';
    c.fillText(`标定线长 ${px.toFixed(1)} 像素`, 8, sc.height - 8);
  }
}

$('confirmUpload').addEventListener('click', async () => {
  if (!marker.img || !marker.p1 || !marker.p2) return;
  const scaleMm = Number($('scaleMm').value);
  if (!(scaleMm > 0)) return toast('标定线毫米数必须为正数', 'error');
  const s = marker.displayW / marker.img.naturalWidth;
  const scalePx = Math.hypot(marker.p2.x - marker.p1.x, marker.p2.y - marker.p1.y) / s;

  const fd = new FormData();
  fd.append('image', $('fileInput').files[0]);
  fd.append('name', $('shardName').value.trim());
  fd.append('note', $('shardNote').value);
  fd.append('image_width', marker.img.naturalWidth);
  fd.append('image_height', marker.img.naturalHeight);
  fd.append('scale_px', scalePx);
  fd.append('scale_mm', scaleMm);

  $('confirmUpload').disabled = true;
  const ok = await guard(() => api.uploadShard(fd));
  if (ok) {
    $('uploadModal').hidden = true;
    toast('陶片已上传，比例尺已标定', 'success');
  } else {
    $('confirmUpload').disabled = false;
  }
});

// ---------------- 方案设置 ----------------

$('settingsBtn').addEventListener('click', () => {
  $('setName').value = state.project.name;
  $('setDesc').value = state.project.description;
  $('setTol').value = state.project.tolerance_mm;
  $('settingsModal').hidden = false;
});
$('cancelSettings').addEventListener('click', () => { $('settingsModal').hidden = true; });

$('saveSettings').addEventListener('click', async () => {
  const ok = await guard(() => api.saveProject({
    name: $('setName').value.trim(),
    description: $('setDesc').value,
    tolerance_mm: Number($('setTol').value)
  }));
  if (ok) $('settingsModal').hidden = true;
});

$('deleteProject').addEventListener('click', async () => {
  if (!confirm('确定删除整个方案？陶片照片、接缝记录都会删除，且不可恢复。')) return;
  const ok = await guard(() => api.deleteProject());
  if (ok) location.href = '/index.html';
});

// ---------------- 协作：轮询远端版本 ----------------

setInterval(async () => {
  if (document.hidden || !$('conflictModal').hidden) return;
  try {
    const p = await api.getProject();
    if (p.version !== state.version) {
      toast(`检测到其他成员已更新到 v${p.version}，已自动载入最新布局`, 'success');
      applyProject(p);
    }
  } catch (_) { /* 网络抖动时忽略 */ }
}, 5000);

// ---------------- 启动 ----------------

(async function init() {
  try {
    applyProject(await api.getProject());
  } catch (e) {
    document.body.innerHTML = `<div class="wrap"><div class="card"><h2>无法加载方案</h2>
      <p>${esc(e.message)}</p><a href="/index.html">← 返回方案列表</a></div></div>`;
  }
})();
