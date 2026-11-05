// Chat, llamadas de voz (las hace Rust) y videollamadas (WebRTC aquí).
// Todo va por el canal cifrado de iroh con el código de cada equipo; WebRTC
// solo usa STUN/TURN para que el vídeo llegue directo.

const chat = {
  peer: null, // { code, name }
  messages: new Map(), // código → [mensaje]
  unread: new Map(), // código → número
};
const imageCache = new Map(); // ruta → data URL

const VOICE_MODES = [
  ['high', 45],
  ['normal', 23],
  ['low', 15],
  ['minimum', 6],
];
const VIDEO_PRESETS = {
  low: { width: 320, height: 240, fps: 12, kbps: 150 },
  normal: { width: 640, height: 480, fps: 20, kbps: 500 },
  high: { width: 1280, height: 720, fps: 30, kbps: 1500 },
};
const RING_TIMEOUT = 45_000;

let call = null;

// ---------- ajustes (TURN y modo por defecto) ----------

function talkSettings() {
  try {
    return { voiceMode: 'normal', videoQuality: 'normal', turn: '', turnUser: '', turnPass: '', ...JSON.parse(localStorage.getItem('talk') || '{}') };
  } catch {
    return { voiceMode: 'normal', videoQuality: 'normal', turn: '', turnUser: '', turnPass: '' };
  }
}

function saveTalkSettings(patch) {
  try {
    localStorage.setItem('talk', JSON.stringify({ ...talkSettings(), ...patch }));
  } catch {}
}

function iceServers() {
  const s = talkSettings();
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (s.turn.trim()) servers.push({ urls: s.turn.trim(), username: s.turnUser, credential: s.turnPass });
  return servers;
}

function openSettings() {
  const s = talkSettings();
  $('#set-turn').value = s.turn;
  $('#set-turn-user').value = s.turnUser;
  $('#set-turn-pass').value = s.turnPass;
  fillVoiceModes($('#set-voice-mode'), s.voiceMode);
  $('#settings-dialog').showModal();
}

$('#open-settings').addEventListener('click', openSettings);
$('#settings-cancel').addEventListener('click', () => $('#settings-dialog').close());
$('#settings-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  saveTalkSettings({
    turn: $('#set-turn').value,
    turnUser: $('#set-turn-user').value,
    turnPass: $('#set-turn-pass').value,
    voiceMode: $('#set-voice-mode').value,
  });
  $('#settings-dialog').close();
  toast(t('toast.saved'));
});

function fillVoiceModes(select, current) {
  select.innerHTML = VOICE_MODES.map(
    ([mode, kbps]) => `<option value="${mode}" ${mode === current ? 'selected' : ''}>${esc(t(`voice.${mode}`, { kbps }))}</option>`,
  ).join('');
}

function fillVideoQualities(select, current) {
  select.innerHTML = Object.entries(VIDEO_PRESETS)
    .map(([q, p]) => `<option value="${q}" ${q === current ? 'selected' : ''}>${esc(t(`video.${q}`, { kbps: p.kbps }))}</option>`)
    .join('');
}

// ---------- chat ----------

function peerCode(p) {
  return p.platform === 'remote' ? p.addr : p.code || null;
}

async function openChat(peer) {
  const code = peerCode(peer);
  if (!code) return;
  chat.peer = { code, name: peer.name };
  chat.unread.delete(code);
  renderPeers();
  $('#chat-name').textContent = peer.name;
  $('#chat-sub').textContent = shortCode(code);
  $('#chat').hidden = false;
  document.body.classList.add('in-chat');
  try {
    chat.messages.set(code, await invoke('chat_history', { peer: code }));
  } catch (err) {
    toast(errorText(err), true);
  }
  renderChat();
  $('#chat-input').focus();
}

function closeChat() {
  chat.peer = null;
  $('#chat').hidden = true;
  document.body.classList.remove('in-chat');
}

function upsertMessage(m) {
  const list = chat.messages.get(m.peer) || [];
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) list[i] = m;
  else list.push(m);
  chat.messages.set(m.peer, list);
}

function renderChat() {
  if (!chat.peer) return;
  const list = chat.messages.get(chat.peer.code) || [];
  const box = $('#chat-list');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  if (!list.length) {
    box.innerHTML = `<div class="empty">${esc(t('chat.empty'))}<br><span>${esc(t('chat.private'))}</span></div>`;
    return;
  }
  box.innerHTML = list
    .map((m) => {
      const time = new Date(m.ts).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
      const tick = m.outgoing ? (m.status === 'pending' ? ' ⏳' : ' ✓') : '';
      const title = m.outgoing ? t(m.status === 'pending' ? 'chat.pending' : 'chat.delivered') : '';
      const img = m.image ? `<img class="chat-img" data-path="${esc(m.image)}" alt="">` : '';
      const text = m.text ? `<div class="chat-text">${esc(m.text)}</div>` : '';
      return `<div class="bubble ${m.outgoing ? 'out' : 'in'}">${img}${text}<div class="chat-meta" title="${esc(title)}">${time}${tick}</div></div>`;
    })
    .join('');
  for (const img of box.querySelectorAll('img[data-path]')) loadImage(img);
  if (atBottom || list.at(-1)?.outgoing) box.scrollTop = box.scrollHeight;
}

