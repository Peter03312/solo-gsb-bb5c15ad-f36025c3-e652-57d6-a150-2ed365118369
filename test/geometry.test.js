'use strict';

/* node test/geometry.test.js — 不依赖测试框架的核心几何校验 */

const assert = require('assert');
const G = require('../shared/geometry');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// 两片：A、B 各 100px，1px = 0.1mm（即照片宽 10mm）
const nodes = [
  { id: 1, image_width: 100, image_height: 100, mm_per_px: 0.1 },
  { id: 2, image_width: 100, image_height: 100, mm_per_px: 0.1 },
  { id: 3, image_width: 100, image_height: 100, mm_per_px: 0.1 }
];

test('矩阵乘单位矩阵不变', () => {
  const m = G.localToWorld(0.1, 30, 5, -7);
  const r = G.multiply(m, G.identity());
  m.forEach((v, i) => assert.ok(Math.abs(v - r[i]) < 1e-12));
});

test('逆矩阵回原点', () => {
  const m = G.localToWorld(0.1, 35, 5, -7);
  const back = G.multiply(G.invert(m), m);
  assert.ok(Math.abs(back[4]) < 1e-9 && Math.abs(back[5]) < 1e-9);
  assert.ok(Math.abs(back[0] - 1) < 1e-9 && Math.abs(back[3] - 1) < 1e-9);
});

test('一条接缝后连通组合并，B 位置由接缝决定', () => {
  // B = A 向右平移 10mm
  const edges = [edge(10, 1, 2, 0, 10, 0)];
  const groups = G.computeLayout(nodes, edges);
  assert.strictEqual(groups.length, 2);           // {1,2} 与 {3}
  const g = groups.find((x) => x.nodeIds.length === 2);
  assert.deepStrictEqual(g.nodeIds, [1, 2]);
  const mb = g.matrices.get(2);
  assert.ok(Math.abs(mb[4] - 10) < 1e-9);         // B 原点在 x=10mm
  assert.ok(Math.abs(mb[5]) < 1e-9);
  assert.strictEqual(g.paths.get(2).length, 1);
});

test('不形成环的新接缝：closed=false', () => {
  const edges = [edge(10, 1, 2, 0, 10, 0)];
  const r = G.checkCycle(nodes, edges,
    { from_shard_id: 2, to_shard_id: 3, rotation: 0, tx_mm: 10, ty_mm: 0 }, 2);
  assert.strictEqual(r.closed, false);
});

test('一致环（A→B 10mm 且 B→C 10mm，再 A→C 20mm）闭合差为 0，通过', () => {
  const edges = [
    edge(10, 1, 2, 0, 10, 0),
    edge(11, 2, 3, 0, 10, 0)
  ];
  const r = G.checkCycle(nodes, edges,
    { from_shard_id: 1, to_shard_id: 3, rotation: 0, tx_mm: 20, ty_mm: 0 }, 2);
  assert.strictEqual(r.closed, true);
  assert.ok(r.translation_mm < 1e-9, `闭合差应≈0，实际 ${r.translation_mm}`);
  assert.ok(r.passes);
  assert.deepStrictEqual(r.existing_chain, [10, 11]);
});

test('冲突环：A→C 实际 20mm，新接缝称 23mm，超 2mm 容差被拒', () => {
  const edges = [
    edge(10, 1, 2, 0, 10, 0),
    edge(11, 2, 3, 0, 10, 0)
  ];
  const r = G.checkCycle(nodes, edges,
    { from_shard_id: 1, to_shard_id: 3, rotation: 0, tx_mm: 23, ty_mm: 0 }, 2);
  assert.strictEqual(r.closed, true);
  assert.ok(Math.abs(r.translation_mm - 3) < 1e-9);
  assert.strictEqual(r.passes, false);
});

test('反向接缝链也能得到一致布局（C→B 平移 -10mm）', () => {
  const edges = [
    edge(10, 1, 2, 0, 10, 0),
    edge(11, 3, 2, 0, -10, 0)
  ];
  const groups = G.computeLayout(nodes, edges);
  const g = groups.find((x) => x.nodeIds.length === 3);
  assert.ok(g);
  const mc = g.matrices.get(3);
  assert.ok(Math.abs(mc[4] - 20) < 1e-9);
});

