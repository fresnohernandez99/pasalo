// Envíos y recepciones de archivos (y los textos sueltos de equipos sin
// chat). Cada uno es una tarjeta con su progreso y lo que se puede hacer:
// aceptar, pausar, reanudar, cancelar, abrir.

import { errorText, t } from '../i18n/index.js';
import { emit, on } from '../lib/bus.js';
import { $, esc } from '../lib/dom.js';
import { basename, bytes, clock, duration, label } from '../lib/format.js';
import { icon } from '../lib/icons.js';
import { call, invoke } from '../lib/tauri.js';
import { toast } from '../lib/toast.js';
import { isMobile } from '../state.js';
import { noteTransfer } from './nav.js';

/** clave → transferencia o texto */
export const items = new Map();
let textSeq = 0;
/** Destinos (IP:puerto o código) de equipos que se fueron: lo que se les envía, en pausa. */
const gone = new Set();
// Una transferencia que avanzó hace menos de esto sigue viva aunque el
// descubrimiento de la LAN haya dejado de ver al otro equipo.
const STALL_MS = 5000;

// Estados en los que todavía puede pasar algo.
const LIVE = ['request', 'waiting', 'connecting', 'active', 'retrying', 'paused'];
const FINISHED = ['done', 'error', 'interrupted', 'declined', 'expired', 'cancelled'];

function transfer(id, direction) {
  const key = `t${id}`;
  let tr = items.get(key);
  if (!tr) {
    tr = {
      key, kind: 'transfer', id, direction, peer: '', roots: [], status: 'connecting',
      total: 0, done: 0, resumed: 0, speed: 0, error: null, saved: [], wire: null,
    };
    items.set(key, tr);
  }
  return tr;
}

/** Las que siguen en marcha con un equipo (por su nombre), para enseñarlas en su chat. */
export function liveWith(name) {
  return [...items.values()].filter((i) => i.kind === 'transfer' && i.peer === name && LIVE.includes(i.status));
}

// ---------- enviar ----------

export async function sendPaths(peer, paths) {
  if (!paths || !paths.length) return;
  const id = await call('send', { target: peer.addr, paths });
  const tr = transfer(id, 'outgoing');
  tr.target = peer.addr;
  tr.peer ||= peer.name;
  if (!tr.roots.length) tr.roots = paths.map(basename);
  update(tr);
}

let textPeer = null;

