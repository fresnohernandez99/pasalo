//! Canal "talk": chat de texto e imágenes y señalización de llamadas entre dos
//! equipos, por iroh. La conexión va cifrada con QUIC/TLS y autenticada con
//! la clave de cada equipo (el código que se comparten), así que es de punto
//! a punto: un relay, si lo hay, solo ve bytes cifrados.
//!
//! Hay una conexión por pareja de equipos y se reutiliza. Cada mensaje viaja
//! en su propio stream bidireccional (JSON con la longitud delante, más los
//! bytes de la imagen si la hay) y el otro lado contesta con un `Ack`. La voz
//! de las llamadas va en datagramas de esa misma conexión (ver [`VoiceLink`]).
//!
//! Los mensajes que no se pueden entregar quedan pendientes y se reintentan
//! solos; el receptor descarta los repetidos por su id.

use std::collections::HashMap;
use std::io;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use iroh::EndpointId;
use iroh::endpoint::Connection;
use serde::{Deserialize, Serialize};
use serde::de::DeserializeOwned;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::protocol::{LONG, SHORT, timed};
use crate::{Error, Event, EventSender, Remote};

pub const TALK_ALPN: &[u8] = b"pasalo/talk/1";
/// Tamaño máximo de una imagen del chat.
pub const MAX_IMAGE: u64 = 25 * 1024 * 1024;
const MAX_FRAME: usize = 256 * 1024;
const RETRY_EVERY: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Escrito aquí, todavía sin entregar.
    Pending,
    /// El otro equipo confirmó que lo recibió.
    Delivered,
    /// Llegó del otro equipo.
    Received,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    /// Código del otro equipo.
    pub peer: String,
    pub outgoing: bool,
    /// Milisegundos desde la época Unix, según el reloj de quien lo escribió.
    pub ts: u64,
    pub text: Option<String>,
    /// Imagen guardada en disco.
    pub image: Option<PathBuf>,
    pub status: Status,
}

/// Señal de una llamada. El núcleo solo la transporta: qué significa cada
/// `kind` (invite, accept, hangup, sdp, ice…) lo decide la interfaz.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Signal {
    pub call: String,
    pub kind: String,
    #[serde(default)]
    pub data: serde_json::Value,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Frame {
    Chat { id: String, ts: u64, name: String, text: Option<String>, image: Option<ImageMeta> },
    Signal { name: String, signal: Signal },
    Ack,
}

#[derive(Serialize, Deserialize)]
struct ImageMeta {
    ext: String,
    size: u64,
}

/// Canal de voz con un equipo: datagramas QUIC, no fiables y sin reenvíos.
pub struct VoiceLink {
    pub sender: VoiceSender,
    pub rx: mpsc::UnboundedReceiver<Bytes>,
}

/// Lado de envío de un [`VoiceLink`]; se puede clonar y usar desde otro hilo.
#[derive(Clone)]
pub struct VoiceSender(Connection);

impl VoiceSender {
    /// Envía un paquete. Si no cabe o la conexión se cerró, se descarta.
    pub fn send(&self, packet: Bytes) -> bool {
        self.0.send_datagram(packet).is_ok()
    }

    /// Tamaño máximo de un datagrama en esta conexión.
    pub fn max_size(&self) -> usize {
        self.0.max_datagram_size().unwrap_or(0)
    }

    /// Bytes medidos que han salido y entrado por esta conexión, con las
    /// cabeceras IPv4 y UDP (28 bytes por datagrama). Incluye todo lo que
    /// viaja por ella: voz, mensajes, acuses y pings de QUIC.
    pub fn wire_bytes(&self) -> (u64, u64) {
        let stats = self.0.stats();
        (stats.udp_tx.bytes + 28 * stats.udp_tx.datagrams, stats.udp_rx.bytes + 28 * stats.udp_rx.datagrams)
    }
}

#[derive(Clone)]
pub struct Talk {
    inner: Arc<Inner>,
}