test('撤销中间接缝后连通组立即重新分裂，不沿用旧位置', () => {
  const edges = [
    edge(10, 1, 2, 0, 10, 0),
    edge(11, 2, 3, 0, 10, 0)
  ];
  assert.strictEqual(G.computeLayout(nodes, edges).length, 1);
  const split = G.computeLayout(nodes, [edges[0]]);
  assert.strictEqual(split.length, 2);
});

test('旋转 90° 映射：B 的 x 轴对齐 A 的 y 轴', () => {
  const edges = [edge(10, 1, 2, 90, 0, 0)];
  const g = G.computeLayout(nodes, edges).find((x) => x.nodeIds.length === 2);
  const mb = g.matrices.get(2);
  // B 局部 (10,0) -> 全局：旋转90°后约 (0,10mm)
  const p = G.apply(mb, 100, 0); // 100px * 0.1 = 10mm
  assert.ok(Math.abs(p.x) < 1e-9, `x 应≈0，实际 ${p.x}`);
  assert.ok(Math.abs(p.y - 10) < 1e-9);
});

test('混合链（旋转后平移）复合顺序正确：B 转90°，C 沿 B 的 +x 平移10mm 应在世界 +y', () => {
  const edges = [
    edge(10, 1, 2, 90, 0, 0),
    edge(11, 2, 3, 0, 10, 0)
  ];
  const g = G.computeLayout(nodes, edges).find((x) => x.nodeIds.length === 3);
  const mc = g.matrices.get(3);
  const p = G.apply(mc, 0, 0); // C 的原点（局部毫米原点）
  assert.ok(Math.abs(p.x) < 1e-9, `x 应≈0，实际 ${p.x}`);
  assert.ok(Math.abs(p.y - 10) < 1e-9, `y 应≈10，实际 ${p.y}`);
});

test('三片比例尺不同：每片保留各自 mm_per_px，不借用邻片缩放', () => {
  // A: 0.1mm/px, B: 0.2mm/px, C: 0.05mm/px；纯平移连接
  const mixed = [
    { id: 1, image_width: 100, image_height: 100, mm_per_px: 0.1 },
    { id: 2, image_width: 100, image_height: 100, mm_per_px: 0.2 },
    { id: 3, image_width: 100, image_height: 100, mm_per_px: 0.05 }
  ];
  const edges = [
    edge(10, 1, 2, 0, 30, 0),
    edge(11, 2, 3, 0, 15, 40)
  ];
  const g = G.computeLayout(mixed, edges).find((x) => x.nodeIds.length === 3);
  const ma = g.matrices.get(1);
  const mb = g.matrices.get(2);
  const mc = g.matrices.get(3);
  // A 宽 10mm；B 原点在 30mm、宽 20mm；C 原点 45,40、宽 5mm
  assert.ok(Math.abs(ma[0] - 0.1) < 1e-12, 'A 缩放应为自身 0.1');
  assert.ok(Math.abs(mb[4] - 30) < 1e-9 && Math.abs(mb[0] - 0.2) < 1e-12,
    `B 原点x=30 且缩放0.2，实际 ${JSON.stringify(mb)}`);
  assert.ok(Math.abs(mc[4] - 45) < 1e-9 && Math.abs(mc[5] - 40) < 1e-9
    && Math.abs(mc[0] - 0.05) < 1e-12, `C 原点(45,40) 缩放0.05，实际 ${JSON.stringify(mc)}`);
});

test('含旋转的环闭合差取两预测原点真实距离', () => {
  // A->B 转90°，B->C 平移10mm（世界坐标 C 原点≈(0,10)）；
  // 直接 A->C 转90°且平移 (3,10)，其预测 C 原点=(3,10)，偏差应为 3mm
  const edges = [
    edge(10, 1, 2, 90, 0, 0),
    edge(11, 2, 3, 0, 10, 0)
  ];
  const r = G.checkCycle(nodes, edges,
    { from_shard_id: 1, to_shard_id: 3, rotation: 90, tx_mm: 3, ty_mm: 10 }, 2);
  assert.strictEqual(r.closed, true);
  assert.ok(Math.abs(r.translation_mm - 3) < 1e-9,
    `闭合差应=3mm，实际 ${r.translation_mm}`);
  assert.strictEqual(r.passes, false);
});

function edge(id, f, t, rot, tx, ty) {
  return { id, from_shard_id: f, to_shard_id: t, rotation: rot,
    tx_mm: tx, ty_mm: ty };
}

console.log(`几何自测：${passed} 项全部通过`);