export function openTextDialog(peer) {
  textPeer = peer;
  $('#text-target').textContent = peer.name;
  $('#text-body').value = '';
  $('#text-dialog').showModal();
  if (!isMobile()) $('#text-body').focus();
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

// ---------- tarjetas ----------

function cardElement(item) {
  let el = document.getElementById(item.key);
  if (!el) {
    el = document.createElement('div');
    el.id = item.key;
    el.innerHTML = `
      <div class="ticon"></div>
      <div class="tbody">
        <div class="tline"><span class="ttitle"></span><span class="tstatus"></span></div>
        <div class="tmeta"></div>
        <div class="terror" hidden></div>
        <div class="bar"><div class="fill"></div></div>
        <pre class="ttext" hidden></pre>
        <div class="tactions"></div>
      </div>`;
    $('#transfers').prepend(el);
    noteTransfer();
  }
  $('#transfers-empty').hidden = true;
  return el;
}

function setActions(el, actions) {
  const html = actions
    .map(([act, text, style = 'ghost']) => `<button class="${style} small" data-act="${act}">${esc(text)}</button>`)
    .join('');
  const box = el.querySelector('.tactions');
  // Solo se reemplazan si cambian, para que un clic no caiga entre dos repintados.
  if (box.dataset.html !== html) {
    box.dataset.html = html;
    box.innerHTML = html;
  }
}

/** Qué se puede hacer con una transferencia en su estado actual. */
function actionsFor(tr) {
  const incoming = tr.direction === 'incoming';
  const s = tr.status;
  const a = [];
  if (incoming && s === 'request') a.push(['decline', t('btn.decline')], ['accept', t('btn.accept'), 'primary']);
  if (!incoming && ['connecting', 'active', 'retrying', 'waiting'].includes(s)) a.push(['pause', t('btn.pause')]);
  if (!incoming && ['paused', 'error'].includes(s)) a.push(['resume', t('btn.resume'), 'primary']);
  if (!incoming && LIVE.concat('error').includes(s) && s !== 'request') a.push(['cancel', t('btn.cancel'), 'danger']);
  if (incoming && ['connecting', 'active'].includes(s)) a.push(['cancel', t('btn.cancel'), 'danger']);
  if (incoming && s === 'done' && tr.saved.length && !isMobile()) a.push(['reveal', t('btn.reveal')]);
  if (FINISHED.includes(s)) a.push(['remove', t('btn.remove')]);
  return a;
}

export function update(item) {
  const el = cardElement(item);
  const q = (sel) => el.querySelector(sel);

  if (item.kind === 'text') {
    el.className = 'tcard done';
    q('.ticon').innerHTML = icon('text');
    q('.ttitle').textContent = t('item.text_from', { name: item.from });
    q('.tstatus').textContent = item.time;
    q('.tmeta').hidden = true;
    q('.bar').hidden = true;
    q('.ttext').hidden = false;
    q('.ttext').textContent = item.text;
    setActions(el, [['copy', t('btn.copy')], ['remove', t('btn.remove')]]);
    emit('transfers:changed');
    return;
  }

  const tr = item;
  const incoming = tr.direction === 'incoming';
  el.className = `tcard ${tr.status}`;
  q('.ticon').innerHTML = icon(incoming ? 'download' : 'upload');
  q('.ttitle').textContent = label(tr.roots) || t(incoming ? 'item.receiving' : 'item.sending');

  const pct = tr.total ? Math.min(100, (tr.done / tr.total) * 100) : tr.status === 'done' ? 100 : 0;
  q('.tstatus').textContent = tr.status === 'active' ? `${pct.toFixed(pct < 10 ? 1 : 0)} %` : t(`status.${tr.status}`);
  q('.fill').style.width = `${pct}%`;
  q('.bar').hidden = ['request', 'waiting', 'declined', 'expired', 'cancelled'].includes(tr.status);

  const parts = [];
  if (tr.peer) parts.push(t(incoming ? 'meta.from' : 'meta.to', { peer: tr.peer }));
  if (tr.status === 'request') {
    parts.push(t('meta.request', { size: bytes(tr.total), n: tr.files }));
  } else if (['declined', 'expired', 'cancelled'].includes(tr.status)) {
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
  q('.tmeta').textContent = parts.join(' · ');

  const showError = tr.error && ['retrying', 'error', 'interrupted'].includes(tr.status);
  q('.terror').hidden = !showError;
  q('.terror').textContent = showError
    ? tr.status === 'interrupted'
      ? t('meta.will_resume', { error: errorText(tr.error) })
      : errorText(tr.error)
    : '';

  setActions(el, actionsFor(tr));
  emit('transfers:changed');
}

function removeItem(item) {
  items.delete(item.key);
  document.getElementById(item.key)?.remove();
  if (item.kind === 'transfer' && item.direction === 'outgoing') invoke('forget', { id: item.id });
  $('#transfers-empty').hidden = items.size > 0;
  emit('transfers:changed');
}

// ---------- desconexiones ----------

/** Pausa lo que se envía a un destino. Devuelve si lo pausó. */
async function pauseOne(tr) {
  try {
    await invoke('pause', { id: tr.id });
  } catch {
    return false;
  }
  Object.assign(tr, { status: 'paused', speed: 0, autoPaused: true });
  update(tr);
  return true;
}

/**
 * El equipo con este destino se fue: lo que se le envía queda en pausa y
 * sigue solo cuando vuelva. Con `sure` (la pareja se desconectó) se pausa
 * todo; si no (la LAN dejó de verlo), solo lo que no avanza: el descubrimiento
 * puede perder anuncios mientras la transferencia va bien.
 */
export function pauseFor(target, sure = false) {
  if (!target) return;
  gone.add(target);
  const recent = performance.now() - STALL_MS;
  for (const tr of items.values()) {
    if (tr.kind !== 'transfer' || tr.direction !== 'outgoing' || tr.target !== target) continue;
    if (!['connecting', 'waiting', 'active', 'retrying'].includes(tr.status)) continue;
    if (!sure && tr.status === 'active' && tr.sample && tr.sample.time > recent) continue;
    pauseOne(tr);
  }
}

/** El equipo volvió: sigue lo que se pausó al irse (no lo que pausó el usuario). */
export function resumeFor(target) {
  if (!target || !gone.delete(target)) return;
  for (const tr of items.values()) {
    if (tr.kind !== 'transfer' || tr.target !== target || tr.status !== 'paused' || !tr.autoPaused) continue;
    act(tr, 'resume').catch(() => {});
  }
}

/** Lo que hace cada botón de una tarjeta (aquí y en la tira del chat). */
export async function act(item, action) {
  switch (action) {
    case 'pause':
      await call('pause', { id: item.id });
      Object.assign(item, { status: 'paused', speed: 0, autoPaused: false });
      update(item);
      break;
    case 'resume':
      Object.assign(item, { status: 'connecting', error: null, autoPaused: false });
      update(item);
      await call('resume', { id: item.id });
      break;
    case 'cancel':
      if (item.direction === 'incoming') await call('cancel_incoming', { id: item.id });
      else await call('forget', { id: item.id });
      Object.assign(item, { status: 'cancelled', speed: 0, error: null });
      update(item);
      toast(t('toast.transfer_cancelled'));
      break;
    case 'remove':
      removeItem(item);
      break;
    case 'reveal':
      call('reveal', { path: item.saved[0] });
      break;
    case 'accept':
    case 'decline': {
      const accept = action === 'accept';
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
}

$('#transfers').addEventListener('click', (ev) => {
  const button = ev.target.closest('button[data-act]');
  const item = items.get(ev.target.closest('.tcard')?.id);
  if (button && item) act(item, button.dataset.act).catch(() => {});
});

$('#clear').addEventListener('click', () => {
  for (const item of [...items.values()]) {
    if (item.kind === 'text' || FINISHED.includes(item.status)) removeItem(item);
  }
});

on('lang', () => {
  for (const item of items.values()) update(item);
});

// ---------- eventos del núcleo ----------

export function onTransferEvent(e) {
  switch (e.kind) {
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
      if (['paused', 'cancelled'].includes(tr.status)) break;
      Object.assign(tr, { peer: e.peer, status: 'waiting', error: null });
      update(tr);
      break;
    }
    case 'transfer_started': {
      const tr = transfer(e.id, e.direction);
      if (['paused', 'cancelled'].includes(tr.status)) break;
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
      if (!tr || ['paused', 'cancelled'].includes(tr.status)) break;
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
      if (['paused', 'cancelled'].includes(tr.status)) break;
      tr.error = { code: e.code, detail: e.detail };
      tr.speed = 0;
      tr.status = e.will_retry ? 'retrying' : e.direction === 'incoming' ? 'interrupted' : 'error';
      // Al equipo que se fue no se le insiste: en pausa hasta que vuelva.
      if (e.will_retry && gone.has(tr.target)) {
        update(tr);
        pauseOne(tr);
        break;
      }
      // Un «no» del otro lado no es un error.
      if (e.code === 'rejected' && ['declined', 'timeout', 'busy', 'cancelled'].includes(e.detail)) {
        tr.status = e.detail === 'cancelled' ? 'cancelled' : 'declined';
        tr.error = null;
        const key = { declined: 'toast.declined', timeout: 'toast.no_answer', busy: 'toast.busy', cancelled: 'toast.cancelled_by' }[e.detail];
        toast(t(key, { peer: tr.peer }));
      }
      update(tr);
      break;
    }
    case 'text_received': {
      const item = { key: `x${++textSeq}`, kind: 'text', from: e.from, text: e.text, time: clock(Date.now()) };
      items.set(item.key, item);
      update(item);
      toast(t('toast.text_received', { name: e.from }));
      break;
    }
  }
}
