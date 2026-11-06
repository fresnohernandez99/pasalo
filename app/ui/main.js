const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (sel) => document.querySelector(sel);

// En el móvil no hay consola a mano: un error de JavaScript se ve como aviso.
window.addEventListener('error', (ev) => toast(`JS: ${ev.message}`, true));
window.addEventListener('unhandledrejection', (ev) => {
  const reason = ev.reason;
  if (reason && typeof reason === 'object' && 'code' in reason) return; // ya lo mostró call()
  toast(`JS: ${reason?.message || reason}`, true);
});

const peers = new Map(); // device_id → { device_id, name, platform, addr, code }
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
  if (['manual', 'remote', 'partner'].includes(platform)) return t(`platform.${platform}`);
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

// Iconos del tipo de equipo (trazo de 24×24, toman el color del texto).
const DEVICE_ICONS = {
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18h2"/>',
  laptop: '<rect x="5" y="4.5" width="14" height="10" rx="1.5"/><path d="M2.5 18.5h19"/>',
  desktop: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
};
const DEVICE_KIND = { android: 'phone', ios: 'phone', macos: 'laptop', windows: 'desktop', linux: 'desktop' };

/** Avatar con las iniciales y, en la esquina, el icono del tipo de equipo. */
function avatar(name, os) {
  const kind = DEVICE_KIND[os];
  const badge = kind
    ? `<span class="device" title="${esc(platformName(os))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${DEVICE_ICONS[kind]}</svg></span>`
    : '';
  return `<div class="avatar">${esc(initials(name))}${badge}</div>`;
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

// Equipo de otra red: la pareja del server, o alguien que escribió por el
// chat sin estar en la lista. No se guardan: al abrir la app se empieza
// desconectado.
function addRemotePeer({ code, name, os, partner = false }) {
  const key = partner ? 'partner' : `remote:${code}`;
  peers.set(key, { device_id: key, name, platform: partner ? 'partner' : 'remote', os, addr: code });
  renderPeers();
}

function isCode(value) {
  return /^[0-9a-z]{52,64}$/i.test(value.replace(/\s/g, ''));
}

function shortCode(code) {
  return `${code.slice(0, 6)}…${code.slice(-4)}`;
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
  // La pareja, si además está en la LAN, sale una sola vez (como pareja).
  const partner = peers.get('partner')?.addr;
  const list = [...peers.values()]
    .filter((p) => p.platform === 'partner' || !partner || p.code !== partner)
    .sort((a, b) => (b.platform === 'partner') - (a.platform === 'partner') || a.name.localeCompare(b.name));
  const html = list.length
    ? list.map(peerCard).join('')
    : `<div class="empty">${esc(t('peers.empty'))}<br><span>${esc(t('peers.empty_hint'))}</span></div>`;
  setHtml($('#peers'), html);
}

/** Cambia el contenido solo si cambió: los eventos llegan a menudo sin novedades. */
function setHtml(el, html) {
  if (el.dataset.html === html) return;
  el.dataset.html = html;
  el.innerHTML = html;
}

function peerCard(p) {
  return `
    <div class="peer ${p.device_id === selected ? 'selected' : ''}" data-id="${esc(p.device_id)}" title="${esc(peerTitle(p))}">
      ${avatar(p.name, p.os || p.platform)}
      <div class="info"><div class="pname">${esc(p.name)}</div></div>
      <div class="peer-actions">
        <button class="ghost" data-act="files">${esc(t('btn.files'))}</button>
        <button class="ghost" data-act="folder">${esc(t('btn.folder'))}</button>
        ${chatButton(p)}
        ${['manual', 'remote'].includes(p.platform) ? `<button class="ghost remove" data-act="remove" title="${esc(t('btn.remove'))}">✕</button>` : ''}
      </div>
    </div>`;
}

// Con código se chatea (cifrado, con historial y llamadas); sin él (equipos
// añadidos por IP o versiones viejas) queda el texto suelto de siempre.
function chatButton(p) {
  const code = peerCode(p);
  if (!code) return `<button class="ghost" data-act="text">${esc(t('btn.text'))}</button>`;
  const unread = chat.unread.get(code) || 0;
  const badge = unread ? ` <span class="badge">${unread}</span>` : '';
  return `<button class="ghost" data-act="chat">${esc(t('btn.chat'))}${badge}</button>`;
}

// La tarjeta solo enseña nombre y tipo de equipo; el detalle, al pasar el ratón.
function peerTitle(p) {
  return `${platformName(p.platform)} · ${p.addr}`;
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
  } else if (act === 'chat') {
    openChat(peer);
  } else if (act === 'remove') {
    peers.delete(peer.device_id);
    saveManualPeers();
  }
  renderPeers();
});