async function loadImage(img) {
  const path = img.dataset.path;
  if (!imageCache.has(path)) {
    try {
      imageCache.set(path, await invoke('chat_image', { path }));
    } catch {
      return;
    }
  }
  img.src = imageCache.get(path);
  img.addEventListener('load', () => {
    const box = $('#chat-list');
    box.scrollTop = box.scrollHeight;
  }, { once: true });
}

$('#chat-list').addEventListener('click', (ev) => {
  const img = ev.target.closest('img.chat-img');
  if (!img?.src) return;
  $('#viewer-img').src = img.src;
  $('#viewer').showModal();
});
$('#viewer').addEventListener('click', () => $('#viewer').close());

$('#chat-close').addEventListener('click', closeChat);

$('#chat-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const input = $('#chat-input');
  const text = input.value;
  if (!text.trim() || !chat.peer) return;
  input.value = '';
  autosize(input);
  const m = await call_('chat_send', { peer: chat.peer.code, text });
  if (m) {
    upsertMessage(m);
    renderChat();
  }
});

$('#chat-input').addEventListener('keydown', (ev) => {
  // Intro envía; Mayús+Intro hace salto de línea (en el móvil, el teclado decide).
  if (ev.key === 'Enter' && !ev.shiftKey && !settings?.mobile) {
    ev.preventDefault();
    $('#chat-form').requestSubmit();
  }
});
$('#chat-input').addEventListener('input', (ev) => autosize(ev.target));

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
}

$('#chat-image').addEventListener('click', () => $('#chat-file').click());
$('#chat-file').addEventListener('change', async (ev) => {
  const files = [...ev.target.files];
  ev.target.value = '';
  for (const file of files) await sendImage(file);
});

// Las fotos del móvil pesan varios MB: se reducen a 1600 px en JPEG antes de
// enviarlas (unos 200-400 KB), que con mala señal es lo que importa.
async function sendImage(file) {
  if (!chat.peer) return;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
    const m = await call_('chat_send_image', { peer: chat.peer.code, data, ext: 'jpg' });
    if (m) {
      upsertMessage(m);
      renderChat();
    }
  } catch (err) {
    toast(errorText(err), true);
  }
}

function onChatEvent({ message, name }) {
  if (name) ensureRemotePeer(message.peer, name);
  upsertMessage(message);
  const open = chat.peer?.code === message.peer;
  if (open) {
    renderChat();
  } else if (!message.outgoing) {
    chat.unread.set(message.peer, (chat.unread.get(message.peer) || 0) + 1);
    renderPeers();
    toast(t('toast.message_from', { name: name || shortCode(message.peer) }));
  }
}

// Un mensaje o una llamada de alguien que no está en la lista lo añade como contacto.
function ensureRemotePeer(code, name) {
  const known = [...peers.values()].some((p) => peerCode(p) === code);
  if (!known) addRemotePeer({ code, name, os: '' });
}

// `call()` de main.js muestra el error; aquí se devuelve null en vez de lanzar.
async function call_(command, args) {
  try {
    return await call(command, args);
  } catch {
    return null;
  }
}

// ---------- llamadas ----------

function signal(kind, data = null) {
  if (!call) return Promise.resolve();
  return invoke('call_signal', { peer: call.peer.code, call: call.id, kind, data }).catch((err) => {
    if (kind !== 'hangup') toast(errorText(err), true);
    throw err;
  });
}

/** `to` es `{ code, name }`. */
async function startCall(to, media) {
  if (!to?.code) return;
  if (call) {
    toast(t('call.busy_self'), true);
    return;
  }
  const s = talkSettings();
  call = { id: crypto.randomUUID(), peer: { code: to.code, name: to.name }, media, role: 'caller', state: 'ringing' };
  call.mode = media === 'voice' ? s.voiceMode : s.videoQuality;
  showCall();
  try {
    await signal('invite', { media, mode: call.mode });
  } catch {
    endCall();
    return;
  }
  call.ringTimer = setTimeout(() => hangup('no_answer'), RING_TIMEOUT);
}

