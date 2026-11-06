// Chat, llamadas de voz (las hace Rust) y videollamadas (WebRTC aquí).
// Todo va por el canal de iroh con el código de cada equipo; WebRTC solo usa
// STUN/TURN para que el vídeo llegue directo.

const chat = {
  peer: null, // { code, name }
  messages: new Map(), // código → [mensaje]
  unread: new Map(), // código → número
};
const imageCache = new Map(); // ruta → data URL

// Consumo medido con los dos lados hablando a la vez (el peor caso), con
// todo lo que pasa por la red. Si solo habla uno, el otro gasta mucho menos.
const VOICE_MODES = [
  ['high', 42],
  ['normal', 26],
  ['low', 19],
  ['minimum', 9],
];
// Lo justo para verse con poca red: la resolución y los fps bajos dejan que
// el bitrate alcance para una imagen nítida.
const VIDEO_PRESETS = {
  low: { width: 320, height: 240, fps: 10, kbps: 100 },
  normal: { width: 480, height: 360, fps: 15, kbps: 300 },
  high: { width: 960, height: 540, fps: 24, kbps: 900 },
};
// Audio de las videollamadas: Opus a 16 kbps y sin enviar nada en silencio (DTX).
const VIDEO_AUDIO_KBPS = 16;
const RING_TIMEOUT = 45_000;

let live = null;

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

// Lo suyo en la pantalla de Ajustes (main.js la abre y la cierra).
function fillTalkSettings() {
  const s = talkSettings();
  $('#set-turn').value = s.turn;
  $('#set-turn-user').value = s.turnUser;
  $('#set-turn-pass').value = s.turnPass;
  fillVoiceModes($('#set-voice-mode'), s.voiceMode);
}

for (const [id, key] of [['#set-turn', 'turn'], ['#set-turn-user', 'turnUser'], ['#set-turn-pass', 'turnPass'], ['#set-voice-mode', 'voiceMode']]) {
  $(id).addEventListener('change', (ev) => saveTalkSettings({ [key]: ev.target.value }));
}

function fillVoiceModes(select, current) {
  select.innerHTML = VOICE_MODES.map(
    ([mode, kbps]) => `<option value="${mode}" ${mode === current ? 'selected' : ''}>${esc(t(`voice.${mode}`, { kbps }))}</option>`,
  ).join('');
  showModeLabel();
}

// Debajo del botón de calidad, el nombre corto del modo («Normal»).
function showModeLabel() {
  const select = $('#call-mode');
  const text = select.selectedOptions[0]?.textContent || '';
  $('#call-mode-label').textContent = text.split(' · ')[0];
}

function fillVideoQualities(select, current) {
  select.innerHTML = Object.entries(VIDEO_PRESETS)
    .map(([q, p]) => `<option value="${q}" ${q === current ? 'selected' : ''}>${esc(t(`video.${q}`, { kbps: p.kbps }))}</option>`)
    .join('');
  showModeLabel();
}

// ---------- chat ----------

function peerCode(p) {
  return p.platform === 'remote' || p.platform === 'partner' ? p.addr : p.code || null;
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
    box.dataset.peer = '';
    return;
  }
  // Solo se toca la burbuja que cambia (un mensaje nuevo, un ✓): rehacerlo
  // todo volvía a decodificar las imágenes y hacía saltar el scroll.
  if (box.dataset.peer !== chat.peer.code) {
    box.innerHTML = '';
    box.dataset.peer = chat.peer.code;
  }
  const shown = new Map([...box.children].map((el) => [el.dataset.id, el]));
  for (const m of list) {
    let el = shown.get(m.id);
    if (!el) {
      el = document.createElement('div');
      el.dataset.id = m.id;
      box.append(el);
    }
    const html = bubbleHtml(m);
    if (el.dataset.html === html) continue;
    el.dataset.html = html;
    el.className = `bubble ${m.outgoing ? 'out' : 'in'}`;
    el.innerHTML = html;
    for (const img of el.querySelectorAll('img[data-path]')) loadImage(img);
  }
  if (atBottom || list.at(-1)?.outgoing) box.scrollTop = box.scrollHeight;
}

function bubbleHtml(m) {
  const time = new Date(m.ts).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
  const tick = m.outgoing ? (m.status === 'pending' ? ' ⏳' : ' ✓') : '';
  const title = m.outgoing ? t(m.status === 'pending' ? 'chat.pending' : 'chat.delivered') : '';
  const img = m.image ? `<img class="chat-img" data-path="${esc(m.image)}" alt="">` : '';
  const text = m.text ? `<div class="chat-text">${esc(m.text)}</div>` : '';
  return `${img}${text}<div class="chat-meta" title="${esc(title)}">${time}${tick}</div>`;
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
  if (!live) return Promise.resolve();
  return invoke('call_signal', { peer: live.peer.code, call: live.id, kind, data }).catch((err) => {
    if (kind !== 'hangup') toast(errorText(err), true);
    throw err;
  });
}

