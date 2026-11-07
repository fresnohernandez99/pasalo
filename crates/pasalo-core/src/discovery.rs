//! Descubrimiento de equipos por UDP broadcast, como Dukto: cada equipo se
//! anuncia periódicamente y los demás contestan al recibir un anuncio nuevo. Un equipo que deja de anunciarse desaparece de la lista.
//!
//! En Android hace falta tener un `WifiManager.MulticastLock` adquirido para
//! recibir broadcasts.

use std::collections::HashMap;
use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, Socket, Type};
use tokio::net::UdpSocket;
use tokio::task::JoinHandle;

use crate::protocol::PROTOCOL_VERSION;
use crate::{Event, EventSender, LocalInfo};

const MAGIC: &str = "pasalo";
const ANNOUNCE_EVERY: Duration = Duration::from_secs(5);
const EXPIRE_AFTER: Duration = Duration::from_secs(16);
/// Mientras un equipo se anunció hace menos de esto, nadie más puede ocupar
/// su `device_id` desde otra IP o con otro código.
const TRUST_FOR: Duration = Duration::from_secs(12);
/// Equipos que se recuerdan a la vez (una red llena de anuncios falsos no
/// puede llenar la memoria ni la lista).
const MAX_PEERS: usize = 256;
/// Respuestas a anuncios: como mucho una por este tiempo.
const REPLY_EVERY: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Peer {
    pub device_id: String,
    pub name: String,
    pub platform: String,
    /// Dirección TCP donde recibe archivos.
    pub addr: SocketAddr,
    /// Código de iroh, si tiene conexiones remotas activas.
    pub code: Option<String>,
    /// Dirección UDP de iroh en la LAN (para el chat y las llamadas sin internet).
    pub remote_addr: Option<SocketAddr>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Announce,
    Reply,
    Bye,
}

#[derive(Serialize, Deserialize)]
struct Beacon {
    app: String,
    version: u32,
    kind: Kind,
    device_id: String,
    name: String,
    platform: String,
    port: u16,
    // Opcionales para seguir entendiéndose con versiones que no los mandan.
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    remote_port: Option<u16>,
}

type PeerMap = Arc<Mutex<HashMap<String, (Peer, Instant)>>>;

pub struct Discovery {
    socket: Arc<UdpSocket>,
    local: LocalInfo,
    port: u16,
    peers: PeerMap,
    tasks: Vec<JoinHandle<()>>,
}

impl Discovery {
    pub async fn start(local: LocalInfo, port: u16, events: EventSender) -> io::Result<Self> {
        let socket = Arc::new(bind_udp(port)?);
        let peers = PeerMap::default();
        let tasks = vec![
            tokio::spawn(recv_loop(socket.clone(), local.clone(), port, peers.clone(), events.clone())),
            tokio::spawn(announce_loop(socket.clone(), local.clone(), port)),
            tokio::spawn(prune_loop(peers.clone(), events)),
        ];
        Ok(Self { socket, local, port, peers, tasks })
    }

    pub fn peers(&self) -> Vec<Peer> {
        let mut peers: Vec<Peer> = self.peers.lock().unwrap().values().map(|(p, _)| p.clone()).collect();
        peers.sort_by(|a, b| a.name.cmp(&b.name));
        peers
    }

    /// Anuncia este equipo ya, sin esperar al siguiente anuncio periódico.
    pub async fn announce(&self) {
        broadcast(&self.socket, &beacon(&self.local, Kind::Announce), self.port).await;
    }

    /// Avisa a los demás de que este equipo se va.
    pub async fn shutdown(self) {
        broadcast(&self.socket, &beacon(&self.local, Kind::Bye), self.port).await;
    }
}

impl Drop for Discovery {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

fn bind_udp(port: u16) -> io::Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    socket.set_reuse_address(true)?;
    // Permite varias instancias en el mismo equipo (útil para probar).
    #[cfg(unix)]
    socket.set_reuse_port(true)?;
    socket.set_broadcast(true)?;
    socket.set_nonblocking(true)?;
    socket.bind(&SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)).into())?;
    UdpSocket::from_std(socket.into())
}

fn beacon(local: &LocalInfo, kind: Kind) -> Vec<u8> {
    serde_json::to_vec(&Beacon {
        app: MAGIC.into(),
        version: PROTOCOL_VERSION,
        kind,
        device_id: local.device_id.clone(),
        name: local.name.clone(),
        platform: local.platform.clone(),
        port: local.transfer_port,
        code: local.code.clone(),
        remote_port: local.remote_port,
    })
    .expect("el beacon siempre se serializa")
}