function onSignal({ peer, name, signal: s }) {
  if (s.kind === 'invite') {
    if (call) {
      invoke('call_signal', { peer, call: s.call, kind: 'busy', data: null }).catch(() => {});
      return;
    }
    ensureRemotePeer(peer, name);
    call = { id: s.call, peer: { code: peer, name }, media: s.data?.media || 'voice', role: 'callee', state: 'incoming' };
    call.mode = call.media === 'voice' ? s.data?.mode || 'normal' : talkSettings().videoQuality;
    showCall();
    startRinging();
    return;
  }
  if (!call || s.call !== call.id || peer !== call.peer.code) return;
  switch (s.kind) {
    case 'accept':
      clearTimeout(call.ringTimer);
      startMedia();
      break;
    case 'decline':
    case 'busy':
    case 'hangup':
      endCall(t(`call.ended_${s.kind}`));
      break;
    case 'mode':
      // La otra persona cambió de modo: se usa el mismo en los dos sentidos.
      if (call.media === 'voice' && s.data?.mode) {
        call.mode = s.data.mode;
        $('#call-mode').value = call.mode;
        invoke('voice_mode', { mode: call.mode });
      }
      break;
    case 'sdp':
      onRemoteSdp(s.data);
      break;
    case 'ice':
      onRemoteIce(s.data);
      break;
  }
}

async function acceptCall() {
  stopRinging();
  if (!call) return;
  try {
    await signal('accept');
  } catch {
    endCall();
    return;
  }
  startMedia();
}

function declineCall() {
  stopRinging();
  signal('decline').catch(() => {});
  endCall();
}

function hangup(reason) {
  signal('hangup').catch(() => {});
  endCall(reason ? t(`call.ended_${reason}`) : null);
}

async function startMedia() {
  call.state = 'active';
  call.started = Date.now();
  showCall();
  try {
    if (call.media === 'voice') {
      await invoke('voice_start', { peer: call.peer.code, mode: call.mode });
      call.last = null;
      call.statsTimer = setInterval(updateVoiceStats, 1000);
    } else {
      await startVideo();
    }
  } catch (err) {
    toast(errorText(err), true);
    hangup();
    return;
  }
  call.clock = setInterval(() => updateCallState(), 1000);
}

function endCall(message) {
  if (!call) return;
  const c = call;
  call = null;
  stopRinging();
  clearTimeout(c.ringTimer);
  clearInterval(c.statsTimer);
  clearInterval(c.clock);
  if (c.media === 'voice') invoke('voice_stop').catch(() => {});
  stopVideo(c);
  $('#call').hidden = true;
  if (message) toast(message);
}

function showCall() {
  const c = call;
  $('#call').hidden = false;
  $('#call').className = `call ${c.media} ${c.state}`;
  $('#call-name').textContent = c.peer.name;
  $('#call-accept').hidden = c.state !== 'incoming';
  $('#call-decline').hidden = c.state !== 'incoming';
  $('#call-hangup').hidden = c.state === 'incoming';
  $('#call-controls-live').hidden = c.state !== 'active' && c.role !== 'caller';
  $('#call-speaker').hidden = c.media !== 'voice' || !settings?.mobile;
  $('#call-cam').hidden = c.media !== 'video';
  if (c.media === 'voice') fillVoiceModes($('#call-mode'), c.mode);
  else fillVideoQualities($('#call-mode'), c.mode);
  $('#call-mute').classList.toggle('on', !!c.muted);
  updateCallState();
}

