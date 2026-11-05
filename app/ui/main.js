const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (sel) => document.querySelector(sel);

const peers = new Map(); // device_id → { device_id, name, platform, addr }
const items = new Map(); // clave → transferencia o texto
let selected = null;
let textPeer = null;
let textSeq = 0;
let myCode = null;

const PLATFORMS = {
  macos: 'Mac',
  windows: 'Windows',
  linux: 'Linux',
  android: 'Android',
  ios: 'iPhone',
  manual: 'Añadido a mano',
  remote: 'Remoto',
};

const STATUS = {
  connecting: 'Conectando…',
  retrying: 'Reconectando…',
  paused: 'En pausa',
  interrupted: 'Interrumpida',
  done: 'Completado',
  error: 'Error',
};

// ---------- utilidades ----------

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function bytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return i === 0 ? `${n} B` : `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function duration(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${Math.ceil(seconds)} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${Math.ceil(seconds % 60)} s`;
  return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
}

function basename(path) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function label(paths) {
  const names = paths.map(basename);
  return names.length > 1 ? `${names[0]} y ${names.length - 1} más` : names[0];
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
    toast(String(err), true);
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
    toast('Ese es tu propio código', true);
    return;
  }
  toast('Conectando con el equipo remoto…');
  const hello = await call('probe', { target: code });
  addRemotePeer({ code, name: hello.name, os: hello.platform });
  toast(`Añadido ${hello.name}`);
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
    container.innerHTML = `<div class="empty">Buscando equipos en la red…<br>
      <span>Abre Pasalo en otro equipo conectado a la misma red, o añade uno de otra red con su código.</span></div>`;
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
        <button class="ghost" data-act="files">Archivos</button>
        <button class="ghost" data-act="folder">Carpeta</button>
        <button class="ghost" data-act="text">Texto</button>
        ${['manual', 'remote'].includes(p.platform) ? '<button class="ghost remove" data-act="remove" title="Quitar">✕</button>' : ''}
      </div>
    </div>`,
    )
    .join('');
}

function peerSub(p) {
  if (p.platform === 'remote') {
    const os = PLATFORMS[p.os] || p.os;
    return `${esc(PLATFORMS.remote)}${os ? ` (${esc(os)})` : ''} · <span title="${esc(p.addr)}">${esc(shortCode(p.addr))}</span>`;
  }
  return `${esc(PLATFORMS[p.platform] || p.platform)} · ${esc(p.addr)}`;
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
  toast('Buscando equipos…');
});

// ---------- envío ----------

async function sendPaths(peer, paths) {
  if (!paths || !paths.length) return;
  const id = await call('send', { target: peer.addr, paths });
  const t = transfer(id, 'outgoing');
  t.peer ||= peer.name;
  t.name ||= label(paths);
  update(t);
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
  toast(`Texto enviado a ${textPeer.name}`);
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
    toast('Suelta los archivos encima de un equipo', true);
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
      key, kind: 'transfer', id, direction, peer: '', name: '', status: 'connecting',
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
    q('.title').textContent = `Texto de ${item.from}`;
    q('.status').textContent = item.time;
    q('.meta').hidden = true;
    q('.bar').hidden = true;
    q('.text').hidden = false;
    q('.text').textContent = item.text;
    setButtons(el, [['copy', 'Copiar']]);
    return;
  }

  const t = item;
  const incoming = t.direction === 'incoming';
  el.className = `item ${t.status}`;
  q('.icon').textContent = incoming ? '↓' : '↑';
  q('.title').textContent = t.name || (incoming ? 'Recibiendo…' : 'Enviando…');

  const pct = t.total ? Math.min(100, (t.done / t.total) * 100) : t.status === 'done' ? 100 : 0;
  q('.status').textContent = t.status === 'active' ? `${pct.toFixed(pct < 10 ? 1 : 0)} %` : STATUS[t.status] || '';
  q('.fill').style.width = `${pct}%`;

  const parts = [];
  if (t.peer) parts.push(`${incoming ? 'de' : 'a'} ${t.peer}`);
  if (t.total) parts.push(t.status === 'done' ? bytes(t.total) : `${bytes(t.done)} de ${bytes(t.total)}`);
  if (t.status === 'active' && t.speed > 0) {
    parts.push(`${bytes(t.speed)}/s`);
    const eta = duration((t.total - t.done) / t.speed);
    if (eta) parts.push(`quedan ${eta}`);
  }
  if (t.resumed > 0 && t.status !== 'done') parts.push(`reanudada desde ${bytes(t.resumed)}`);
  q('.meta').textContent = parts.join(' · ');

  const showError = t.error && ['retrying', 'error', 'interrupted'].includes(t.status);
  q('.error').hidden = !showError;
  q('.error').textContent = showError
    ? t.status === 'interrupted'
      ? `${t.error}. Se reanudará cuando el emisor vuelva a enviarlo.`
      : t.error
    : '';

  const buttons = [];
  if (!incoming) {
    if (['connecting', 'active', 'retrying'].includes(t.status)) buttons.push(['pause', 'Pausar']);
    if (['paused', 'error'].includes(t.status)) buttons.push(['resume', 'Reanudar'], ['remove', 'Quitar']);
  }
  if (incoming && t.status === 'done' && t.saved.length) buttons.push(['reveal', 'Mostrar']);
  if (t.status === 'done') buttons.push(['remove', '✕']);
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
      toast('Copiado');
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
      const t = transfer(e.id, e.direction);
      if (t.status === 'paused') break;
      Object.assign(t, {
        peer: e.peer,
        name: e.name || t.name,
        total: e.total_bytes,
        done: e.resumed_bytes,
        resumed: e.resumed_bytes,
        status: 'active',
        error: null,
        speed: 0,
        sample: null,
      });
      update(t);
      break;
    }

    case 'progress': {
      const t = items.get(`t${e.id}`);
      if (!t || t.status === 'paused') break;
      const now = performance.now();
      if (t.sample) {
        const dt = (now - t.sample.time) / 1000;
        if (dt > 0) {
          const instant = (e.done_bytes - t.sample.done) / dt;
          t.speed = t.speed ? t.speed * 0.8 + instant * 0.2 : instant;
        }
      }
      t.sample = { time: now, done: e.done_bytes };
      t.done = e.done_bytes;
      t.total = e.total_bytes;
      if (t.status !== 'done') t.status = 'active';
      update(t);
      break;
    }

    case 'transfer_finished': {
      const t = transfer(e.id, e.direction);
      Object.assign(t, { status: 'done', done: t.total, saved: e.saved, error: null });
      update(t);
      if (e.direction === 'incoming') toast(`Recibido ${t.name} de ${t.peer}`);
      break;
    }

    case 'transfer_failed': {
      const t = transfer(e.id, e.direction);
      if (t.status === 'paused') break;
      t.error = e.error;
      t.speed = 0;
      t.status = e.will_retry ? 'retrying' : e.direction === 'incoming' ? 'interrupted' : 'error';
      update(t);
      break;
    }

    case 'text_received': {
      const item = {
        key: `x${++textSeq}`,
        kind: 'text',
        from: e.from,
        text: e.text,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      items.set(item.key, item);
      update(item);
      toast(`Texto recibido de ${e.from}`);
      break;
    }
  }
});

// ---------- ajustes ----------

function showSettings(s) {
  $('#me-name').value = s.name;
  $('#me-avatar').textContent = initials(s.name);
  const ips = s.ips.length ? s.ips.join(', ') : 'sin red';
  $('#me-sub').textContent = `IP ${ips} · puerto ${s.port}`;
  $('#dir-label').textContent = s.dir;
  $('#open-dir').title = `Abrir ${s.dir}`;
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
  toast('Nombre actualizado');
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
  toast('Código copiado: pásaselo a quien te vaya a enviar algo');
});
$('#change-dir').addEventListener('click', async () => {
  const dir = await call('choose_dir');
  if (dir) $('#dir-label').textContent = dir;
});

async function init() {
  const s = await call('snapshot');
  showSettings(s);
  $('#me-name').dataset.saved = s.name;
  for (const p of s.peers) peers.set(p.device_id, p);
  loadManualPeers();
  loadRemotePeers();
  renderPeers();
}

init();