/// Envía a 255.255.255.255 y a la dirección de broadcast de cada interfaz:
/// algunos sistemas (macOS sobre todo) solo sacan el broadcast global por una.
async fn broadcast(socket: &UdpSocket, msg: &[u8], port: u16) {
    let mut targets = vec![Ipv4Addr::BROADCAST];
    if let Ok(interfaces) = if_addrs::get_if_addrs() {
        for interface in interfaces {
            if let if_addrs::IfAddr::V4(v4) = interface.addr
                && !v4.ip.is_loopback()
                && let Some(b) = v4.broadcast
                && !targets.contains(&b)
            {
                targets.push(b);
            }
        }
    }
    for ip in targets {
        if let Err(e) = socket.send_to(msg, (ip, port)).await {
            tracing::debug!("no se pudo anunciar en {ip}: {e}");
        }
    }
}

async fn announce_loop(socket: Arc<UdpSocket>, local: LocalInfo, port: u16) {
    let msg = beacon(&local, Kind::Announce);
    let mut tick = tokio::time::interval(ANNOUNCE_EVERY);
    loop {
        tick.tick().await;
        broadcast(&socket, &msg, port).await;
    }
}

async fn recv_loop(socket: Arc<UdpSocket>, local: LocalInfo, port: u16, peers: PeerMap, events: EventSender) {
    let mut buf = vec![0u8; 4096];
    let mut last_reply: Option<Instant> = None;
    loop {
        let (n, from) = match socket.recv_from(&mut buf).await {
            Ok(received) => received,
            Err(e) => {
                tracing::debug!("error recibiendo anuncio: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let Ok(b) = serde_json::from_slice::<Beacon>(&buf[..n]) else { continue };
        if b.app != MAGIC || b.version != PROTOCOL_VERSION || b.device_id == local.device_id {
            continue;
        }
        if let Kind::Bye = b.kind {
            // Solo se despide el propio equipo (desde su IP), no cualquiera en su nombre.
            let gone = {
                let mut map = peers.lock().unwrap();
                let same = map.get(&b.device_id).is_some_and(|(known, _)| known.addr.ip() == from.ip());
                same && map.remove(&b.device_id).is_some()
            };
            if gone {
                let _ = events.send(Event::PeerLost { device_id: b.device_id });
            }
            continue;
        }
        let peer = Peer {
            device_id: b.device_id.clone(),
            name: b.name,
            platform: b.platform,
            addr: SocketAddr::new(from.ip(), b.port),
            code: b.code,
            remote_addr: b.remote_port.map(|port| SocketAddr::new(from.ip(), port)),
        };
        let is_new = {
            let mut map = peers.lock().unwrap();
            // Los anuncios no van firmados: mientras un equipo sigue
            // anunciándose, otro que diga ser él (otra IP u otro código) no lo
            // sustituye. Si deja de anunciarse (cambió de red), sí.
            let impostor = map.get(&b.device_id).is_some_and(|(known, seen)| {
                (known.addr.ip() != peer.addr.ip() || known.code != peer.code) && seen.elapsed() < TRUST_FOR
            });
            if impostor || (!map.contains_key(&b.device_id) && map.len() >= MAX_PEERS) {
                continue;
            }
            let changed = map.get(&b.device_id).is_none_or(|(known, _)| *known != peer);
            map.insert(b.device_id, (peer.clone(), Instant::now()));
            changed
        };
        if is_new {
            let _ = events.send(Event::PeerFound(peer));
            // Respuesta por broadcast y no unicast: con varias instancias en el
            // mismo equipo compartiendo puerto, el unicast solo llega a una.
            // Como mucho una cada poco, para que una avalancha de anuncios no
            // se convierta en otra.
            if let Kind::Announce = b.kind
                && last_reply.is_none_or(|at: Instant| at.elapsed() >= REPLY_EVERY)
            {
                last_reply = Some(Instant::now());
                broadcast(&socket, &beacon(&local, Kind::Reply), port).await;
            }
        }
    }
}

async fn prune_loop(peers: PeerMap, events: EventSender) {
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    loop {
        tick.tick().await;
        let expired: Vec<String> = {
            let mut map = peers.lock().unwrap();
            let expired: Vec<String> = map
                .iter()
                .filter(|(_, (_, seen))| seen.elapsed() > EXPIRE_AFTER)
                .map(|(id, _)| id.clone())
                .collect();
            for id in &expired {
                map.remove(id);
            }
            expired
        };
        for device_id in expired {
            let _ = events.send(Event::PeerLost { device_id });
        }
    }
}
