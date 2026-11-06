// Conexión con otras redes por el server. La app arranca sin conexión y no
// intenta nada fuera de la LAN hasta que el usuario pulsa «Conectarse».
// Conectado, ve quién más lo está y puede pedirle conectarse; si el otro
// acepta, los dos dejan el server y quedan conectados solo entre ellos.

const net = {
  state: 'offline', // offline | connecting | online | paired
  users: [], // [{ id, name, platform }] en el server
  incoming: new Map(), // id de solicitud → { id, name, platform }
  outgoing: new Map(), // id de usuario → id de solicitud
  partner: null, // { id, name, platform, code }
  error: '',
};

function initNet(s) {
  if (s.partner) setPartner(s.partner);
  else setNetState(s.online ? 'online' : 'offline');
}

function setNetState(state) {
  net.state = state;
  if (state !== 'online') {
    net.users = [];
    net.incoming.clear();
    net.outgoing.clear();
    net.error = '';
  }
  renderNet();
}

function renderNet() {
  const { state, partner } = net;
  $('#net-dot').className = `dot ${state === 'paired' ? 'paired' : state === 'online' ? 'online' : ''}`;
  $('#net-state').textContent =
    state === 'paired' ? t('net.paired', { name: partner.name }) : t(`net.${state}`);
  const toggle = $('#net-toggle');
  toggle.textContent = t(state === 'offline' ? 'net.connect' : 'net.disconnect');
  toggle.className = state === 'offline' ? 'small' : 'small ghost';
  toggle.disabled = state === 'connecting';
  $('#lobby').hidden = state !== 'online';
  renderLobby();
}

function renderLobby() {
  if (net.state !== 'online') return;
  $('#lobby-status').textContent = net.error ? t('lobby.unreachable') : '';
  const rows = [];
  for (const [request, from] of net.incoming) {
    rows.push(`
      <div class="lobby-row request" data-request="${esc(request)}">
        ${avatar(from.name, from.platform)}
        <div class="info"><div class="pname">${esc(from.name)}</div><div class="sub">${esc(t('lobby.wants'))}</div></div>
        <button class="ghost small" data-act="decline">${esc(t('btn.decline'))}</button>
        <button class="small" data-act="accept">${esc(t('btn.accept'))}</button>
      </div>`);
  }
  const asking = new Set([...net.incoming.values()].map((u) => u.id));
  for (const user of net.users.filter((u) => !asking.has(u.id))) {
    const pending = net.outgoing.has(user.id);
    rows.push(`
      <div class="lobby-row" data-user="${esc(user.id)}">
        ${avatar(user.name, user.platform)}
        <div class="info"><div class="pname">${esc(user.name)}</div>${pending ? `<div class="sub">${esc(t('lobby.waiting'))}</div>` : ''}</div>
        ${pending
          ? `<button class="ghost small" data-act="cancel">${esc(t('btn.cancel'))}</button>`
          : `<button class="small" data-act="request">${esc(t('lobby.connect'))}</button>`}
      </div>`);
  }
  setHtml($('#lobby-list'), rows.length ? rows.join('') : `<div class="empty">${esc(t('lobby.empty'))}</div>`);
}

$('#net-toggle').addEventListener('click', async () => {
  if (net.state === 'offline') {
    setNetState('connecting');
    try {
      await call('net_connect');
      setNetState('online');
    } catch {
      setNetState('offline');
    }
    return;
  }
  await call('net_disconnect').catch(() => {});
  dropPartner();
  setNetState('offline');
});

$('#lobby-list').addEventListener('click', async (ev) => {
  const button = ev.target.closest('button');
  if (!button) return;
  const row = button.closest('.lobby-row');
  const act = button.dataset.act;
  button.disabled = true;
  try {
    if (act === 'request') {
      const user = net.users.find((u) => u.id === row.dataset.user);
      if (!user) return;
      net.outgoing.set(user.id, await call('lobby_request', { to: user }));
      toast(t('toast.request_sent', { name: user.name }));
    } else if (act === 'cancel') {
      const request = net.outgoing.get(row.dataset.user);
      net.outgoing.delete(row.dataset.user);
      if (request) await call('lobby_cancel', { request });
    } else if (act === 'accept' || act === 'decline') {
      const request = row.dataset.request;
      net.incoming.delete(request);
      // Al aceptar, el resto llega con el evento `lobby_paired`.
      await call('lobby_answer', { request, accept: act === 'accept' });
    }
  } catch {
    // call() ya mostró el error.
  } finally {
    // Si la lista no cambia no se repinta: el botón tiene que volver solo.
    button.disabled = false;
    renderLobby();
  }
});

function onLobbyEvent(e) {
  switch (e.kind) {
    case 'lobby_users':
      net.users = e.users;
      // Lo pedido a alguien que se fue ya no espera.
      for (const id of [...net.outgoing.keys()]) if (!e.users.some((u) => u.id === id)) net.outgoing.delete(id);
      break;
    case 'lobby_request':
      net.incoming.set(e.request, e.from);
      toast(t('toast.wants_connect', { name: e.from.name }));
      break;
    case 'lobby_request_gone':
      net.incoming.delete(e.request);
      break;
    case 'lobby_answer': {
      const entry = [...net.outgoing].find(([, request]) => request === e.request);
      if (!entry) break;
      net.outgoing.delete(entry[0]);
      const name = net.users.find((u) => u.id === entry[0])?.name || '';
      if (e.reason === 'declined') toast(t('toast.connect_declined', { name }));
      break;
    }
    case 'lobby_paired':
      setPartner(e.partner);
      toast(t('toast.paired', { name: e.partner.name }));
      return;
    case 'lobby_error':
      net.error = e.detail;
      break;
  }
  renderLobby();
}

function setPartner(partner) {
  net.partner = partner;
  addRemotePeer({ code: partner.code, name: partner.name, os: partner.platform, partner: true });
  setNetState('paired');
}

function dropPartner() {
  net.partner = null;
  peers.delete('partner');
  renderPeers();
}

// La pareja se desconectó: el backend ya volvió a solo red local.
function onUnpair(peer, name) {
  if (net.partner?.code !== peer) return;
  dropPartner();
  setNetState('offline');
  toast(t('toast.partner_left', { name }));
}

$('#lang').addEventListener('change', renderNet);

// Ajustes: el server.
$('#set-server').addEventListener('change', async (ev) => {
  const server = ev.target.value.trim();
  if (!server || server === settings?.server) return;
  try {
    await call('set_server', { server });
    settings.server = server;
    toast(t('toast.saved'));
  } catch {
    ev.target.value = settings?.server || '';
  }
});
