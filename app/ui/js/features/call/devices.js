// The microphones, speakers and cameras to choose from, and the selectors
// that show them (in the call screen and in Settings). The microphones and
// the speakers come from whoever handles the voice (`voice_devices`: Rust in
// the apps, the browser on the web); the cameras, from the page itself.
//
// What is chosen is saved as the device's id (see settings.js); empty is the
// system default. Where there is nothing to choose, the selector is hidden:
// on Android the system routes the audio of a call, and on a phone the Flip
// button already switches between its cameras.

import { t } from '../../i18n/index.js';
import { $, esc } from '../../lib/dom.js';
import { invoke } from '../../lib/tauri.js';
import { isMobile } from '../../state.js';

export const DEVICE_KINDS = ['mic', 'speaker', 'camera'];

/** The cameras the page can name (before the camera permission, none). */
async function cameras() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput' && d.deviceId && d.label).map((d) => ({ id: d.deviceId, name: d.label }));
  } catch {
    return [];
  }
}

/** `{ mic, speaker, camera }`: for each, the list of `{ id, name }` to choose from. */
export async function listDevices() {
  const [voice, camera] = await Promise.all([invoke('voice_devices').catch(() => null), isMobile() ? [] : cameras()]);
  return { mic: voice?.inputs || [], speaker: voice?.outputs || [], camera };
}

/**
 * Fills the selectors `#<prefix>-mic`, `#<prefix>-speaker` and
 * `#<prefix>-camera` with `lists`, marking what is `picked` (`{ mic,
 * speaker, camera }`, ids). The row of each one (`#<prefix>-<kind>-row`) is
 * hidden if its list is empty. Returns whether any is left to show.
 */
export function fillDevices(prefix, lists, picked) {
  let any = false;
  for (const kind of DEVICE_KINDS) {
    const list = lists[kind] || [];
    // If what was picked is no longer there, the default is what is in use.
    const current = list.some((d) => d.id === picked[kind]) ? picked[kind] : '';
    $(`#${prefix}-${kind}`).innerHTML = [{ id: '', name: t('devices.default') }, ...list]
      .map((d) => `<option value="${esc(d.id)}" ${d.id === current ? 'selected' : ''}>${esc(d.name)}</option>`)
      .join('');
    $(`#${prefix}-${kind}-row`).hidden = !list.length;
    any ||= list.length > 0;
  }
  return any;
}