struct Inner {
    remote: Remote,
    name: RwLock<String>,
    events: EventSender,
    store: Store,
    conns: tokio::sync::Mutex<HashMap<EndpointId, Connection>>,
    /// IP:puerto de iroh de los equipos de la LAN, sacado del descubrimiento.
    lan: Mutex<HashMap<EndpointId, SocketAddr>>,
    voice: Mutex<HashMap<EndpointId, mpsc::UnboundedSender<Bytes>>>,
    /// Mensajes salientes sin entregar, por id.
    pending: Mutex<HashMap<String, ChatMessage>>,
    /// Entregas en curso, para no lanzar dos a la vez del mismo mensaje.
    delivering: Mutex<HashMap<String, (u64, tokio::task::AbortHandle)>>,
    attempts: std::sync::atomic::AtomicU64,
}

impl Talk {
    /// `dir` guarda el historial (un `.jsonl` por equipo) y las imágenes.
    pub fn new(remote: Remote, name: impl Into<String>, dir: impl Into<PathBuf>, events: EventSender) -> Self {
        let store = Store { dir: dir.into() };
        let pending = store.pending().into_iter().map(|m| (m.id.clone(), m)).collect();
        let talk = Self {
            inner: Arc::new(Inner {
                remote,
                name: RwLock::new(name.into()),
                events,
                store,
                conns: Default::default(),
                lan: Default::default(),
                voice: Default::default(),
                pending: Mutex::new(pending),
                delivering: Default::default(),
                attempts: Default::default(),
            }),
        };
        let retrying = talk.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(RETRY_EVERY);
            loop {
                tick.tick().await;
                retrying.retry(None);
            }
        });
        talk
    }

    pub fn set_name(&self, name: impl Into<String>) {
        *self.inner.name.write().unwrap() = name.into();
    }

    /// Apunta la dirección de iroh de un equipo de la LAN y reintenta lo que
    /// tuviera pendiente: ahora puede que se llegue a él sin internet.
    pub fn set_lan_addr(&self, code: &str, addr: SocketAddr) {
        let Some(id) = crate::parse_code(code) else { return };
        let changed = self.inner.lan.lock().unwrap().insert(id, addr) != Some(addr);
        if changed {
            self.retry(Some(code));
        }
    }

    pub fn history(&self, peer: &str) -> Vec<ChatMessage> {
        self.inner.store.history(peer)
    }

    pub async fn send_text(&self, peer: &str, text: String) -> Result<ChatMessage, Error> {
        self.queue(peer, Some(text), None)
    }

    /// `ext` es la extensión de la imagen (`jpg`, `png`…).
    pub async fn send_image(&self, peer: &str, image: &[u8], ext: &str) -> Result<ChatMessage, Error> {
        if image.len() as u64 > MAX_IMAGE {
            return Err(Error::Protocol(format!("la imagen supera {} MB", MAX_IMAGE / 1024 / 1024)));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let path = self.inner.store.media_path(&id, ext);
        std::fs::create_dir_all(path.parent().expect("con carpeta")).map_err(Error::Local)?;
        std::fs::write(&path, image).map_err(Error::Local)?;
        self.queue_with_id(id, peer, None, Some(path))
    }

    /// Envía una señal de llamada y espera a que el otro la confirme. No se
    /// reintenta: una señal vieja no sirve de nada.
    pub async fn signal(&self, peer: &str, signal: Signal) -> Result<(), Error> {
        let id = parse_peer(peer)?;
        let name = self.inner.name.read().unwrap().clone();
        let conn = self.connection(id).await?;
        exchange(&conn, &Frame::Signal { name, signal }, None).await
    }

    /// Abre el canal de voz con `peer`. Los datagramas que lleguen de ese
    /// equipo, por cualquier conexión, salen por `rx`.
    pub async fn voice(&self, peer: &str) -> Result<VoiceLink, Error> {
        let id = parse_peer(peer)?;
        let conn = self.connection(id).await?;
        let (tx, rx) = mpsc::unbounded_channel();
        self.inner.voice.lock().unwrap().insert(id, tx);
        Ok(VoiceLink { sender: VoiceSender(conn), rx })
    }

    /// Deja de entregar datagramas de voz de `peer`.
    pub fn end_voice(&self, peer: &str) {
        if let Some(id) = crate::parse_code(peer) {
            self.inner.voice.lock().unwrap().remove(&id);
        }
    }

    /// Atiende una conexión entrante del protocolo talk.
    pub(crate) fn accept(&self, conn: Connection) {
        let this = self.clone();
        tokio::spawn(async move { this.serve(conn).await });
    }

    fn queue(&self, peer: &str, text: Option<String>, image: Option<PathBuf>) -> Result<ChatMessage, Error> {
        self.queue_with_id(uuid::Uuid::new_v4().to_string(), peer, text, image)
    }

    fn queue_with_id(
        &self,
        id: String,
        peer: &str,
        text: Option<String>,
        image: Option<PathBuf>,
    ) -> Result<ChatMessage, Error> {
        parse_peer(peer)?;
        let message = ChatMessage {
            id,
            peer: normalize(peer),
            outgoing: true,
            ts: now_ms(),
            text,
            image,
            status: Status::Pending,
        };
        self.inner.store.append(&message).map_err(Error::Local)?;
        self.inner.pending.lock().unwrap().insert(message.id.clone(), message.clone());
        self.spawn_delivery(message.clone());
        Ok(message)
    }

    /// Reintenta los mensajes pendientes (de un equipo o de todos).
    pub fn retry(&self, peer: Option<&str>) {
        let peer = peer.map(normalize);
        let pending: Vec<ChatMessage> = self
            .inner
            .pending
            .lock()
            .unwrap()
            .values()
            .filter(|m| peer.as_ref().is_none_or(|p| *p == m.peer))
            .cloned()
            .collect();
        for message in pending {
            self.spawn_delivery(message);
        }
    }

    /// Lanza la entrega de `message`. Si ya había un intento en curso se
    /// cancela: quien pide otro es porque algo cambió (p. ej. la dirección del
    /// equipo) y esperar a que el viejo se rinda tardaría hasta 30 s. Si se
    /// corta a mitad, el receptor descarta el repetido por su id.
    fn spawn_delivery(&self, message: ChatMessage) {
        let attempt = self.inner.attempts.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut delivering = self.inner.delivering.lock().unwrap();
        let this = self.clone();
        let key = message.id.clone();
        let id = key.clone();
        let task = tokio::spawn(async move {
            if let Err(e) = this.deliver(message).await {
                tracing::debug!("mensaje {id} sin entregar: {e}");
            }
            let mut delivering = this.inner.delivering.lock().unwrap();
            if delivering.get(&id).is_some_and(|(a, _)| *a == attempt) {
                delivering.remove(&id);
            }
        });
        if let Some((_, old)) = delivering.insert(key, (attempt, task.abort_handle())) {
            old.abort();
        }
    }

    async fn deliver(&self, mut message: ChatMessage) -> Result<(), Error> {
        let id = parse_peer(&message.peer)?;
        let conn = self.connection(id).await?;
        let image = match &message.image {
            Some(path) => {
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("jpg").to_string();
                let size = std::fs::metadata(path).map_err(Error::Local)?.len();
                Some((ImageMeta { ext, size }, path.clone()))
            }
            None => None,
        };
        let (meta, path) = match image {
            Some((meta, path)) => (Some(meta), Some(path)),
            None => (None, None),
        };
        let frame = Frame::Chat {
            id: message.id.clone(),
            ts: message.ts,
            name: self.inner.name.read().unwrap().clone(),
            text: message.text.clone(),
            image: meta,
        };
        exchange(&conn, &frame, path.as_deref()).await?;

        message.status = Status::Delivered;
        self.inner.store.append(&message).map_err(Error::Local)?;
        self.inner.pending.lock().unwrap().remove(&message.id);
        let _ = self.inner.events.send(Event::Chat { message, name: None });
        Ok(())
    }

    /// Conexión con `id`: la que ya hubiera abierta o una nueva.
    async fn connection(&self, id: EndpointId) -> Result<Connection, Error> {
        if let Some(conn) = self.inner.conns.lock().await.get(&id)
            && conn.close_reason().is_none()
        {
            return Ok(conn.clone());
        }
        let lan = self.inner.lan.lock().unwrap().get(&id).copied();
        let conn = self.inner.remote.connect(id, TALK_ALPN, lan).await?;
        self.inner.conns.lock().await.insert(id, conn.clone());
        let this = self.clone();
        let serving = conn.clone();
        tokio::spawn(async move { this.serve(serving).await });
        Ok(conn)
    }

    /// Atiende los mensajes y los datagramas que lleguen por `conn`, sea
    /// entrante o abierta por nosotros: el otro lado reutiliza la conexión.
    async fn serve(&self, conn: Connection) {
        let id = conn.remote_id();
        self.inner.conns.lock().await.entry(id).or_insert_with(|| conn.clone());
        let datagrams = {
            let this = self.clone();
            let conn = conn.clone();
            async move {
                while let Ok(packet) = conn.read_datagram().await {
                    if let Some(tx) = this.inner.voice.lock().unwrap().get(&id) {
                        let _ = tx.send(packet);
                    }
                }
            }
        };
        let streams = async {
            while let Ok((send, recv)) = conn.accept_bi().await {
                let this = self.clone();
                tokio::spawn(async move {
                    if let Err(e) = this.handle(id, send, recv).await {
                        tracing::debug!("mensaje de {} fallido: {e}", id.fmt_short());
                    }
                });
            }
        };
        tokio::join!(datagrams, streams);
        let mut conns = self.inner.conns.lock().await;
        if conns.get(&id).is_some_and(|c| c.stable_id() == conn.stable_id()) {
            conns.remove(&id);
        }
    }

    async fn handle(
        &self,
        from: EndpointId,
        mut send: iroh::endpoint::SendStream,
        mut recv: iroh::endpoint::RecvStream,
    ) -> Result<(), Error> {
        let peer = from.to_string();
        match read_frame(&mut recv).await? {
            Frame::Chat { id, ts, name, text, image } => {
                let known = self.inner.store.history(&peer).iter().any(|m| m.id == id);
                let mut saved = None;
                if let Some(meta) = image {
                    if meta.size > MAX_IMAGE {
                        return Err(Error::Protocol("imagen demasiado grande".into()));
                    }
                    let mut bytes = vec![0; meta.size as usize];
                    timed(LONG, AsyncReadExt::read_exact(&mut recv, &mut bytes)).await?;
                    if !known {
                        let path = self.inner.store.media_path(&id, &meta.ext);
                        std::fs::create_dir_all(path.parent().expect("con carpeta"))?;
                        std::fs::write(&path, &bytes)?;
                        saved = Some(path);
                    }
                }
                write_frame(&mut send, &Frame::Ack).await?;
                let _ = send.finish();
                // Un reintento de algo que ya teníamos: basta con confirmarlo.
                if known {
                    return Ok(());
                }
                let message = ChatMessage { id, peer, outgoing: false, ts, text, image: saved, status: Status::Received };
                self.inner.store.append(&message)?;
                let _ = self.inner.events.send(Event::Chat { message, name: Some(name) });
            }
            Frame::Signal { name, signal } => {
                write_frame(&mut send, &Frame::Ack).await?;
                let _ = send.finish();
                let _ = self.inner.events.send(Event::Signal { peer, name, signal });
            }
            Frame::Ack => return Err(Error::Protocol("acuse inesperado".into())),
        }
        Ok(())
    }
}

