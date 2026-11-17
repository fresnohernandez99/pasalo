// The chat header's overflow (⋮) menu. Friend, private mode and end-chat live
// here so the top bar is not crowded — the name had no room when every action
// was a separate icon. The buttons keep their own ids and handlers; this only
// shows and hides the menu that holds them.

import { t } from '../i18n/index.js';
import { $ } from '../lib/dom.js';
import { toast } from '../lib/toast.js';
import { activePeer } from './chat.js';
import { peerCode } from './peers.js';

const more = $('#chat-more');
const menu = $('#chat-menu');

// The lobby server only hands the link's halves to the app; it never sees the
// connection. Same shape as link_mine in the Tauri side (links.rs).
const LINK_HOST = 'pasalo-server.vercel.app';

// Shares the code of the person in this chat, so a friend can chat with them
// too (e.g. after scanning a PS4's QR, pass its code along). Uses the system
// share sheet when there is one, else copies the link.
async function shareCode() {
  const peer = activePeer();
  const code = peer && peerCode(peer);
  if (!code) return;
  const url = new URL(`https://${LINK_HOST}/`);
  url.searchParams.set('c', code);
  if (peer.name) url.searchParams.set('n', peer.name);
  const link = url.toString();
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Pasalo', text: link, url: link });
    } else {
      await navigator.clipboard.writeText(link);
      toast(t('toast.link_copied'));
    }
  } catch {
    // The person dismissed the share sheet, or it is unavailable: no-op.
  }
}

$('#chat-share-code').addEventListener('click', shareCode);

const close = () => {
  menu.hidden = true;
};

more.addEventListener('click', (ev) => {
  ev.stopPropagation();
  menu.hidden = !menu.hidden;
});

// Choosing anything inside closes it (the item's own handler still runs, as the
// click reaches it before bubbling here); so does a tap anywhere else.
menu.addEventListener('click', close);
document.addEventListener('click', (ev) => {
  if (!menu.hidden && !menu.contains(ev.target) && !more.contains(ev.target)) {
    close();
  }
});