// Añadir por IP: botón flotante → campo con Aceptar y Cancelar.
$('#add-fab').addEventListener('click', () => {
  $('#manual-ip').value = '';
  $('#add-dialog').showModal();
  $('#manual-ip').focus();
});
$('#add-cancel').addEventListener('click', () => $('#add-dialog').close());
$('#manual').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const value = $('#manual-ip').value.trim();
  if (!value) return;
  // A otras redes se llega con «Conectarse», no pegando códigos.
  if (isCode(value)) {
    toast(t('toast.use_connect'), true);
    return;
  }
  addManualPeer(value);
  $('#add-dialog').close();
});

// Pantalla de Ajustes.
$('#open-settings').addEventListener('click', () => {
  $('#set-server').value = settings?.server || '';
  fillTalkSettings();
  $('#settings').hidden = false;
});
$('#settings-close').addEventListener('click', () => ($('#settings').hidden = true));

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
      total: 0, done: 0, resumed: 0, speed: 0, error: null, saved: [], wire: null,
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
    noteActivity();
  }
  return el;
}

// ---------- pestañas (solo en pantallas estrechas) ----------

let unseenActivity = 0;

function activityVisible() {
  return getComputedStyle($('.activity-panel')).display !== 'none';
}

/** Algo nuevo en la actividad: si no se está viendo, se cuenta en su pestaña. */
function noteActivity() {
  if (activityVisible()) return;
  unseenActivity++;
  $('#activity-badge').textContent = unseenActivity;
  $('#activity-badge').hidden = false;
}

function showTab(tab) {
  document.body.dataset.tab = tab;
  for (const el of document.querySelectorAll('.tab')) el.classList.toggle('on', el.dataset.tab === tab);
  if (tab === 'activity') {
    unseenActivity = 0;
    $('#activity-badge').hidden = true;
  }
}

// Botón Atrás de Android (lo llama PasaloPlugin.kt): cierra lo de más arriba
// y dice si había algo. Si no, la app pasa al fondo sin perder nada.
window.pasaloBack = () => {
  const dialog = document.querySelector('dialog[open]');
  if (dialog) {
    dialog.close();
    return true;
  }
  // En una llamada, Atrás no cuelga: hay que pulsar Colgar.
  if (!$('#call').hidden) return true;
  if (!$('#settings').hidden) {
    $('#settings').hidden = true;
    return true;
  }
  if (!$('#chat').hidden) {
    closeChat();
    return true;
  }
  if (document.body.dataset.tab === 'activity' && getComputedStyle($('.tabbar')).display !== 'none') {
    showTab('peers');
    return true;
  }
  return false;
};