function updateCallState() {
  if (!call) return;
  let text;
  if (call.state === 'incoming') text = t(call.media === 'voice' ? 'call.incoming_voice' : 'call.incoming_video');
  else if (call.state === 'ringing') text = t('call.ringing');
  else {
    const s = Math.floor((Date.now() - call.started) / 1000);
    text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  $('#call-state').textContent = text;
}

async function updateVoiceStats() {
  const stats = await invoke('voice_stats').catch(() => null);
  if (!stats || !call) return;
  if (call.last) {
    const up = ((stats.sent - call.last.sent) * 8) / 1000;
    const down = ((stats.received - call.last.received) * 8) / 1000;
    const parts = [t('call.stats', { up: up.toFixed(1), down: down.toFixed(1) })];
    if (stats.lost) parts.push(t('call.lost', { lost: stats.lost, recovered: stats.recovered }));
    $('#call-stats').textContent = parts.join(' · ');
  }
  call.last = stats;
}

$('#call-accept').addEventListener('click', acceptCall);
$('#call-decline').addEventListener('click', declineCall);
$('#call-hangup').addEventListener('click', () => hangup());

$('#call-mute').addEventListener('click', () => {
  if (!call) return;
  call.muted = !call.muted;
  $('#call-mute').classList.toggle('on', call.muted);
  if (call.media === 'voice') invoke('voice_mute', { muted: call.muted });
  call.local?.getAudioTracks().forEach((track) => (track.enabled = !call.muted));
});

$('#call-speaker').addEventListener('click', () => {
  if (!call) return;
  call.speaker = !call.speaker;
  $('#call-speaker').classList.toggle('on', call.speaker);
  invoke('voice_speaker', { speaker: call.speaker });
});

$('#call-cam').addEventListener('click', () => {
  if (!call?.local) return;
  call.camOff = !call.camOff;
  $('#call-cam').classList.toggle('on', call.camOff);
  call.local.getVideoTracks().forEach((track) => (track.enabled = !call.camOff));
});

$('#call-mode').addEventListener('change', (ev) => {
  if (!call) return;
  call.mode = ev.target.value;
  if (call.media === 'voice') {
    saveTalkSettings({ voiceMode: call.mode });
    if (call.state === 'active') invoke('voice_mode', { mode: call.mode });
    signal('mode', { mode: call.mode }).catch(() => {});
  } else {
    saveTalkSettings({ videoQuality: call.mode });
    applyVideoQuality();
  }
});

$('#chat-voice').addEventListener('click', () => startCall(chat.peer, 'voice'));
$('#chat-video').addEventListener('click', () => startCall(chat.peer, 'video'));

// Timbre con WebAudio, sin archivos de sonido.
function startRinging() {
  stopRinging();
  const beep = () => {
    try {
      const ctx = (startRinging.ctx ||= new AudioContext());
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 660;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.6);
    } catch {}
  };
  beep();
  startRinging.timer = setInterval(beep, 1500);
}

function stopRinging() {
  clearInterval(startRinging.timer);
}

// ---------- vídeo (WebRTC) ----------

async function startVideo() {
  const preset = VIDEO_PRESETS[call.mode] || VIDEO_PRESETS.normal;
  call.local = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: { width: { ideal: preset.width }, height: { ideal: preset.height }, frameRate: { ideal: preset.fps } },
  });
  $('#call-local').srcObject = call.local;
  const pc = new RTCPeerConnection({ iceServers: iceServers() });
  call.pc = pc;
  call.pendingIce = [];
  for (const track of call.local.getTracks()) pc.addTrack(track, call.local);
  pc.onicecandidate = (ev) => ev.candidate && signal('ice', ev.candidate.toJSON()).catch(() => {});
  pc.ontrack = (ev) => ($('#call-remote').srcObject = ev.streams[0]);
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') hangup('failed');
  };
  await applyVideoQuality();
  // Quien llama hace la oferta; quien contesta espera a recibirla.
  if (call.role === 'caller') {
    await pc.setLocalDescription(await pc.createOffer());
    await signal('sdp', { type: pc.localDescription.type, sdp: pc.localDescription.sdp });
  } else if (call.pendingOffer) {
    await onRemoteSdp(call.pendingOffer);
  }
}

async function onRemoteSdp(desc) {
  if (!call) return;
  if (!call.pc) {
    // Llegó la oferta antes de tener la cámara lista.
    call.pendingOffer = desc;
    return;
  }
  const pc = call.pc;
  await pc.setRemoteDescription(desc);
  for (const c of call.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
  if (desc.type === 'offer') {
    await pc.setLocalDescription(await pc.createAnswer());
    await applyVideoQuality();
    await signal('sdp', { type: pc.localDescription.type, sdp: pc.localDescription.sdp });
  }
}

async function onRemoteIce(candidate) {
  if (!call?.pc || !call.pc.remoteDescription) {
    (call.pendingIce ||= []).push(candidate);
    return;
  }
  await call.pc.addIceCandidate(candidate).catch(() => {});
}

// Limita lo que sube cada uno: con mala señal es lo que manda.
async function applyVideoQuality() {
  if (!call?.pc) return;
  const preset = VIDEO_PRESETS[call.mode] || VIDEO_PRESETS.normal;
  for (const sender of call.pc.getSenders()) {
    if (!sender.track) continue;
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    if (sender.track.kind === 'video') {
      params.encodings[0].maxBitrate = preset.kbps * 1000;
      params.encodings[0].maxFramerate = preset.fps;
      sender.track
        .applyConstraints({ width: { ideal: preset.width }, height: { ideal: preset.height }, frameRate: { ideal: preset.fps } })
        .catch(() => {});
    } else {
      params.encodings[0].maxBitrate = 24_000;
    }
    await sender.setParameters(params).catch(() => {});
  }
}

function stopVideo(c) {
  c.pc?.close();
  c.local?.getTracks().forEach((track) => track.stop());
  $('#call-local').srcObject = null;
  $('#call-remote').srcObject = null;
}

// Al cambiar de idioma (main.js ya repinta lo suyo).
$('#lang').addEventListener('change', () => {
  renderChat();
  if (call) showCall();
});
