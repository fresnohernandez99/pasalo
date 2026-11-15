// The record of a call that goes to its chat (duration, usage) and to the
// statistics.

import { invoke } from '../../lib/tauri.js';
import { onChatEvent } from '../chat.js';
import { newId } from './util.js';

/**
 * Logs the call `c` as `outcome` (`completed`, `missed`, `no_answer`,
 * `declined`, `busy`, `cancelled`, `failed`, `lost`).
 */
export function logCall(c, outcome) {
  const first = c.first || { sent: 0, received: 0, lost: 0, recovered: 0 };
  const last = c.last || first;
  const record = {
    id: String(c.id || '').replace(/[^\w-]/g, '').slice(0, 80) || newId(),
    media: c.media,
    role: c.role,
    outcome,
    started: c.createdAt || Date.now(),
    duration_ms: c.started && c.state === 'active' ? Date.now() - c.started : 0,
    audio: c.audio || null,
    video: c.media === 'video' ? c.video || null : null,
    // To compare usage and quality: whether it was sent with the background
    // blurred (at some point) and whether the incoming image was enhanced on
    // the GPU (if the GPU could not keep up, it switched itself off and
    // counts as no).
    blur: c.media === 'video' ? !!(c.blurUsed || c.sender?.blurUsed) : false,
    enhance: c.media === 'video' ? !!c.receiver?.upscaler : false,
    sent: Math.max(0, (last.sent || 0) - (first.sent || 0)),
    received: Math.max(0, (last.received || 0) - (first.received || 0)),
    video_sent: c.videoUp || 0,
    video_received: c.videoDown || 0,
    lost: Math.max(0, (last.lost || 0) - (first.lost || 0)),
    recovered: Math.max(0, (last.recovered || 0) - (first.recovered || 0)),
  };
  invoke('call_record', { peer: c.peer.code, record }).then(
    (message) => onChatEvent({ message, name: null }),
    (err) => console.warn('call record', err),
  );
}
