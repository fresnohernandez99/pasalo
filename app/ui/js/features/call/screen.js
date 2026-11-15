// The call screen: what is shown for a call `c` in each state. The buttons
// are wired in call.js, which owns the state.

import { t } from '../../i18n/index.js';
import { $ } from '../../lib/dom.js';
import { initials } from '../../lib/format.js';
import { isMobile } from '../../state.js';
import { updateLayers } from '../nav.js';
import { fillAudioModes, fillVideoModes } from './settings.js';

const MENUS = ['quality', 'devices'];

/**
 * The menus of the top corner: `quality` and `devices`. Opens `name`,
 * closing the other one; with no name, closes both.
 */
export function setMenu(name = null) {
  for (const menu of MENUS) {
    $(`#call-${menu}-menu`).hidden = menu !== name;
    $(`#call-${menu}-btn`).setAttribute('aria-expanded', String(menu === name));
  }
}

/** The menu that is open (`quality`, `devices`), if any. */
export const openMenu = () => MENUS.find((menu) => !$(`#call-${menu}-menu`).hidden) ?? null;

/** Shows the screen for `c` (opening it if it was hidden). */
export function render(c) {
  const video = c.media === 'video';
  const opening = $('#call').hidden;
  $('#call').hidden = false;
  if (opening) updateLayers(c.state === 'incoming' ? $('#call-accept') : $('#call-hangup'));
  const hidden = $('#call').classList.contains('controls-hidden') && c.state === 'active';
  const hasVideo = video && !!c.hasVideo && !c.remoteCamOff;
  // Swapped only while both are visible.
  const swapped = $('#call').classList.contains('swapped') && hasVideo && !c.camOff;
  $('#call').className = `call ${c.media} ${c.state}${hidden ? ' controls-hidden' : ''}${c.facing !== 'user' ? ' rear' : ''}${swapped ? ' swapped' : ''}`;
  $('#call').classList.toggle('has-video', hasVideo);
  $('#call').classList.toggle('cam-off', c.camOff);
  $('#call-name').textContent = c.peer.name;
  $('#call-avatar').textContent = initials(c.peer.name);
  $('#call-remote-off').hidden = !(video && c.state === 'active' && c.remoteCamOff);
  if (c.state !== 'active') $('#call-stats').textContent = '';
  $('#call-accept').hidden = c.state !== 'incoming';
  $('#call-decline').hidden = c.state !== 'incoming';
  $('#call-hangup').hidden = c.state === 'incoming';
  $('#call-game').hidden = c.state !== 'active';
  $('#call-controls-live').hidden = c.state === 'incoming';
  $('#call-speaker').hidden = !isMobile();
  $('#call-cam').hidden = !video;
  $('#call-flip').hidden = !video || !isMobile() || c.camOff;
  $('#call-vmode-btn').hidden = !video;
  $('#call-blur-row').hidden = !video;
  $('#call-blur').checked = !!c.blur;
  fillAudioModes($('#call-mode'), c.audio);
  fillVideoModes($('#call-vmode'), c.video);
  for (const [id, on] of [['#call-mute', c.muted], ['#call-speaker', c.speaker], ['#call-cam', c.camOff]]) {
    $(id).classList.toggle('on', on);
    $(id).setAttribute('aria-pressed', String(on));
  }
  $('#call-cam-label').textContent = t(c.camOff ? 'call.camera_on' : 'call.camera');
  renderState(c);
}

/** The line under the name: ringing, incoming or the elapsed time. */
export function renderState(c) {
  let text;
  if (c.state === 'incoming') text = t(c.media === 'voice' ? 'call.incoming_voice' : 'call.incoming_video');
  else if (c.state === 'ringing') text = t('call.ringing');
  else {
    const s = Math.floor((Date.now() - c.started) / 1000);
    text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  $('#call-state').textContent = text;
}

/** Hides the screen and forgets its per-call classes. */
export function hide() {
  $('#call').hidden = true;
  updateLayers();
  $('#call').classList.remove('controls-hidden', 'rear', 'swapped');
  setMenu();
  // Shown again once the next call knows what there is to choose from.
  $('#call-devices-btn').hidden = true;
}