/// Envía `frame` (y el archivo `body`, si lo hay) en un stream nuevo y espera el acuse.
async fn exchange(conn: &Connection, frame: &Frame, body: Option<&Path>) -> Result<(), Error> {
    let (mut send, mut recv) = timed(SHORT, async { conn.open_bi().await.map_err(io::Error::other) }).await?;
    write_frame(&mut send, frame).await?;
    if let Some(path) = body {
        let bytes = tokio::fs::read(path).await.map_err(Error::Local)?;
        timed(LONG, AsyncWriteExt::write_all(&mut send, &bytes)).await?;
    }
    let _ = send.finish();
    match read_frame(&mut recv).await? {
        Frame::Ack => Ok(()),
        _ => Err(Error::Protocol("se esperaba un acuse".into())),
    }
}

async fn write_frame<W: AsyncWrite + Unpin, T: Serialize>(w: &mut W, frame: &T) -> Result<(), Error> {
    let buf = serde_json::to_vec(frame).map_err(|e| Error::Protocol(e.to_string()))?;
    timed(SHORT, async {
        w.write_u32(buf.len() as u32).await?;
        w.write_all(&buf).await?;
        w.flush().await
    })
    .await
}

async fn read_frame<R: AsyncRead + Unpin, T: DeserializeOwned>(r: &mut R) -> Result<T, Error> {
    let len = timed(LONG, r.read_u32()).await? as usize;
    if len > MAX_FRAME {
        return Err(Error::Protocol(format!("mensaje demasiado grande ({len} bytes)")));
    }
    let mut buf = vec![0; len];
    timed(SHORT, r.read_exact(&mut buf)).await?;
    serde_json::from_slice(&buf).map_err(|e| Error::Protocol(e.to_string()))
}