/** `to` es `{ code, name }`. */
async function startCall(to, media) {
  if (!to?.code) return;
  if (live) {
    toast(t('call.busy_self'), true);
    return;
  }
  const s = talkSettings();
  live = { id: crypto.randomUUID(), peer: { code: to.code, name: to.name }, media, role: 'caller', state: 'ringing' };
  live.mode = media === 'voice' ? s.voiceMode : s.videoQuality;
  showCall();
  try {
    await signal('invite', { media, mode: live.mode });
  } catch {
    endCall();
    return;
  }
  live.ringTimer = setTimeout(() => hangup('no_answer'), RING_TIMEOUT);
}

function onSignal({ peer, name, signal: s }) {
  if (s.kind === 'unpair') {
    onUnpair(peer, name);
    return;
  }
  if (s.kind === 'invite') {
    if (live) {
      invoke('call_signal', { peer, call: s.call, kind: 'busy', data: null }).catch(() => {});
      return;
    }
    ensureRemotePeer(peer, name);
    live = { id: s.call, peer: { code: peer, name }, media: s.data?.media || 'voice', role: 'callee', state: 'incoming' };
    live.mode = live.media === 'voice' ? s.data?.mode || 'normal' : talkSettings().videoQuality;
    showCall();
    startRinging();
    return;
  }
  if (!live || s.call !== live.id || peer !== live.peer.code) return;
  switch (s.kind) {
    case 'accept':
      clearTimeout(live.ringTimer);
      startMedia();
      break;
    case 'decline':
    case 'busy':
    case 'hangup':
      endCall(t(`call.ended_${s.kind}`));
      break;
    case 'mode':
      // La otra persona cambió de modo: se usa el mismo en los dos sentidos.
      if (live.media === 'voice' && s.data?.mode) {
        live.mode = s.data.mode;
        $('#call-mode').value = live.mode;
        invoke('voice_mode', { mode: live.mode });
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
  if (!live) return;
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
  live.state = 'active';
  live.started = Date.now();
  showCall();
  live.clock = setInterval(() => updateCallState(), 1000);
  try {
    if (live.media === 'voice') {
      await invoke('voice_start', { peer: live.peer.code, mode: live.mode });
      live.last = null;
      live.statsTimer = setInterval(updateVoiceStats, 1000);
    } else {
      await startVideo();
    }
  } catch (err) {
    toast(errorText(err), true);
    hangup();
  }
}

function endCall(message) {
  if (!live) return;
  const c = live;
  live = null;
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
  const c = live;
  $('#call').hidden = false;
  $('#call').className = `call ${c.media} ${c.state}`;
  $('#call-name').textContent = c.peer.name;
  $('#call-avatar').textContent = initials(c.peer.name);
  if (c.state !== 'active') $('#call-stats').textContent = '';
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
  if (!live) return;
  let text;
  if (live.state === 'incoming') text = t(live.media === 'voice' ? 'call.incoming_voice' : 'call.incoming_video');
  else if (live.state === 'ringing') text = t('call.ringing');
  else {
    const s = Math.floor((Date.now() - live.started) / 1000);
    text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  $('#call-state').textContent = text;
}

async function updateVoiceStats() {
  const stats = await invoke('voice_stats').catch(() => null);
  if (!stats || !live) return;
  if (live.last) {
    const up = ((stats.sent - live.last.sent) * 8) / 1000;
    const down = ((stats.received - live.last.received) * 8) / 1000;
    const parts = [t('call.stats', { up: up.toFixed(1), down: down.toFixed(1) })];
    if (stats.lost) parts.push(t('call.lost', { lost: stats.lost, recovered: stats.recovered }));
    $('#call-stats').textContent = parts.join(' · ');
  }
  live.last = stats;
}

$('#call-accept').addEventListener('click', acceptCall);
$('#call-decline').addEventListener('click', declineCall);
$('#call-hangup').addEventListener('click', () => hangup());

$('#call-mute').addEventListener('click', () => {
  if (!live) return;
  live.muted = !live.muted;
  $('#call-mute').classList.toggle('on', live.muted);
  if (live.media === 'voice') invoke('voice_mute', { muted: live.muted });
  live.local?.getAudioTracks().forEach((track) => (track.enabled = !live.muted));
});

$('#call-speaker').addEventListener('click', () => {
  if (!live) return;
  live.speaker = !live.speaker;
  $('#call-speaker').classList.toggle('on', live.speaker);
  invoke('voice_speaker', { speaker: live.speaker });
});

$('#call-cam').addEventListener('click', () => {
  if (!live?.local) return;
  live.camOff = !live.camOff;
  $('#call-cam').classList.toggle('on', live.camOff);
  live.local.getVideoTracks().forEach((track) => (track.enabled = !live.camOff));
});

$('#call-mode').addEventListener('change', (ev) => {
  showModeLabel();
  if (!live) return;
  live.mode = ev.target.value;
  if (live.media === 'voice') {
    saveTalkSettings({ voiceMode: live.mode });
    if (live.state === 'active') invoke('voice_mode', { mode: live.mode });
    signal('mode', { mode: live.mode }).catch(() => {});
  } else {
    saveTalkSettings({ videoQuality: live.mode });
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
  const preset = VIDEO_PRESETS[live.mode] || VIDEO_PRESETS.normal;
  live.local = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: { width: { ideal: preset.width }, height: { ideal: preset.height }, frameRate: { ideal: preset.fps } },
  });
  $('#call-local').srcObject = live.local;
  const pc = new RTCPeerConnection({ iceServers: iceServers() });
  live.pc = pc;
  // Pueden haber llegado candidatos mientras se encendía la cámara: no se tiran.
  live.pendingIce ||= [];
  for (const track of live.local.getTracks()) pc.addTrack(track, live.local);
  pc.onicecandidate = (ev) => ev.candidate && signal('ice', ev.candidate.toJSON()).catch(() => {});
  pc.ontrack = (ev) => ($('#call-remote').srcObject = ev.streams[0]);
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') hangup('failed');
  };
  live.last = null;
  live.statsTimer = setInterval(updateVideoStats, 1000);
  await applyVideoQuality();
  // Quien llama hace la oferta; quien contesta espera a recibirla.
  if (live.role === 'caller') {
    await pc.setLocalDescription(lighterAudio(await pc.createOffer()));
    await signal('sdp', { type: pc.localDescription.type, sdp: pc.localDescription.sdp });
  } else if (live.pendingOffer) {
    await onRemoteSdp(live.pendingOffer);
  }
}

async function onRemoteSdp(desc) {
  if (!live) return;
  if (!live.pc) {
    // Llegó la oferta antes de tener la cámara lista.
    live.pendingOffer = desc;
    return;
  }
  const pc = live.pc;
  await pc.setRemoteDescription(desc);
  for (const c of live.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
  if (desc.type === 'offer') {
    await pc.setLocalDescription(lighterAudio(await pc.createAnswer()));
    await applyVideoQuality();
    await signal('sdp', { type: pc.localDescription.type, sdp: pc.localDescription.sdp });
  }
}

// Consumo real del vídeo (y su audio) con getStats, y el estado mientras conecta.
async function updateVideoStats() {
  const pc = live?.pc;
  if (!pc) return;
  if (pc.connectionState !== 'connected') {
    $('#call-stats').textContent = t('call.connecting', { state: pc.connectionState });
    return;
  }
  let sent = 0;
  let received = 0;
  (await pc.getStats()).forEach((r) => {
    if (r.type === 'transport') {
      sent += r.bytesSent || 0;
      received += r.bytesReceived || 0;
    }
  });
  if (live.last) {
    const up = ((sent - live.last.sent) * 8) / 1000;
    const down = ((received - live.last.received) * 8) / 1000;
    $('#call-stats').textContent = t('call.stats', { up: up.toFixed(0), down: down.toFixed(0) });
  }
  live.last = { sent, received };
}

async function onRemoteIce(candidate) {
  if (!live?.pc || !live.pc.remoteDescription) {
    (live.pendingIce ||= []).push(candidate);
    return;
  }
  await live.pc.addIceCandidate(candidate).catch(() => {});
}

// Limita lo que sube cada uno: con mala señal es lo que manda.
async function applyVideoQuality() {
  if (!live?.pc) return;
  const preset = VIDEO_PRESETS[live.mode] || VIDEO_PRESETS.normal;
  for (const sender of live.pc.getSenders()) {
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
      params.encodings[0].maxBitrate = VIDEO_AUDIO_KBPS * 1000;
    }
    await sender.setParameters(params).catch(() => {});
  }
}

// Pide al otro lado Opus con DTX (nada durante los silencios) y como mucho
// VIDEO_AUDIO_KBPS: los parámetros `fmtp` de cada lado dicen cómo quiere recibir.
function lighterAudio(desc) {
  const opus = desc.sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
  if (!opus) return desc;
  const pt = opus[1];
  const extra = `usedtx=1;maxaveragebitrate=${VIDEO_AUDIO_KBPS * 1000}`;
  const sdp = desc.sdp.replace(new RegExp(`a=fmtp:${pt} ([^\r\n]*)`), (line, params) =>
    params.includes('usedtx') ? line : `a=fmtp:${pt} ${params};${extra}`,
  );
  return { type: desc.type, sdp };
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
  if (live) showCall();
});
