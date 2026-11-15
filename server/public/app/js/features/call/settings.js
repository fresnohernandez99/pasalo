// Call settings (saved in localStorage) and the quality lists shown both in
// the Settings screen and in the call screen.

import { t } from '../../i18n/index.js';
import { $, esc } from '../../lib/dom.js';
import { VIDEO_MODES } from '../video.js';
import { DEVICE_KINDS, fillDevices, listDevices } from './devices.js';

// Usage measured with both sides talking at once (the worst case), with
// everything that goes over the network. If only one talks, the other spends
// much less.
export const VOICE_MODES = [
  ['high', 42],
  ['normal', 26],
  ['low', 19],
  ['minimum', 9],
];

// `mic`, `speaker` and `camera` are device ids (see devices.js); empty is
// the system default.
const DEFAULTS = { voiceMode: 'normal', videoAudioMode: 'low', videoQuality: 'normal', blur: false, enhance: true, mic: '', speaker: '', camera: '' };

export function callSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('talk') || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveCallSettings(patch) {
  try {
    localStorage.setItem('talk', JSON.stringify({ ...callSettings(), ...patch }));
  } catch {}
}

export const isVoiceMode = (mode) => VOICE_MODES.some(([m]) => m === mode);

/** The chosen microphone and speaker, as `voice_start` and `voice_device` take them. */
export function voiceDevices() {
  const s = callSettings();
  return { input: s.mic || null, output: s.speaker || null };
}

export function fillAudioModes(select, current) {
  select.innerHTML = VOICE_MODES.map(
    ([mode, kbps]) => `<option value="${mode}" ${mode === current ? 'selected' : ''}>${esc(t(`voice.${mode}`, { kbps }))}</option>`,
  ).join('');
}

export function fillVideoModes(select, current) {
  select.innerHTML = Object.entries(VIDEO_MODES)
    .map(([q, m]) => `<option value="${q}" ${q === current ? 'selected' : ''}>${esc(t(`video.${q}`, { kbps: m.kbps }))}</option>`)
    .join('');
}

/** The call part of the Settings screen (settings.js opens and closes it). */
export function fillCallSettings() {
  const s = callSettings();
  fillAudioModes($('#set-voice-mode'), s.voiceMode);
  fillAudioModes($('#set-video-audio-mode'), s.videoAudioMode);
  fillVideoModes($('#set-video-quality'), s.videoQuality);
  $('#set-blur').checked = s.blur;
  $('#set-enhance').checked = s.enhance;
  listDevices().then((lists) => fillDevices('set-dev', lists, callSettings()));
}

for (const [id, key] of [
  ['#set-blur', 'blur'],
  ['#set-enhance', 'enhance'],
]) {
  $(id).addEventListener('change', (ev) => saveCallSettings({ [key]: ev.target.checked }));
}

for (const [id, key] of [
  ['#set-voice-mode', 'voiceMode'],
  ['#set-video-audio-mode', 'videoAudioMode'],
  ['#set-video-quality', 'videoQuality'],
]) {
  $(id).addEventListener('change', (ev) => saveCallSettings({ [key]: ev.target.value }));
}

for (const kind of DEVICE_KINDS) {
  $(`#set-dev-${kind}`).addEventListener('change', (ev) => saveCallSettings({ [kind]: ev.target.value }));
}