fn parse_peer(peer: &str) -> Result<EndpointId, Error> {
    crate::parse_code(peer).ok_or_else(|| Error::Protocol(format!("código no válido: {peer}")))
}

/// El código siempre en hex minúsculas, para que el historial no se parta.
fn normalize(peer: &str) -> String {
    crate::parse_code(peer).map_or_else(|| peer.to_string(), |id| id.to_string())
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Historial en disco: un `.jsonl` por equipo al que se van añadiendo líneas.
/// Un cambio de estado es otra línea con el mismo id; al leer gana la última.
struct Store {
    dir: PathBuf,
}

impl Store {
    fn file(&self, peer: &str) -> PathBuf {
        self.dir.join(format!("{}.jsonl", normalize(peer)))
    }

    fn media_path(&self, id: &str, ext: &str) -> PathBuf {
        let ext: String = ext.chars().filter(char::is_ascii_alphanumeric).take(5).collect();
        let ext = if ext.is_empty() { "bin".to_string() } else { ext.to_lowercase() };
        self.dir.join("media").join(format!("{id}.{ext}"))
    }

    fn append(&self, message: &ChatMessage) -> io::Result<()> {
        use std::io::Write;
        std::fs::create_dir_all(&self.dir)?;
        let mut line = serde_json::to_vec(message)?;
        line.push(b'\n');
        std::fs::OpenOptions::new().create(true).append(true).open(self.file(&message.peer))?.write_all(&line)
    }

    fn history(&self, peer: &str) -> Vec<ChatMessage> {
        read_history(&self.file(peer))
    }

    fn pending(&self) -> Vec<ChatMessage> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return Vec::new() };
        entries
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
            .flat_map(|e| read_history(&e.path()))
            .filter(|m| m.outgoing && m.status == Status::Pending)
            .collect()
    }
}

fn read_history(path: &Path) -> Vec<ChatMessage> {
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    let mut order = Vec::new();
    let mut latest: HashMap<String, ChatMessage> = HashMap::new();
    for line in text.lines() {
        let Ok(message) = serde_json::from_str::<ChatMessage>(line) else { continue };
        if !latest.contains_key(&message.id) {
            order.push(message.id.clone());
        }
        latest.insert(message.id.clone(), message);
    }
    order.into_iter().filter_map(|id| latest.remove(&id)).collect()
}
