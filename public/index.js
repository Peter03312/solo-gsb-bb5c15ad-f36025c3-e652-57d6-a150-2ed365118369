'use strict';

const api = {
  async listProjects() {
    const res = await fetch('/api/projects');
    if (!res.ok) throw new Error((await res.json()).error.message);
    return res.json();
  },
  async createProject(body) {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error((await res.json()).error.message);
    return res.json();
  }
};

function toast(msg, cls = '') {
  const box = document.getElementById('toast');
  const el = document.createElement('div');
  el.className = `toast ${cls}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function render() {
  const projects = await api.listProjects();
  const list = document.getElementById('list');
  if (!projects.length) {
    list.innerHTML = '<p class="hint">还没有方案，先在上方创建一个。</p>';
    return;
  }
  list.innerHTML = projects.map((p) => `
    <a class="project-item" href="/project.html?id=${p.id}">
      <div class="name">${esc(p.name)}</div>
      <div class="meta">${esc(p.description) || '无备注'}</div>
      <div class="meta" style="margin-top:8px">
        陶片 ${p.shard_count} 片 · 已采纳接缝 ${p.adopted_seam_count} 条 ·
        容差 ${p.tolerance_mm}mm · v${p.version}
      </div>
    </a>`).join('');
}

document.getElementById('createBtn').addEventListener('click', async () => {
  const name = document.getElementById('newName').value.trim();
  if (!name) return toast('请填写方案名称', 'error');
  try {
    const p = await api.createProject({
      name,
      tolerance_mm: Number(document.getElementById('newTol').value),
      description: document.getElementById('newDesc').value
    });
    location.href = `/project.html?id=${p.id}`;
  } catch (e) {
    toast(e.message, 'error');
  }
});

render().catch((e) => toast(e.message, 'error'));
