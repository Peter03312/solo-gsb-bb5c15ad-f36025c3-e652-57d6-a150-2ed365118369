/**
 * shared/geometry.js
 *
 * 陶片拼接推演的核心几何逻辑，浏览器与 Node 后端共用同一份实现，
 * 保证“画布上看到的布局”和“采纳接缝时后端的环校验”完全一致。
 *
 * 坐标约定
 * --------
 * - 每片陶片有自己的局部坐标系（像素原点在照片左上角，x 右、y 下）。
 * - mm_per_px 把局部像素长度换算为毫米，得到该片的“局部毫米坐标”。
 * - 一条已采纳接缝 a -> b 记录毫米空间内的刚体变换：b 的局部毫米点 q_b 满足
 *       q_b = R(theta) * q_a + t
 *   其中角度为度（逆时针为正），t 单位为毫米。
 * - 全局坐标同样以毫米为单位。锚点片的局部毫米坐标即全局坐标。
 *
 * 矩阵统一用行优先的 6 元素仿射矩阵 [a,b,c,d,e,f] 表示：
 *   [ a c e ]
 *   [ b d f ]
 *   [ 0 0 1 ]
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Geometry = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEG = Math.PI / 180;

  function normalizeDeg(deg) {
    let a = ((deg + 180) % 360 + 360) % 360 - 180;
    return a;
  }

  /** 单位矩阵 */
  function identity() {
    return [1, 0, 0, 1, 0, 0];
  }

  /** m1 ∘ m2：先应用 m2 再应用 m1 */
  function multiply(m1, m2) {
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
    ];
  }

  /** 6 元素仿射矩阵求逆（行列式为 0 时返回 null） */
  function invert(m) {
    const det = m[0] * m[3] - m[2] * m[1];
    if (Math.abs(det) < 1e-15) return null;
    const id = 1 / det;
    const a = m[3] * id;
    const b = -m[1] * id;
    const c = -m[2] * id;
    const d = m[0] * id;
    return [
      a,
      b,
      c,
      d,
      -(a * m[4] + c * m[5]),
      -(b * m[4] + d * m[5])
    ];
  }

  /**
   * 把“局部像素坐标 -> 全局毫米坐标”表示为矩阵。
   * 先按 mm_per_px 缩放，再做刚体旋转/平移。
   */
  function localToWorld(mmPerPx, rotationDeg, txMm, tyMm) {
    const s = mmPerPx;
    const th = rotationDeg * DEG;
    const c = Math.cos(th);
    const sn = Math.sin(th);
    // 旋转 ∘ 缩放
    return [c * s, sn * s, -sn * s, c * s, txMm, tyMm];
  }

  /** 用矩阵变换点 */
  function apply(m, x, y) {
    return {
      x: m[0] * x + m[2] * y + m[4],
      y: m[1] * x + m[3] * y + m[5]
    };
  }

  /** 接缝给出的直接相对变换 M_b = E * M_a（毫米空间内的刚体变换，无缩放） */
  function edgeTransform(edge) {
    return localToWorld(1, edge.rotation, edge.tx_mm, edge.ty_mm);
  }

  /**
   * 用已采纳接缝构建邻接表。
   * nodes: [{ id }]
   * edges: [{ id, from_shard_id, to_shard_id, rotation, tx_mm, ty_mm, ... }]
   */
  function buildAdjacency(nodes, edges) {
    const adj = new Map();
    nodes.forEach((n) => adj.set(n.id, []));
    edges.forEach((e) => {
      if (!adj.has(e.from_shard_id) || !adj.has(e.to_shard_id)) return;
      adj.get(e.from_shard_id).push({
        edgeId: e.id,
        from: e.from_shard_id,
        to: e.to_shard_id,
        dir: 1,
        edge: e
      });
      adj.get(e.to_shard_id).push({
        edgeId: e.id,
        from: e.from_shard_id,
        to: e.to_shard_id,
        dir: -1,
        edge: e
      });
    });
    return adj;
  }

  /**
   * 沿接缝链 path（邻接项数组）求刚体变换的乘积。
   *
   * 布局刚体 T 作用于“局部毫米 -> 世界毫米”：
   *   正向（from -> to）：T_to = T_from · X
   *   反向（to -> from）：T_from = T_to · X^-1
   * 因此沿行走方向一律右乘，结果 P 满足 T_end = T_start · P。
   * 纯刚体变换与各片自己的 mm_per_px 缩放无关，故链上复合不涉及缩放。
   */
  function transformAlongPath(path) {
    let m = identity();
    path.forEach((step) => {
      const X = edgeTransform(step.edge);
      m = step.dir === 1 ? multiply(m, X) : multiply(m, invert(X));
    });
    return m;
  }

  /** BFS 求 from 到 to 的接缝链；不可达返回 null */
  function findPath(adj, from, to) {
    if (from === to) return [];
    const queue = [from];
    const prev = new Map([[from, null]]);
    while (queue.length) {
      const cur = queue.shift();
      const steps = adj.get(cur) || [];
      for (const step of steps) {
        const next = step.dir === 1 ? step.to : step.from;
        if (prev.has(next)) continue;
        prev.set(next, { node: cur, step });
        if (next === to) {
          const chain = [];
          let p = prev.get(next);
          while (p) {
            chain.push(p.step);
            p = prev.get(p.node);
          }
          return chain.reverse();
        }
        queue.push(next);
      }
    }
    return null;
  }

  /**
   * 计算全部连通组及每组内各陶片的全局（毫米）布局。
   *
   * 每片陶片的“局部像素 -> 世界毫米”矩阵是刚体与自身比例尺缩放的复合：
   *   M = T · S，S = mm_per_px · I，T 为局部毫米到世界毫米的刚体变换。
   * 接缝约束 T_to = T_from · X 只在毫米空间内传递，与各片像素缩放无关。
   *
   * 每组选第一个陶片（按 nodes 顺序）为锚点，锚点旋转为 0、放在原点。
   *
   * 返回 [{ nodeIds, matrices: Map(id -> M), paths: Map(非锚 id -> 接缝链) }]
   */
  function computeLayout(nodes, edges) {
    const adj = buildAdjacency(nodes, edges);
    const groups = [];
    const seen = new Set();

    nodes.forEach((node) => {
      if (seen.has(node.id)) return;
      const nodeIds = [];
      const matrices = new Map();
      const paths = new Map();

      // 锚点：局部毫米坐标即世界坐标（无旋转、无平移）
      paths.set(node.id, []);
      seen.add(node.id);
      nodeIds.push(node.id);

      const queue = [node.id];
      while (queue.length) {
        const cur = queue.shift();
        const steps = adj.get(cur) || [];
        for (const step of steps) {
          const next = step.dir === 1 ? step.to : step.from;
          if (seen.has(next)) continue;
          seen.add(next);
          nodeIds.push(next);
          paths.set(next, paths.get(cur).concat([step]));
          queue.push(next);
        }
      }

      // 沿接缝链求 T_end = T_anchor · P，再复合本片自身缩放：M = T · S
      nodeIds.forEach((id) => {
        const n = nodes.find((x) => x.id === id);
        const mmPerPx = n.mm_per_px != null ? Number(n.mm_per_px) : 1;
        const rigid = transformAlongPath(paths.get(id));
        matrices.set(id, multiply(rigid, scaleMatrix(mmPerPx)));
      });

      nodeIds.sort((a, b) => {
        const ia = nodes.findIndex((n) => n.id === a);
        const ib = nodes.findIndex((n) => n.id === b);
        return ia - ib;
      });
      groups.push({ nodeIds, matrices, paths });
    });

    return groups;
  }

  /** 均匀缩放 s 的仿射矩阵 */
  function scaleMatrix(s) {
    return [s, 0, 0, s, 0, 0];
  }

  /**
   * 环闭合校验：假设新增一条接缝 cand（from -> to，两端均已标定），
   * 若两端在现有接缝图中已经连通，比较
   *   - 现有接缝链推出的 to 的位置 P_existing
   *   - 新接缝推出的位置 P_new
   * 二者偏差超过 toleranceMm 即拒绝。
   *
   * 返回：
   *   { closed: false }                                  两端此前不连通（新边不形成环）
   *   { closed: true, passes, translation_mm, rotation_deg,
   *     existing_chain: [...], cand, tolerance_mm }      形成环时的闭合差
   */
  function checkCycle(nodes, edges, cand, toleranceMm) {
    const adj = buildAdjacency(nodes, edges);
    if (!adj.has(cand.from_shard_id) || !adj.has(cand.to_shard_id)) {
      return { closed: false };
    }
    const path = findPath(adj, cand.from_shard_id, cand.to_shard_id);
    if (path === null) return { closed: false };

    // 现有链给出 from->to 的毫米刚体 P；新接缝给出 C。
    const P = transformAlongPath(path);
    const C = localToWorld(1, cand.rotation, cand.tx_mm, cand.ty_mm);
    // 把“现有链预测的 to 位姿”映射到“新接缝预测的 to 位姿”：D = P^-1 · C。
    // D 的平移范数 |R_P^T(t_C - t_P)| = |t_C - t_P|（旋转保距），
    // 即两种推算下 to 片原点的真实毫米偏差；与各片像素缩放无关。
    const D = multiply(invert(P), C);
    const translation_mm = Math.hypot(D[4], D[5]);
    const rotation_deg = Math.abs(normalizeDeg(Math.atan2(D[1], D[0]) / DEG));
    return {
      closed: true,
      passes: translation_mm <= toleranceMm,
      translation_mm,
      rotation_deg,
      tolerance_mm: toleranceMm,
      existing_chain: path.map((s) => s.edgeId),
      cand
    };
  }

  /** 陶片四角（及中心）在全局坐标下的位置，用于画布包围盒 */
  function shardWorldCorners(node, matrix) {
    const w = Number(node.image_width) || 0;
    const h = Number(node.image_height) || 0;
    return [
      apply(matrix, 0, 0),
      apply(matrix, w, 0),
      apply(matrix, w, h),
      apply(matrix, 0, h)
    ];
  }

  return {
    DEG,
    normalizeDeg,
    identity,
    multiply,
    invert,
    scaleMatrix,
    localToWorld,
    apply,
    edgeTransform,
    buildAdjacency,
    transformAlongPath,
    findPath,
    computeLayout,
    checkCycle,
    shardWorldCorners
  };
});
