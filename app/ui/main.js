const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (sel) => document.querySelector(sel);

const peers = new Map(); // device_id → { device_id, name, platform, addr }
const items = new Map(); // clave → transferencia o texto
let selected = null;
let textPeer = null;
let textSeq = 0;
let myCode = null;
let settings = null;

const PLATFORMS = {
  macos: 'Mac',
  windows: 'Windows',
  linux: 'Linux',
  android: 'Android',
  ios: 'iPhone',
};

function platformName(platform) {
  if (platform === 'manual' || platform === 'remote') return t(`platform.${platform}`);
  return PLATFORMS[platform] || platform;
}

// ---------- utilidades ----------

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function bytes(n) {
  const units = t('units.bytes').split(' ');
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return i === 0 ? `${n} B` : `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function duration(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return t('dur.s', { n: Math.ceil(seconds) });
  if (seconds < 3600) return t('dur.min', { m: Math.floor(seconds / 60), s: Math.ceil(seconds % 60) });
  return t('dur.h', { h: Math.floor(seconds / 3600), m: Math.floor((seconds % 3600) / 60) });
}

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
}

function basename(path) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function label(names) {
  return names.length > 1 ? t('label.more', { first: names[0], n: names.length - 1 }) : names[0] || '';
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = isError ? 'toast error' : 'toast';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 3500);
}

async function call(command, args) {
  try {
    return await invoke(command, args);
  } catch (err) {
    toast(errorText(err), true);
    throw err;
  }
}

// ---------- equipos ----------

function loadManualPeers() {
  try {
    for (const addr of JSON.parse(localStorage.getItem('manualPeers') || '[]')) addManualPeer(addr, false);
  } catch {}
}

function saveManualPeers() {
  const addrs = [...peers.values()].filter((p) => p.platform === 'manual').map((p) => p.addr);
  try {
    localStorage.setItem('manualPeers', JSON.stringify(addrs));
  } catch {}
}

// Los remotos se guardan con nombre: al añadirlos se pregunta al otro equipo.
function loadRemotePeers() {
  try {
    for (const p of JSON.parse(localStorage.getItem('remotePeers') || '[]')) addRemotePeer(p, false);
  } catch {}
}

function saveRemotePeers() {
  const list = [...peers.values()]
    .filter((p) => p.platform === 'remote')
    .map(({ addr, name, os }) => ({ code: addr, name, os }));
  try {
    localStorage.setItem('remotePeers', JSON.stringify(list));
  } catch {}
}

function addRemotePeer({ code, name, os }, save = true) {
  peers.set(`remote:${code}`, { device_id: `remote:${code}`, name, platform: 'remote', os, addr: code });
  if (save) saveRemotePeers();
  renderPeers();
}

function isCode(value) {
  return /^[0-9a-z]{52,64}$/i.test(value.replace(/\s/g, ''));
}

function shortCode(code) {
  return `${code.slice(0, 6)}…${code.slice(-4)}`;
}

async function addByCode(input) {
  const code = input.replace(/\s/g, '').toLowerCase();
  if (code === myCode) {
    toast(t('toast.own_code'), true);
    return;
  }
  toast(t('toast.connecting_remote'));
  const hello = await call('probe', { target: code });
  addRemotePeer({ code, name: hello.name, os: hello.platform });
  toast(t('toast.added', { name: hello.name }));
}

function addManualPeer(input, save = true) {
  const value = input.trim();
  if (!value) return;
  const addr = value.includes(':') && !value.includes('::') ? value : `${value}:4646`;
  peers.set(`manual:${addr}`, { device_id: `manual:${addr}`, name: value.split(':')[0], platform: 'manual', addr });
  if (save) saveManualPeers();
  renderPeers();
}

function renderPeers() {
  const list = [...peers.values()].sort((a, b) => a.name.localeCompare(b.name));
  const container = $('#peers');
  if (!list.length) {
    container.innerHTML = `<div class="empty">${esc(t('peers.empty'))}<br>
      <span>${esc(t('peers.empty_hint'))}</span></div>`;
    return;
  }
  container.innerHTML = list
    .map(
      (p) => `
    <div class="peer ${p.device_id === selected ? 'selected' : ''}" data-id="${esc(p.device_id)}">
      <div class="avatar">${esc(initials(p.name))}</div>
      <div class="info">
        <div class="pname">${esc(p.name)}</div>
        <div class="sub">${peerSub(p)}</div>
      </div>
      <div class="peer-actions">
        <button class="ghost" data-act="files">${esc(t('btn.files'))}</button>
        <button class="ghost" data-act="folder">${esc(t('btn.folder'))}</button>
        <button class="ghost" data-act="text">${esc(t('btn.text'))}</button>
        ${['manual', 'remote'].includes(p.platform) ? `<button class="ghost remove" data-act="remove" title="${esc(t('btn.remove'))}">✕</button>` : ''}
      </div>
    </div>`,
    )
    .join('');
}

function peerSub(p) {
  if (p.platform === 'remote') {
    const os = p.os ? platformName(p.os) : '';
    return `${esc(platformName('remote'))}${os ? ` (${esc(os)})` : ''} · <span title="${esc(p.addr)}">${esc(shortCode(p.addr))}</span>`;
  }
  return `${esc(platformName(p.platform))} · ${esc(p.addr)}`;
}

$('#peers').addEventListener('click', async (ev) => {
  const card = ev.target.closest('.peer');
  if (!card) return;
  const peer = peers.get(card.dataset.id);
  if (!peer) return;
  selected = peer.device_id;
  const act = ev.target.closest('button')?.dataset.act;
  if (act === 'files') {
    sendPaths(peer, await call('pick_files'));
  } else if (act === 'folder') {
    const folder = await call('pick_folder');
    if (folder) sendPaths(peer, [folder]);
  } else if (act === 'text') {
    openTextDialog(peer);
  } else if (act === 'remove') {
    peers.delete(peer.device_id);
    saveManualPeers();
    saveRemotePeers();
  }
  renderPeers();
});

$('#manual').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const value = $('#manual-ip').value.trim();
  if (!value) return;
  if (isCode(value)) {
    await addByCode(value);
  } else {
    addManualPeer(value);
  }
  $('#manual-ip').value = '';
});

$('#refresh').addEventListener('click', () => {
  call('refresh');
  toast(t('toast.searching'));
});

// ---------- envío ----------

async function sendPaths(peer, paths) {
  if (!paths || !paths.length) return;
  const id = await call('send', { target: peer.addr, paths });
  const tr = transfer(id, 'outgoing');
  tr.peer ||= peer.name;
  if (!tr.roots.length) tr.roots = paths.map(basename);
  update(tr);
}

function openTextDialog(peer) {
  textPeer = peer;
  $('#text-target').textContent = peer.name;
  $('#text-body').value = '';
  $('#text-dialog').showModal();
  $('#text-body').focus();
}

$('#text-cancel').addEventListener('click', () => $('#text-dialog').close());

$('#text-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const text = $('#text-body').value;
  if (!text.trim() || !textPeer) return;
  $('#text-dialog').close();
  await call('send_text', { target: textPeer.addr, text });
  toast(t('toast.text_sent', { name: textPeer.name }));
});

// Arrastrar y soltar: Tauri da la posición en píxeles físicos.
function peerAt(position) {
  const ratio = window.devicePixelRatio || 1;
  return document.elementFromPoint(position.x / ratio, position.y / ratio)?.closest('.peer') || null;
}

function highlight(card) {
  document.querySelectorAll('.peer.drop').forEach((el) => el !== card && el.classList.remove('drop'));
  card?.classList.add('drop');
}

listen('tauri://drag-enter', () => document.body.classList.add('dragging'));
listen('tauri://drag-over', (ev) => highlight(peerAt(ev.payload.position)));
listen('tauri://drag-leave', () => {
  document.body.classList.remove('dragging');
  highlight(null);
});
listen('tauri://drag-drop', (ev) => {
  document.body.classList.remove('dragging');
  const card = peerAt(ev.payload.position);
  highlight(null);
  const fallback = peers.size === 1 ? [...peers.keys()][0] : selected;
  const peer = peers.get(card?.dataset.id ?? fallback);
  if (!peer) {
    toast(t('toast.drop_on_peer'), true);
    return;
  }
  selected = peer.device_id;
  renderPeers();
  sendPaths(peer, ev.payload.paths);
});

// ---------- actividad ----------

function transfer(id, direction) {
  const key = `t${id}`;
  let t = items.get(key);
  if (!t) {
    t = {
      key, kind: 'transfer', id, direction, peer: '', roots: [], status: 'connecting',
      total: 0, done: 0, resumed: 0, speed: 0, error: null, saved: [],
    };
    items.set(key, t);
  }
  return t;
}

function itemElement(item) {
  let el = document.getElementById(item.key);
  if (!el) {
    el = document.createElement('div');
    el.id = item.key;
    el.innerHTML = `
      <div class="icon"></div>
      <div class="body">
        <div class="line"><span class="title"></span><span class="status"></span></div>
        <div class="meta"></div>
        <div class="error" hidden></div>
        <div class="bar"><div class="fill"></div></div>
        <pre class="text" hidden></pre>
      </div>
      <div class="buttons"></div>`;
    $('#activity').prepend(el);
    $('#activity-empty').hidden = true;
  }
  return el;
}

function setButtons(el, buttons) {
  const html = buttons.map(([act, text]) => `<button class="ghost small" data-act="${act}">${text}</button>`).join('');
  const box = el.querySelector('.buttons');
  // Solo se reemplazan si cambian, para que un clic no caiga entre dos renders.
  if (box.dataset.html !== html) {
    box.dataset.html = html;
    box.innerHTML = html;
  }
}

function update(item) {
  const el = itemElement(item);
  const q = (sel) => el.querySelector(sel);

  if (item.kind === 'text') {
    el.className = 'item done';
    q('.icon').textContent = 'T';
    q('.title').textContent = t('item.text_from', { name: item.from });
    q('.status').textContent = item.time;
    q('.meta').hidden = true;
    q('.bar').hidden = true;
    q('.text').hidden = false;
    q('.text').textContent = item.text;
    setButtons(el, [['copy', t('btn.copy')]]);
    return;
  }

  const tr = item;
  const incoming = tr.direction === 'incoming';
  el.className = `item ${tr.status}`;
  q('.icon').textContent = incoming ? '↓' : '↑';
  q('.title').textContent = label(tr.roots) || t(incoming ? 'item.receiving' : 'item.sending');

  const pct = tr.total ? Math.min(100, (tr.done / tr.total) * 100) : tr.status === 'done' ? 100 : 0;
  q('.status').textContent = tr.status === 'active' ? `${pct.toFixed(pct < 10 ? 1 : 0)} %` : t(`status.${tr.status}`);
  q('.fill').style.width = `${pct}%`;

  const parts = [];
  if (tr.peer) parts.push(t(incoming ? 'meta.from' : 'meta.to', { peer: tr.peer }));
  if (tr.total) {
    parts.push(tr.status === 'done' ? bytes(tr.total) : t('meta.progress', { done: bytes(tr.done), total: bytes(tr.total) }));
  }
  if (tr.status === 'active' && tr.speed > 0) {
    parts.push(`${bytes(tr.speed)}/s`);
    const eta = duration((tr.total - tr.done) / tr.speed);
    if (eta) parts.push(t('meta.left', { eta }));
  }
  if (tr.resumed > 0 && tr.status !== 'done') parts.push(t('meta.resumed', { size: bytes(tr.resumed) }));
  q('.meta').textContent = parts.join(' · ');

  const showError = tr.error && ['retrying', 'error', 'interrupted'].includes(tr.status);
  q('.error').hidden = !showError;
  q('.error').textContent = showError
    ? tr.status === 'interrupted'
      ? t('meta.will_resume', { error: errorText(tr.error) })
      : errorText(tr.error)
    : '';

  const buttons = [];
  if (!incoming) {
    if (['connecting', 'active', 'retrying'].includes(tr.status)) buttons.push(['pause', t('btn.pause')]);
    if (['paused', 'error'].includes(tr.status)) buttons.push(['resume', t('btn.resume')], ['remove', t('btn.remove')]);
  }
  if (incoming && tr.status === 'done' && tr.saved.length) buttons.push(['reveal', t('btn.reveal')]);
  if (tr.status === 'done') buttons.push(['remove', '✕']);
  setButtons(el, buttons);
}

function removeItem(item) {
  items.delete(item.key);
  document.getElementById(item.key)?.remove();
  if (item.kind === 'transfer' && item.direction === 'outgoing') invoke('forget', { id: item.id });
  $('#activity-empty').hidden = items.size > 0;
}

$('#activity').addEventListener('click', async (ev) => {
  const button = ev.target.closest('button');
  const item = items.get(ev.target.closest('.item')?.id);
  if (!button || !item) return;
  switch (button.dataset.act) {
    case 'pause':
      await call('pause', { id: item.id });
      item.status = 'paused';
      item.speed = 0;
      update(item);
      break;
    case 'resume':
      item.status = 'connecting';
      item.error = null;
      update(item);
      await call('resume', { id: item.id });
      break;
    case 'remove':
      removeItem(item);
      break;
    case 'reveal':
      call('reveal', { path: item.saved[0] });
      break;
    case 'copy':
      await navigator.clipboard.writeText(item.text);
      toast(t('toast.copied'));
      break;
  }
});

$('#clear').addEventListener('click', () => {
  for (const item of [...items.values()]) {
    if (item.kind === 'text' || ['done', 'error', 'interrupted'].includes(item.status)) removeItem(item);
  }
});

// ---------- eventos del núcleo ----------

listen('pasalo', ({ payload: e }) => {
  switch (e.kind) {
    case 'peer_found':
      peers.set(e.device_id, { device_id: e.device_id, name: e.name, platform: e.platform, addr: e.addr });
      renderPeers();
      break;

    case 'peer_lost':
      peers.delete(e.device_id);
      renderPeers();
      break;

    case 'transfer_started': {
      const tr = transfer(e.id, e.direction);
      if (tr.status === 'paused') break;
      Object.assign(tr, {
        peer: e.peer,
        roots: e.roots.length ? e.roots : tr.roots,
        total: e.total_bytes,
        done: e.resumed_bytes,
        resumed: e.resumed_bytes,
        status: 'active',
        error: null,
        speed: 0,
        sample: null,
      });
      update(tr);
      break;
    }

    case 'progress': {
      const tr = items.get(`t${e.id}`);
      if (!tr || tr.status === 'paused') break;
      const now = performance.now();
      if (tr.sample) {
        const dt = (now - tr.sample.time) / 1000;
        if (dt > 0) {
          const instant = (e.done_bytes - tr.sample.done) / dt;
          tr.speed = tr.speed ? tr.speed * 0.8 + instant * 0.2 : instant;
        }
      }
      tr.sample = { time: now, done: e.done_bytes };
      tr.done = e.done_bytes;
      tr.total = e.total_bytes;
      if (tr.status !== 'done') tr.status = 'active';
      update(tr);
      break;
    }

    case 'transfer_finished': {
      const tr = transfer(e.id, e.direction);
      Object.assign(tr, { status: 'done', done: tr.total, saved: e.saved, error: null });
      update(tr);
      if (e.direction === 'incoming') toast(t('toast.received', { name: label(tr.roots), peer: tr.peer }));
      break;
    }

    case 'transfer_failed': {
      const tr = transfer(e.id, e.direction);
      if (tr.status === 'paused') break;
      tr.error = { code: e.code, detail: e.detail };
      tr.speed = 0;
      tr.status = e.will_retry ? 'retrying' : e.direction === 'incoming' ? 'interrupted' : 'error';
      update(tr);
      break;
    }

    case 'text_received': {
      const item = {
        key: `x${++textSeq}`,
        kind: 'text',
        from: e.from,
        text: e.text,
        time: new Date().toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' }),
      };
      items.set(item.key, item);
      update(item);
      toast(t('toast.text_received', { name: e.from }));
      break;
    }
  }
});

// ---------- ajustes ----------

function showSettings(s) {
  settings = s;
  $('#me-name').value = s.name;
  $('#me-avatar').textContent = initials(s.name);
  const ips = s.ips.length ? s.ips.join(', ') : t('me.no_network');
  $('#me-sub').textContent = t('me.sub', { ips, port: s.port });
  $('#dir-label').textContent = s.dir;
  $('#open-dir').title = t('dir.open_title', { dir: s.dir });
  document.body.classList.toggle('mobile', s.mobile);
  myCode = s.code;
  $('#code-line').hidden = !s.code;
  if (s.code) $('#me-code').textContent = shortCode(s.code);
}

async function saveName() {
  const input = $('#me-name');
  const name = input.value.trim();
  if (!name || name === input.dataset.saved) {
    input.value = input.dataset.saved || '';
    return;
  }
  await call('set_name', { name });
  input.dataset.saved = name;
  $('#me-avatar').textContent = initials(name);
  settings.name = name;
  toast(t('toast.name_updated'));
}

$('#me-name').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') ev.target.blur();
  if (ev.key === 'Escape') {
    ev.target.value = ev.target.dataset.saved || '';
    ev.target.blur();
  }
});
$('#me-name').addEventListener('blur', saveName);
$('#open-dir').addEventListener('click', () => call('open_dir'));
$('#copy-code').addEventListener('click', async () => {
  await navigator.clipboard.writeText(myCode);
  toast(t('toast.code_copied'));
});
$('#change-dir').addEventListener('click', async () => {
  const dir = await call('choose_dir');
  if (dir) showSettings({ ...settings, dir });
});

// ---------- idioma ----------

function fillLangSelect() {
  $('#lang').innerHTML = Object.keys(LANGS)
    .map((code) => `<option value="${code}" ${code === lang ? 'selected' : ''}>${esc(LANGS[code]['lang.name'])}</option>`)
    .join('');
}

$('#lang').addEventListener('change', (ev) => {
  setLang(ev.target.value);
  if (settings) showSettings(settings);
  renderPeers();
  for (const item of items.values()) update(item);
});

async function init() {
  applyStatic();
  fillLangSelect();
  const s = await call('snapshot');
  showSettings(s);
  $('#me-name').dataset.saved = s.name;
  for (const p of s.peers) peers.set(p.device_id, p);
  loadManualPeers();
  loadRemotePeers();
  renderPeers();
}

init();
