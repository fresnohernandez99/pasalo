// Pantalla de Ajustes. Cada cambio se guarda al momento.

import { LANGS, currentLang, errorText, setLang, t } from '../i18n/index.js';
import { emit, on } from '../lib/bus.js';
import { $, esc } from '../lib/dom.js';
import { initials, shortCode } from '../lib/format.js';
import { call, invoke } from '../lib/tauri.js';
import { toast } from '../lib/toast.js';
import { app } from '../state.js';
import { fillCallSettings } from './call.js';
import { onBack } from './nav.js';

export function openSettings() {
  fill();
  fillCallSettings();
  $('#settings').hidden = false;
}

function closeSettings() {
  if ($('#settings').hidden) return false;
  $('#settings').hidden = true;
  return true;
}

onBack(closeSettings);
$('#open-settings').addEventListener('click', openSettings);
$('#me').addEventListener('click', openSettings);
$('#me-name').addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', closeSettings);

function fill() {
  const s = app.settings;
  $('#set-avatar').textContent = initials(s.name);
  $('#set-name').value = s.name;
  $('#set-name').dataset.saved = s.name;
  $('#set-code-row').hidden = !s.code;
  if (s.code) $('#set-code').textContent = shortCode(s.code);
  const ips = s.ips.length ? s.ips.join(', ') : t('me.no_network');
  $('#set-address').textContent = t('me.sub', { ips, port: s.port });
  $('#dir-label').textContent = s.dir;
  $('#open-dir').title = t('dir.open_title', { dir: s.dir });
  $('#set-server').value = s.server || '';
  $('#set-version').textContent = s.version || '';
  $('#lang').innerHTML = Object.keys(LANGS)
    .map((code) => `<option value="${code}" ${code === currentLang() ? 'selected' : ''}>${esc(LANGS[code]['lang.name'])}</option>`)
    .join('');
}

/** Lo que cambió en los ajustes (nombre, carpeta…), para quien lo enseñe. */
export function updateSettings(patch) {
  Object.assign(app.settings, patch);
  emit('settings');
}

async function saveName() {
  const input = $('#set-name');
  const name = input.value.trim();
  if (!name || name === input.dataset.saved) {
    input.value = input.dataset.saved || '';
    return;
  }
  try {
    await call('set_name', { name });
  } catch {
    input.value = input.dataset.saved;
    return;
  }
  input.dataset.saved = name;
  $('#set-avatar').textContent = initials(name);
  updateSettings({ name });
  toast(t('toast.name_updated'));
}

$('#set-name').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') ev.target.blur();
  if (ev.key === 'Escape') {
    ev.target.value = ev.target.dataset.saved || '';
    ev.target.blur();
  }
});
$('#set-name').addEventListener('blur', saveName);

$('#set-copy-code').addEventListener('click', async () => {
  await navigator.clipboard.writeText(app.settings.code);
  toast(t('toast.code_copied'));
});

$('#open-dir').addEventListener('click', () => call('open_dir'));
$('#change-dir').addEventListener('click', async () => {
  const dir = await call('choose_dir');
  if (!dir) return;
  updateSettings({ dir });
  fill();
});

$('#lang').addEventListener('change', (ev) => {
  setLang(ev.target.value);
  fill();
  fillCallSettings();
  emit('lang');
});

$('#set-server').addEventListener('change', async (ev) => {
  const server = ev.target.value.trim();
  if (!server || server === app.settings.server) return;
  try {
    await call('set_server', { server });
    updateSettings({ server });
    toast(t('toast.saved'));
  } catch {
    ev.target.value = app.settings.server || '';
  }
});

// ---------- versión nueva ----------

// Solo cuando el usuario lo pide: la app no consulta nada por su cuenta.
let release = null;

$('#check-update').addEventListener('click', async () => {
  const button = $('#check-update');
  button.disabled = true;
  button.textContent = t('update.checking');
  try {
    release = await invoke('check_update');
    showRelease();
  } catch (err) {
    release = null;
    $('#update-result').hidden = false;
    $('#update-text').textContent = errorText(err);
    $('#update-get').hidden = true;
  } finally {
    button.disabled = false;
    button.textContent = t('update.check');
  }
});

function showRelease() {
  if (!release) return;
  $('#update-result').hidden = false;
  $('#update-text').textContent = release.newer ? t('update.available', { version: release.version }) : t('update.latest');
  $('#update-get').hidden = !release.newer;
}

$('#update-get').addEventListener('click', () => {
  if (release) call('open_release', { url: release.download || release.url }).catch(() => {});
});

on('lang', showRelease);

on('settings', () => {
  if (!$('#settings').hidden) $('#set-avatar').textContent = initials(app.settings.name);
});