$('.tabbar').addEventListener('click', (ev) => {
  const tab = ev.target.closest('.tab');
  if (tab) showTab(tab.dataset.tab);
});
showTab('peers');

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
  q('.bar').hidden = ['request', 'waiting', 'declined', 'expired'].includes(tr.status);

  const parts = [];
  if (tr.peer) parts.push(t(incoming ? 'meta.from' : 'meta.to', { peer: tr.peer }));
  if (tr.status === 'request') {
    parts.push(t('meta.request', { size: bytes(tr.total), n: tr.files }));
  } else if (['declined', 'expired'].includes(tr.status)) {
    if (tr.total) parts.push(bytes(tr.total));
  } else if (tr.total) {
    parts.push(tr.status === 'done' ? bytes(tr.total) : t('meta.progress', { done: bytes(tr.done), total: bytes(tr.total) }));
  }
  // Lo que ahorró la compresión (o la reanudación) en la red.
  if (tr.status === 'done' && tr.wire !== null && tr.total && tr.wire < tr.total * 0.95) {
    parts.push(t('meta.wire', { size: bytes(tr.wire) }));
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
  if (incoming && tr.status === 'request') buttons.push(['decline', t('btn.decline')], ['accept', t('btn.accept')]);
  if (!incoming) {
    if (['connecting', 'active', 'retrying', 'waiting'].includes(tr.status)) buttons.push(['pause', t('btn.pause')]);
    if (['paused', 'error'].includes(tr.status)) buttons.push(['resume', t('btn.resume')], ['remove', t('btn.remove')]);
    if (tr.status === 'declined') buttons.push(['remove', '✕']);
  }
  if (incoming && ['declined', 'expired'].includes(tr.status)) buttons.push(['remove', '✕']);
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
    case 'accept':
    case 'decline': {
      const accept = button.dataset.act === 'accept';
      const waiting = await call('transfer_decide', { id: item.id, accept });
      item.status = !waiting ? 'expired' : accept ? 'connecting' : 'declined';
      update(item);
      break;
    }
    case 'copy':
      await navigator.clipboard.writeText(item.text);
      toast(t('toast.copied'));
      break;
  }
});

$('#clear').addEventListener('click', () => {
  for (const item of [...items.values()]) {
    if (item.kind === 'text' || ['done', 'error', 'interrupted', 'declined', 'expired'].includes(item.status)) removeItem(item);
  }
});

// ---------- eventos del núcleo ----------

listen('pasalo', ({ payload: e }) => {
  switch (e.kind) {
    case 'peer_found':
      peers.set(e.device_id, { device_id: e.device_id, name: e.name, platform: e.platform, addr: e.addr, code: e.code });
      renderPeers();
      break;

    case 'peer_lost':
      peers.delete(e.device_id);
      renderPeers();
      break;

    case 'transfer_request': {
      const tr = transfer(e.id, 'incoming');
      Object.assign(tr, { peer: e.peer, roots: e.roots, total: e.total_bytes, files: e.files, status: 'request', error: null });
      update(tr);
      toast(t('toast.request', { peer: e.peer, name: label(e.roots) }));
      break;
    }

    case 'request_closed': {
      const tr = items.get(`t${e.id}`);
      if (!tr || tr.status !== 'request') break;
      tr.status = 'expired';
      update(tr);
      break;
    }

    case 'transfer_waiting': {
      const tr = transfer(e.id, 'outgoing');
      if (tr.status === 'paused') break;
      Object.assign(tr, { peer: e.peer, status: 'waiting', error: null });
      update(tr);
      break;
    }

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
      Object.assign(tr, { status: 'done', done: tr.total, saved: e.saved, error: null, wire: e.wire_bytes });
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
      // Un «no» del otro lado no es un error.
      if (e.code === 'rejected' && ['declined', 'timeout', 'busy'].includes(e.detail)) {
        tr.status = 'declined';
        tr.error = null;
        const key = { declined: 'toast.declined', timeout: 'toast.no_answer', busy: 'toast.busy' }[e.detail];
        toast(t(key, { peer: tr.peer }));
      }
      update(tr);
      break;
    }

    case 'chat':
      onChatEvent(e);
      break;

    case 'signal':
      onSignal(e);
      break;

    case 'lobby_users':
    case 'lobby_request':
    case 'lobby_request_gone':
    case 'lobby_answer':
    case 'lobby_paired':
    case 'lobby_error':
      onLobbyEvent(e);
      break;

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
  initNet(s);
  renderPeers();
}

// Después de cargar todos los scripts: talk.js define cosas que usa renderPeers().
window.addEventListener('DOMContentLoaded', init);
