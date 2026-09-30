'use strict';

/* 端到端冒烟测试：node test/e2e.smoke.js
 * 依赖服务已在 $BASE（默认 http://127.0.0.1:8090）启动 */

const zlib = require('zlib');
const G = require('../shared/geometry');

const BASE = process.env.BASE || 'http://127.0.0.1:8090';
let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}`, extra || ''); }
}

/** 用 zlib 手写一张纯色 PNG，避免外部图像库依赖 */
function makePng(w, h, rgb) {
  const crcTable = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 3) + 1 + x * 3;
      raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

async function req(method, url, { version, json, form } = {}) {
  const headers = {};
  let body;
  if (version != null) headers['X-Expected-Version'] = String(version);
  if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) { body = form; }
  const res = await fetch(BASE + url, { method, headers, body });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

function uploadShard(version, name) {
  const fd = new FormData();
  fd.append('image', new Blob([makePng(100, 100, [180, 90, 50])],
    { type: 'image/png' }), `${name}.png`);
  fd.append('name', name);
  fd.append('image_width', '100');
  fd.append('image_height', '100');
  fd.append('scale_px', '100');
  fd.append('scale_mm', '10'); // 1px = 0.1mm，照片宽 10mm
  return req('POST', '/api/projects/1/shards', { version, form: fd });
}

(async () => {
  // 1. 建方案
  let r = await req('POST', '/api/projects',
    { json: { name: '冒烟测试方案', tolerance_mm: 2 } });
  check('创建方案 201', r.status === 201, r);
  const v1 = r.data.version;

  // 2. 上传三片陶片
  for (const n of ['甲', '乙', '丙']) {
    r = await uploadShard(r.data.version, n);
    check(`上传陶片「${n}」201`, r.status === 201, r.data);
  }
  let project = r.data;
  check('三片陶片就位', project.shards.length === 3);
  check('版本随上传推进到 v4', project.version === v1 + 3, `v${project.version}`);
  const [A, B, C] = project.shards;

  // 3. 采纳 甲→乙 (10mm,0)、乙→丙 (10mm,0)
  r = await req('POST', '/api/projects/1/seams',
    { version: project.version, json: {
      from_shard_id: A.id, to_shard_id: B.id, rotation: 0,
      tx_mm: 10, ty_mm: 0, seam_note: '沿 A-B', status: 'adopted' } });
  check('采纳接缝 甲→乙', r.status === 201, r.data);
  project = r.data;

  r = await req('POST', '/api/projects/1/seams',
    { version: project.version, json: {
      from_shard_id: B.id, to_shard_id: C.id, rotation: 0,
      tx_mm: 10, ty_mm: 0, seam_note: '沿 B-C', status: 'adopted' } });
  check('采纳接缝 乙→丙', r.status === 201, r.data);
  project = r.data;

  // 4. 布局核对：甲(0)、乙(10)、丙(20)
  let groups = G.computeLayout(project.shards,
    project.seams.filter((s) => s.status === 'adopted'));
  check('三片一个连通组', groups.length === 1 && groups[0].nodeIds.length === 3);
  const mC = groups[0].matrices.get(C.id);
  check('丙由接缝链推出在 x=20mm', Math.abs(mC[4] - 20) < 1e-9, `x=${mC[4]}`);
  const chainC = groups[0].paths.get(C.id);
  check('丙的接缝链为两条', chainC.length === 2);

  // 5. 环冲突：甲→丙 声称 23mm，容差 2mm，应 422 拒绝，布局不变
  const staleVersion = project.version;
  r = await req('POST', '/api/projects/1/seams',
    { version: project.version, json: {
      from_shard_id: A.id, to_shard_id: C.id, rotation: 0,
      tx_mm: 23, ty_mm: 0, status: 'adopted' } });
  check('超差环接缝返回 422', r.status === 422, r.status);
  check('指出冲突链 [甲→乙, 乙→丙]',
    Array.isArray(r.data.error.conflict_chain) && r.data.error.conflict_chain.length === 2,
    r.data.error);
  check('闭合差 3mm', Math.abs(r.data.error.translation_mm - 3) < 1e-9);
  project = r.data.project;
  const rejected = project.seams.find((s) => s.status === 'rejected');
  check('拒绝记录入库且不参与布局', !!rejected);
  groups = G.computeLayout(project.shards,
    project.seams.filter((s) => s.status === 'adopted'));
  const mC2 = groups[0].matrices.get(C.id);
  check('拒绝后丙仍在 x=20mm（原布局保持）', Math.abs(mC2[4] - 20) < 1e-9);

  // 6. 一致环：20.5mm（偏差 0.5mm ≤ 2mm）应采纳
  r = await req('POST', '/api/projects/1/seams',
    { version: project.version, json: {
      from_shard_id: A.id, to_shard_id: C.id, rotation: 0,
      tx_mm: 20.5, ty_mm: 0, status: 'adopted' } });
  check('容差内一致环被采纳', r.status === 201, r.data);
  project = r.data;

  // 7. 版本冲突：用旧版本号写，必须 409 且不静默覆盖
  r = await req('POST', '/api/projects/1/seams',
    { version: staleVersion, json: {
      from_shard_id: A.id, to_shard_id: C.id, rotation: 0,
      tx_mm: 99, ty_mm: 0, status: 'adopted' } });
  check('过期版本写入返回 409', r.status === 409, r.status);
  check('409 给出 expected/current',
    r.data.error && r.data.error.code === 'VERSION_CONFLICT' &&
    r.data.error.details.current !== r.data.error.details.expected,
    r.data.error);

  // 8. proposed 接缝不影响布局
  r = await req('POST', '/api/projects/1/seams',
    { version: project.version, json: {
      from_shard_id: A.id, to_shard_id: C.id, rotation: 0,
      tx_mm: 999, ty_mm: 0, status: 'proposed' } });
  check('仅记录接缝 201', r.status === 201);
  project = r.data;
  const adoptedCount = project.seams.filter((s) => s.status === 'adopted').length;
  check('proposed 不计入采纳边', adoptedCount === 3, `adopted=${adoptedCount}`);

  // 9. 撤销 乙→丙：连通组必须分裂，重算布局不沿用
  //    先撤销第 6 步的冗余环边（甲→丙 20.5mm），否则三片仍经它连通
  const ringSeam = project.seams.find((s) =>
    s.from_shard_id === A.id && s.to_shard_id === C.id && s.status === 'adopted'
    && Math.abs(s.tx_mm - 20.5) < 1e-9);
  r = await req('DELETE', `/api/seams/${ringSeam.id}`, { version: project.version });
  check('先撤销冗余环边', r.status === 200, r.status);
  project = r.data;

  const seamBC = project.seams.find((s) =>
    s.from_shard_id === B.id && s.to_shard_id === C.id && s.status === 'adopted');
  r = await req('DELETE', `/api/seams/${seamBC.id}`, { version: project.version });
  check('撤销接缝 200', r.status === 200, r.status);
  project = r.data;
  groups = G.computeLayout(project.shards,
    project.seams.filter((s) => s.status === 'adopted'));
  check('撤销后连通组分裂为 2 组', groups.length === 2,
    groups.map((g) => g.nodeIds.length));
  const groupC = groups.find((g) => g.nodeIds.length === 1 && g.nodeIds[0] === C.id);
  check('丙成为独立单片（锚点回 0,0，不沿用 x=20）',
    !!groupC && Math.abs(groupC.matrices.get(C.id)[4]) < 1e-9);

  // 10. 再次确认写操作推进版本、且缺版本头被拒
  r = await req('POST', '/api/projects/1/seams', { json: {
    from_shard_id: B.id, to_shard_id: C.id, rotation: 0,
    tx_mm: 10, ty_mm: 0, status: 'adopted' } });
  check('缺少版本头返回 400', r.status === 400, r.status);

  console.log(failures ? `\n冒烟测试 ${failures} 项失败` : '\n冒烟测试全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
