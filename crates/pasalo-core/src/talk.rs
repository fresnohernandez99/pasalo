//! Canal "talk": chat de texto e imágenes y señalización de llamadas entre dos
//! equipos, por iroh (QUIC, que va cifrado de por sí y autenticado con la
//! clave de cada equipo).
//!
//! Hay una conexión por pareja de equipos y se reutiliza. Cada mensaje viaja
//! en su propio stream bidireccional (JSON con la longitud delante, más los
//! bytes de la imagen si la hay) y el otro lado contesta con un `Ack`. La voz
//! de las llamadas va en datagramas de esa misma conexión (ver [`VoiceLink`])
//! y el vídeo, una imagen por stream unidireccional (ver [`VideoLink`]).
//! Una conexión sin uso se cierra a los [`IDLE`]: abierta, iroh manda un
//! keep-alive cada 5 s por cada ruta.
//!
//! Si se cae la conexión con un equipo con el que hay una llamada, sale
//! [`Event::TalkLost`].
//!
//! Los mensajes que no se pueden entregar quedan pendientes. Se reintentan en
//! cuanto el otro equipo aparece (se conecta o se le ve en la LAN) y, por si
//! acaso, cada vez más espaciados; el receptor descarta los repetidos por id.

use std::collections::{HashMap, HashSet};
use std::io;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
/// Tamaño máximo de una nota de voz (unos 40 min en Opus a 32 kbps).
pub const MAX_AUDIO: u64 = 10 * 1024 * 1024;
/// Las fotos de una vez llevan este prefijo en disco: `chat_image` no las sirve.
pub const ONCE_PREFIX: &str = "once-";
const MAX_FRAME: usize = 256 * 1024;
/// Primer reintento de un mensaje pendiente; cada fallo dobla la espera.
const RETRY_FIRST: Duration = Duration::from_secs(20);
const RETRY_MAX: Duration = Duration::from_secs(600);
/// Una imagen de vídeo comprimida nunca debería acercarse a esto.
const MAX_VIDEO_FRAME: usize = 1024 * 1024;
/// Primer byte de un stream unidireccional con una imagen de vídeo.
const STREAM_VIDEO: u8 = 1;
/// Si la imagen más vieja sin confirmar lleva esto en camino, la red no da
/// abasto: se descartan imágenes hasta que se ponga al día.
const VIDEO_MAX_LAG: Duration = Duration::from_millis(1000);
/// Imágenes por recibir en cola: si la interfaz no las recoge, sobran.
const VIDEO_QUEUE: usize = 64;
/// Paquetes de voz en cola (unos 10 s en el modo de más paquetes).
const VOICE_QUEUE: usize = 256;
/// Fotos del chat que se reciben a la vez de un mismo equipo.
const IMAGES_AT_ONCE: usize = 2;
/// Una imagen que no llega en este tiempo ya no sirve.
const VIDEO_TIMEOUT: Duration = Duration::from_secs(10);
/// Tiempo sin mensajes ni voz tras el que se cierra una conexión.
pub const IDLE: Duration = Duration::from_secs(90);
/// Pausa entre intentos de reconectar en [`Talk::hold`].
const HOLD_RETRY: Duration = Duration::from_secs(2);

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
    /// Registro de una llamada (solo local, no se envía): lo que muestra el
    /// chat como «Llamada de voz · 3:21» y sus detalles. Ver [`Talk::log_call`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call: Option<serde_json::Value>,
    /// Nota de voz guardada en disco.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio: Option<PathBuf>,
    /// Lo que dura la nota de voz.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Foto de una sola vez: solo se ve con [`Talk::open_once`], que la borra.
    /// Quien la envía tampoco se queda con ella.
    #[serde(default, skip_serializing_if = "is_false")]
    pub once: bool,
    /// Una foto de una vez que ya se vio (aquí o, si es nuestra, allí).
    #[serde(default, skip_serializing_if = "is_false")]
    pub opened: bool,
    /// Registro local de algo que pasó con este equipo fuera del chat (solo
    /// aquí, no se envía): una partida (`type: game`) o archivos enviados o
    /// recibidos (`type: files`). Lo que lleva lo decide la interfaz; ver
    /// [`Talk::log_event`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log: Option<serde_json::Value>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl ChatMessage {
    fn new(id: String, peer: String, outgoing: bool, ts: u64, status: Status) -> Self {
        Self {
            id,
            peer,
            outgoing,
            ts,
            text: None,
            image: None,
            status,
            call: None,
            audio: None,
            duration_ms: None,
            once: false,
            opened: false,
            log: None,
        }
    }
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
    /// Mensaje: texto, foto (`image`) o nota de voz (`audio`). Los bytes del
    /// adjunto van detrás. Un equipo viejo ignora `audio` (no lo conoce).
    Chat {
        id: String,
        ts: u64,
        name: String,
        text: Option<String>,
        image: Option<ImageMeta>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        audio: Option<AudioMeta>,
    },
    /// Foto de una sola vez. Tipo aparte a propósito: un equipo que no lo
    /// conoce no la acepta (no la confirma), en vez de guardarla como una
    /// foto normal.
    Once { id: String, ts: u64, name: String, image: ImageMeta },
    /// La foto de una vez `id` ya se vio al otro lado.
    Opened { id: String },
    Signal { name: String, signal: Signal },
    Ack,
}

#[derive(Serialize, Deserialize)]
struct AudioMeta {
    ext: String,
    size: u64,
    #[serde(default)]
    duration_ms: u64,
}

#[derive(Serialize, Deserialize)]
struct ImageMeta {
    ext: String,
    size: u64,
}

/// Canal de voz con un equipo: datagramas QUIC, no fiables y sin reenvíos.
pub struct VoiceLink {
    pub sender: VoiceSender,
    pub rx: mpsc::Receiver<Bytes>,
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

/// Canal de vídeo con un equipo. Cada imagen va en su propio stream
/// unidireccional: llega entera o no llega, y una que se retrasa no frena a
/// los mensajes del chat.
pub struct VideoLink {
    pub sender: VideoSender,
    pub rx: mpsc::Receiver<Bytes>,
}

/// Lado de envío de un [`VideoLink`].
#[derive(Clone)]
pub struct VideoSender {
    conn: Connection,
    /// Imágenes enviadas y sin confirmar, por orden de envío.
    in_flight: Arc<Mutex<BTreeMap<u64, Instant>>>,
    next: Arc<std::sync::atomic::AtomicU64>,
}

impl VideoSender {
    /// Envía una imagen. Devuelve `false` si se descartó porque la red va
    /// atrasada: la siguiente que se mande tiene que ser una imagen clave.
    /// Hay que llamarla dentro de un runtime de tokio.
    pub fn send(&self, frame: Bytes) -> bool {
        let seq = {
            let mut in_flight = self.in_flight.lock().unwrap();
            if in_flight.values().next().is_some_and(|sent| sent.elapsed() > VIDEO_MAX_LAG) {
                return false;
            }
            let seq = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            in_flight.insert(seq, Instant::now());
            seq
        };
        let (conn, in_flight) = (self.conn.clone(), self.in_flight.clone());
        tokio::spawn(async move {
            let mut stream = match tokio::time::timeout(VIDEO_TIMEOUT, conn.open_uni()).await {
                Ok(Ok(stream)) => stream,
                _ => {
                    in_flight.lock().unwrap().remove(&seq);
                    return;
                }
            };
            // Por detrás de los mensajes y las señales, que pesan poco.
            let _ = stream.set_priority(-1);
            let sent = async {
                stream.write_all(&[STREAM_VIDEO]).await.map_err(io::Error::other)?;
                stream.write_all(&frame).await.map_err(io::Error::other)?;
                stream.finish().map_err(io::Error::other)?;
                // Termina cuando el otro lado lo ha recibido todo.
                stream.stopped().await.map_err(io::Error::other)?;
                Ok::<_, io::Error>(())
            };
            match tokio::time::timeout(VIDEO_TIMEOUT, sent).await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => tracing::debug!("imagen de vídeo sin entregar: {e}"),
                Err(_) => {
                    // Una imagen vieja ya no sirve: si no se cancela, QUIC la
                    // sigue enviando y reenviando y le quita red a las nuevas.
                    let _ = stream.reset(0u32.into());
                    tracing::debug!("imagen de vídeo sin confirmar a tiempo");
                }
            }
            in_flight.lock().unwrap().remove(&seq);
        });
        true
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
    /// Último uso de cada conexión.
    used: Mutex<HashMap<EndpointId, Instant>>,
    /// Cuándo toca el siguiente reintento automático a cada equipo y cuántos
    /// fallos lleva.
    backoff: Mutex<HashMap<String, (Instant, u32)>>,
    /// IP:puerto de iroh de los equipos de la LAN, sacado del descubrimiento.
    lan: Mutex<HashMap<EndpointId, SocketAddr>>,
    /// Equipos cuya conexión se mantiene abierta aunque no se use (ver [`Talk::hold`]).
    pinned: Mutex<HashSet<EndpointId>>,
    voice: Mutex<HashMap<EndpointId, mpsc::Sender<Bytes>>>,
    video: Mutex<HashMap<EndpointId, mpsc::Sender<Bytes>>>,
    /// Mensajes salientes sin entregar, por id.
    pending: Mutex<HashMap<String, ChatMessage>>,
    /// Entregas en curso, para no lanzar dos a la vez del mismo mensaje.
    delivering: Mutex<HashMap<String, (u64, tokio::task::AbortHandle)>>,
    attempts: std::sync::atomic::AtomicU64,
    /// Fotos recibiéndose ahora, por equipo (ver [`IMAGES_AT_ONCE`]).
    receiving: Mutex<HashMap<EndpointId, usize>>,
    /// Equipos (código) con los que el chat es privado.
    private: Mutex<HashSet<String>>,
}

impl Talk {
    /// `dir` guarda el historial (un `.jsonl` por equipo) y las imágenes.
    pub fn new(remote: Remote, name: impl Into<String>, dir: impl Into<PathBuf>, events: EventSender) -> Self {
        let store = Store { dir: dir.into(), known: Default::default() };
        // Los chats privados se borran al desconectarse; si la app se cerró
        // sin desconectar, al volver a abrirla.
        let private = store.private();
        for peer in &private {
            store.wipe(peer);
        }
        let pending = store.pending().into_iter().map(|m| (m.id.clone(), m)).collect();
        let talk = Self {
            inner: Arc::new(Inner {
                remote,
                name: RwLock::new(name.into()),
                events,
                store,
                conns: Default::default(),
                used: Default::default(),
                backoff: Default::default(),
                lan: Default::default(),
                pinned: Default::default(),
                voice: Default::default(),
                video: Default::default(),
                pending: Mutex::new(pending),
                delivering: Default::default(),
                attempts: Default::default(),
                receiving: Default::default(),
                private: Mutex::new(private),
            }),
        };
        let ticking = talk.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(10));
            loop {
                tick.tick().await;
                ticking.retry_due();
                ticking.close_idle().await;
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
        let before = self.inner.lan.lock().unwrap().insert(id, addr);
        if before == Some(addr) {
            return;
        }
        // Otro puerto es otra instancia (la app se reinició): la conexión que
        // hubiera era con la vieja y ya no contesta. Reutilizarla dejaba los
        // mensajes colgados hasta que iroh la diera por muerta.
        if before.is_some() {
            let this = self.clone();
            let code = code.to_string();
            tokio::spawn(async move {
                this.forget_connection(id, None).await;
                this.retry(Some(&code));
            });
            return;
        }
        self.retry(Some(code));
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
        tokio::fs::create_dir_all(path.parent().expect("con carpeta")).await.map_err(Error::Local)?;
        tokio::fs::write(&path, image).await.map_err(Error::Local)?;
        self.queue_with_id(id, peer, None, Some(path))
    }

    /// Una nota de voz (`ext`: `webm`, `m4a`…; la interfaz la graba ya comprimida).
    pub async fn send_audio(&self, peer: &str, audio: &[u8], ext: &str, duration_ms: u64) -> Result<ChatMessage, Error> {
        if audio.len() as u64 > MAX_AUDIO {
            return Err(Error::Protocol(format!("la nota de voz supera {} MB", MAX_AUDIO / 1024 / 1024)));
        }
        let code = parse_peer(peer)?.to_string();
        let id = uuid::Uuid::new_v4().to_string();
        let path = self.inner.store.media_path(&id, ext);
        tokio::fs::create_dir_all(path.parent().expect("con carpeta")).await.map_err(Error::Local)?;
        tokio::fs::write(&path, audio).await.map_err(Error::Local)?;
        let mut message = ChatMessage::new(id, code, true, now_ms(), Status::Pending);
        message.audio = Some(path);
        message.duration_ms = Some(duration_ms);
        self.enqueue(message)
    }

    /// Una foto de una sola vez: se borra de aquí al entregarla y del otro
    /// lado al verla.
    pub async fn send_once(&self, peer: &str, image: &[u8], ext: &str) -> Result<ChatMessage, Error> {
        if image.len() as u64 > MAX_IMAGE {
            return Err(Error::Protocol(format!("la imagen supera {} MB", MAX_IMAGE / 1024 / 1024)));
        }
        let code = parse_peer(peer)?.to_string();
        let id = uuid::Uuid::new_v4().to_string();
        let path = self.inner.store.once_path(&id, ext);
        tokio::fs::create_dir_all(path.parent().expect("con carpeta")).await.map_err(Error::Local)?;
        write_private(&path, image).await.map_err(Error::Local)?;
        let mut message = ChatMessage::new(id, code, true, now_ms(), Status::Pending);
        message.image = Some(path);
        message.once = true;
        self.enqueue(message)
    }

    /// Abre una foto de una vez recibida: devuelve sus bytes y su extensión y
    /// la borra (ya no se puede volver a ver). Avisa al otro de que se vio.
    pub async fn open_once(&self, peer: &str, id: &str) -> Result<(Vec<u8>, String), Error> {
        let code = parse_peer(peer)?.to_string();
        let message = self
            .inner
            .store
            .history(&code)
            .into_iter()
            .find(|m| m.id == id && m.once && !m.outgoing && !m.opened)
            .ok_or_else(|| Error::Protocol("esa foto ya se vio".into()))?;
        let path = message.image.clone().filter(|p| self.inner.store.is_media(p)).ok_or_else(|| Error::Protocol("foto perdida".into()))?;
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("jpg").to_string();
        let bytes = tokio::fs::read(&path).await.map_err(Error::Local)?;
        shred(&path).await;
        let mut opened = message;
        opened.image = None;
        opened.opened = true;
        self.inner.store.append(&opened).map_err(Error::Local)?;
        let _ = self.inner.events.send(Event::Chat { message: opened, name: None });
        // Que el otro sepa que se vio (si no se puede ahora, da igual).
        let this = self.clone();
        let id = id.to_string();
        tokio::spawn(async move {
            let Ok(target) = parse_peer(&code) else { return };
            for _ in 0..3 {
                if let Ok(conn) = this.connection(target).await
                    && exchange(&conn, &Frame::Opened { id: id.clone() }, None).await.is_ok()
                {
                    return;
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        });
        Ok((bytes, ext))
    }

    /// Si el chat con `peer` es privado: su historial se borra al desconectarse.
    pub fn is_private(&self, peer: &str) -> bool {
        self.inner.private.lock().unwrap().contains(&normalize(peer))
    }

    /// Marca (o desmarca) el chat con `peer` como privado. Lo de avisar al
    /// otro equipo es cosa de quien lo llama (una señal `private`).
    pub fn set_private(&self, peer: &str, on: bool) -> Result<(), Error> {
        let peer = parse_peer(peer)?.to_string();
        let mut private = self.inner.private.lock().unwrap();
        if on {
            private.insert(peer);
        } else {
            private.remove(&peer);
        }
        self.inner.store.save_private(&private).map_err(Error::Local)
    }

    /// Si el chat con `peer` es privado, borra su historial (mensajes, fotos y
    /// notas de voz) y lo que quedara pendiente de enviarle. Devuelve si borró.
    pub fn wipe_private(&self, peer: &str) -> bool {
        let peer = normalize(peer);
        if !self.inner.private.lock().unwrap().contains(&peer) {
            return false;
        }
        // Lo pendiente para ese equipo (y su entrega en curso), fuera.
        let gone: Vec<String> = {
            let mut pending = self.inner.pending.lock().unwrap();
            let ids = pending.values().filter(|m| m.peer == peer).map(|m| m.id.clone()).collect();
            pending.retain(|_, m| m.peer != peer);
            ids
        };
        let mut delivering = self.inner.delivering.lock().unwrap();
        for id in &gone {
            if let Some((_, task)) = delivering.remove(id) {
                task.abort();
            }
        }
        drop(delivering);
        self.inner.store.wipe(&peer);
        let _ = self.inner.events.send(Event::ChatWiped { peer });
        true
    }

    /// Deja en el historial de `peer` el registro de una llamada (`record`
    /// lo arma la interfaz: id, quién llamó, cómo acabó, duración, consumo…).
    /// Es solo local: cada lado guarda el suyo y no se envía.
    pub fn log_call(&self, peer: &str, record: serde_json::Value) -> Result<ChatMessage, Error> {
        parse_peer(peer)?;
        let call_id: Option<String> = record
            .get("id")
            .and_then(|v| v.as_str())
            .map(|id| id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(80).collect())
            .filter(|id: &String| !id.is_empty());
        let id = format!("call-{}", call_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()));
        let outgoing = record.get("role").and_then(|v| v.as_str()) == Some("caller");
        let ts = record.get("started").and_then(|v| v.as_u64()).filter(|t| *t > 0).unwrap_or_else(now_ms);
        let mut message =
            ChatMessage::new(id, normalize(peer), outgoing, ts, if outgoing { Status::Delivered } else { Status::Received });
        message.call = Some(record);
        self.inner.store.append(&message).map_err(Error::Local)?;
        Ok(message)
    }

    /// Deja en el chat con `peer` un registro local (`record`, ver
    /// [`ChatMessage::log`]). Con el mismo `id` (si lo trae), uno nuevo pisa
    /// al anterior en su sitio; `outgoing` dice de qué lado sale.
    pub fn log_event(&self, peer: &str, record: serde_json::Value) -> Result<ChatMessage, Error> {
        parse_peer(peer)?;
        let clean = |v: Option<&serde_json::Value>, len: usize| -> String {
            let raw = v.and_then(|v| v.as_str()).unwrap_or_default();
            raw.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(len).collect()
        };
        let kind = Some(clean(record.get("type"), 16)).filter(|k| !k.is_empty()).unwrap_or_else(|| "log".into());
        let key = Some(clean(record.get("id"), 80)).filter(|k| !k.is_empty()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let outgoing = record.get("outgoing").and_then(|v| v.as_bool()).unwrap_or(false);
        let mut message = ChatMessage::new(
            format!("{kind}-{key}"),
            normalize(peer),
            outgoing,
            now_ms(),
            if outgoing { Status::Delivered } else { Status::Received },
        );
        message.log = Some(record);
        self.inner.store.append(&message).map_err(Error::Local)?;
        Ok(message)
    }

    /// Envía una señal de llamada y espera a que el otro la confirme. No se
    /// reintenta: una señal vieja no sirve de nada.
    pub async fn signal(&self, peer: &str, signal: Signal) -> Result<(), Error> {
        let id = parse_peer(peer)?;
        let name = self.inner.name.read().unwrap().clone();
        let conn = self.connection(id).await?;
        let sent = exchange(&conn, &Frame::Signal { name, signal }, None).await;
        // En plena llamada la conexión lleva la voz: una señal que no llega
        // (p. ej. pedir una imagen clave por un relay lento) no es motivo para
        // abrir otra.
        let in_call = self.inner.voice.lock().unwrap().contains_key(&id) || self.inner.video.lock().unwrap().contains_key(&id);
        if sent.is_err() && !in_call {
            self.forget_connection(id, Some(&conn)).await;
        }
        sent
    }

    /// Abre el canal de voz con `peer`. Los datagramas que lleguen de ese
    /// equipo, por cualquier conexión, salen por `rx`.
    pub async fn voice(&self, peer: &str) -> Result<VoiceLink, Error> {
        let id = parse_peer(peer)?;
        let conn = self.connection(id).await?;
        let (tx, rx) = mpsc::channel(VOICE_QUEUE);
        self.inner.voice.lock().unwrap().insert(id, tx);
        Ok(VoiceLink { sender: VoiceSender(conn), rx })
    }

    /// Deja de entregar datagramas de voz de `peer`.
    pub fn end_voice(&self, peer: &str) {
        if let Some(id) = crate::parse_code(peer) {
            self.inner.voice.lock().unwrap().remove(&id);
        }
    }

    /// Abre el canal de vídeo con `peer`. Las imágenes que lleguen de ese
    /// equipo salen por `rx`, cada una entera (pueden llegar desordenadas).
    pub async fn video(&self, peer: &str) -> Result<VideoLink, Error> {
        let id = parse_peer(peer)?;
        let conn = self.connection(id).await?;
        let (tx, rx) = mpsc::channel(VIDEO_QUEUE);
        self.inner.video.lock().unwrap().insert(id, tx);
        let sender = VideoSender { conn, in_flight: Default::default(), next: Default::default() };
        Ok(VideoLink { sender, rx })
    }

    /// Deja de entregar el vídeo de `peer`.
    pub fn end_video(&self, peer: &str) {
        if let Some(id) = crate::parse_code(peer) {
            self.inner.video.lock().unwrap().remove(&id);
        }
    }

    /// Mantiene abierta la conexión con `peer` (la pareja): si se cae, la
    /// vuelve a abrir. Termina con `true` al llamar a [`Talk::release`], o con
    /// `false` si no se logra conectar en `first` (la primera vez) o en
    /// `grace` (tras un corte): el otro se fue.
    pub async fn hold(&self, peer: &str, first: Duration, grace: Duration) -> bool {
        let Some(id) = crate::parse_code(peer) else { return false };
        self.inner.pinned.lock().unwrap().insert(id);
        let pinned = || self.inner.pinned.lock().unwrap().contains(&id);
        let mut wait = first;
        loop {
            let deadline = Instant::now() + wait;
            wait = grace;
            let conn = loop {
                if !pinned() {
                    return true;
                }
                match self.connection(id).await {
                    Ok(conn) => {
                        // Lo que quedó sin entregar mientras no estaba, ya.
                        self.retry(Some(peer));
                        break conn;
                    }
                    Err(e) if Instant::now() < deadline => {
                        tracing::debug!("sin conexión con {}: {e}", id.fmt_short());
                        tokio::time::sleep(HOLD_RETRY).await;
                    }
                    Err(_) => {
                        self.inner.pinned.lock().unwrap().remove(&id);
                        return false;
                    }
                }
            };
            conn.closed().await;
        }
    }

    /// Deja de hablar con `peer` (se desconectó o nos desconectamos): cierra
    /// la conexión, corta las entregas en curso y no reintenta lo pendiente
    /// hasta que vuelva a aparecer. Lo pendiente no se pierde.
    pub fn release(&self, peer: &str) {
        let Some(id) = crate::parse_code(peer) else { return };
        let peer = id.to_string();
        self.inner.pinned.lock().unwrap().remove(&id);
        self.inner.voice.lock().unwrap().remove(&id);
        self.inner.video.lock().unwrap().remove(&id);
        self.inner.used.lock().unwrap().remove(&id);
        {
            let pending = self.inner.pending.lock().unwrap();
            let mut delivering = self.inner.delivering.lock().unwrap();
            delivering.retain(|msg, (_, task)| {
                let theirs = pending.get(msg).is_some_and(|m| m.peer == peer);
                if theirs {
                    task.abort();
                }
                !theirs
            });
        }
        // Si está en la LAN se le sigue llegando sin internet: ahí no se espera.
        if !self.inner.lan.lock().unwrap().contains_key(&id) {
            self.inner.backoff.lock().unwrap().insert(peer, (Instant::now() + RETRY_MAX, 10));
        }
        let this = self.clone();
        tokio::spawn(async move {
            if let Some(conn) = this.inner.conns.lock().await.remove(&id) {
                conn.close(0u32.into(), b"desconectado");
            }
        });
    }

    /// Saca del caché la conexión con `id` (solo si es `which`, cuando se da)
    /// y la cierra, salvo que lleve una llamada: entonces la cierra quien la
    /// corte. La siguiente vez se conecta de nuevo.
    async fn forget_connection(&self, id: EndpointId, which: Option<&Connection>) {
        let mut conns = self.inner.conns.lock().await;
        let Some(conn) = conns.get(&id) else { return };
        if which.is_some_and(|w| w.stable_id() != conn.stable_id()) {
            return;
        }
        let conn = conns.remove(&id).expect("está");
        drop(conns);
        let in_call = self.inner.voice.lock().unwrap().contains_key(&id) || self.inner.video.lock().unwrap().contains_key(&id);
        if !in_call {
            conn.close(0u32.into(), b"sin respuesta");
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
        let mut message = ChatMessage::new(id, normalize(peer), true, now_ms(), Status::Pending);
        message.text = text;
        message.image = image;
        self.enqueue(message)
    }

    /// Guarda un mensaje propio y lanza su entrega.
    fn enqueue(&self, message: ChatMessage) -> Result<ChatMessage, Error> {
        self.inner.store.append(&message).map_err(Error::Local)?;
        self.inner.pending.lock().unwrap().insert(message.id.clone(), message.clone());
        self.spawn_delivery(message.clone());
        Ok(message)
    }

    /// Reintenta ya los mensajes pendientes (de un equipo o de todos), sin
    /// esperar a su turno.
    pub fn retry(&self, peer: Option<&str>) {
        let peer = peer.map(normalize);
        match &peer {
            Some(peer) => {
                self.inner.backoff.lock().unwrap().remove(peer);
            }
            None => self.inner.backoff.lock().unwrap().clear(),
        }
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

    /// Reintenta los pendientes de los equipos a los que ya les toca.
    fn retry_due(&self) {
        let now = Instant::now();
        let due: Vec<ChatMessage> = {
            let backoff = self.inner.backoff.lock().unwrap();
            let delivering = self.inner.delivering.lock().unwrap();
            self.inner
                .pending
                .lock()
                .unwrap()
                .values()
                .filter(|m| !delivering.contains_key(&m.id))
                .filter(|m| backoff.get(&m.peer).is_none_or(|(next, _)| *next <= now))
                .cloned()
                .collect()
        };
        for message in due {
            self.spawn_delivery(message);
        }
    }

    /// Un intento a `peer` falló: el siguiente automático, más tarde.
    fn failed(&self, peer: &str) {
        let mut backoff = self.inner.backoff.lock().unwrap();
        let fails = backoff.get(peer).map_or(0, |(_, n)| *n);
        let wait = RETRY_FIRST.saturating_mul(1 << fails.min(10)).min(RETRY_MAX);
        backoff.insert(peer.to_string(), (Instant::now() + wait, fails + 1));
    }

    fn touch(&self, id: EndpointId) {
        self.inner.used.lock().unwrap().insert(id, Instant::now());
    }

    /// Cierra las conexiones que llevan [`IDLE`] sin uso y sin llamada.
    async fn close_idle(&self) {
        let idle: Vec<EndpointId> = {
            let used = self.inner.used.lock().unwrap();
            let voice = self.inner.voice.lock().unwrap();
            let video = self.inner.video.lock().unwrap();
            let pinned = self.inner.pinned.lock().unwrap();
            used.iter()
                .filter(|(id, at)| {
                    at.elapsed() >= IDLE && !voice.contains_key(*id) && !video.contains_key(*id) && !pinned.contains(*id)
                })
                .map(|(id, _)| *id)
                .collect()
        };
        if idle.is_empty() {
            return;
        }
        let mut conns = self.inner.conns.lock().await;
        let mut used = self.inner.used.lock().unwrap();
        for id in idle {
            used.remove(&id);
            if let Some(conn) = conns.remove(&id) {
                conn.close(0u32.into(), b"inactiva");
            }
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
        let peer = message.peer.clone();
        let task = tokio::spawn(async move {
            if let Err(e) = this.deliver(message).await {
                tracing::debug!("mensaje {id} sin entregar: {e}");
                this.failed(&peer);
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
        // El adjunto (foto o nota de voz), solo si está en la carpeta del chat.
        let attachment = match (&message.image, &message.audio) {
            (Some(path), _) | (None, Some(path)) => {
                if !self.inner.store.is_media(path) {
                    return Err(Error::Local(io::Error::other("el adjunto no está en la carpeta del chat")));
                }
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("bin").to_string();
                let size = tokio::fs::metadata(path).await.map_err(Error::Local)?.len();
                Some((ext, size, path.clone()))
            }
            (None, None) => None,
        };
        let name = self.inner.name.read().unwrap().clone();
        let frame = match (&attachment, message.once, message.audio.is_some()) {
            (Some((ext, size, _)), true, _) => Frame::Once {
                id: message.id.clone(),
                ts: message.ts,
                name,
                image: ImageMeta { ext: ext.clone(), size: *size },
            },
            (Some((ext, size, _)), false, true) => Frame::Chat {
                id: message.id.clone(),
                ts: message.ts,
                name,
                text: message.text.clone(),
                image: None,
                audio: Some(AudioMeta { ext: ext.clone(), size: *size, duration_ms: message.duration_ms.unwrap_or(0) }),
            },
            (attachment, _, _) => Frame::Chat {
                id: message.id.clone(),
                ts: message.ts,
                name,
                text: message.text.clone(),
                image: attachment.as_ref().map(|(ext, size, _)| ImageMeta { ext: ext.clone(), size: *size }),
                audio: None,
            },
        };
        let body = attachment.as_ref().map(|(_, _, path)| path.as_path());
        if let Err(e) = exchange(&conn, &frame, body).await {
            // El siguiente intento abre una conexión nueva en vez de insistir en esta.
            self.forget_connection(id, Some(&conn)).await;
            return Err(e);
        }

        // Una foto de una vez no se queda aquí: entregada, se borra.
        if message.once
            && let Some(path) = message.image.take()
        {
            shred(&path).await;
        }
        message.status = Status::Delivered;
        self.inner.store.append(&message).map_err(Error::Local)?;
        self.inner.pending.lock().unwrap().remove(&message.id);
        let _ = self.inner.events.send(Event::Chat { message, name: None });
        Ok(())
    }

    /// Conexión con `id`: la que ya hubiera abierta o una nueva.
    async fn connection(&self, id: EndpointId) -> Result<Connection, Error> {
        self.touch(id);
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
        // La más reciente manda: si el otro acaba de conectar es que esta
        // funciona, y la que hubiera puede ser de una instancia que ya no está.
        if conn.side().is_server() {
            self.inner.conns.lock().await.insert(id, conn.clone());
        } else {
            self.inner.conns.lock().await.entry(id).or_insert_with(|| conn.clone());
        }
        self.touch(id);
        // Si nos busca es que se le puede llegar: lo pendiente para él, ya.
        if conn.side().is_server() {
            self.retry(Some(&id.to_string()));
        }
        let datagrams = {
            let this = self.clone();
            let conn = conn.clone();
            async move {
                while let Ok(packet) = conn.read_datagram().await {
                    // Si la cola está llena (no se recoge), el paquete sobra.
                    if let Some(tx) = this.inner.voice.lock().unwrap().get(&id) {
                        let _ = tx.try_send(packet);
                    }
                }
            }
        };
        let streams = async {
            while let Ok((send, recv)) = conn.accept_bi().await {
                self.touch(id);
                let this = self.clone();
                tokio::spawn(async move {
                    if let Err(e) = this.handle(id, send, recv).await {
                        tracing::debug!("mensaje de {} fallido: {e}", id.fmt_short());
                    }
                });
            }
        };
        let uni = async {
            while let Ok(mut recv) = conn.accept_uni().await {
                self.touch(id);
                let this = self.clone();
                tokio::spawn(async move {
                    let Ok(Ok(data)) = tokio::time::timeout(VIDEO_TIMEOUT, recv.read_to_end(MAX_VIDEO_FRAME + 1)).await else {
                        return;
                    };
                    if data.first() != Some(&STREAM_VIDEO) {
                        return;
                    }
                    if let Some(tx) = this.inner.video.lock().unwrap().get(&id) {
                        let _ = tx.try_send(Bytes::from(data).slice(1..));
                    }
                });
            }
        };
        tokio::join!(datagrams, streams, uni);
        let mut conns = self.inner.conns.lock().await;
        if conns.get(&id).is_some_and(|c| c.stable_id() == conn.stable_id()) {
            conns.remove(&id);
        }
        // Puede quedar otra (los dos lados conectaron a la vez): entonces no se perdió nada.
        if conns.get(&id).is_some_and(|c| c.close_reason().is_none()) {
            return;
        }
        drop(conns);
        tracing::debug!("conexión con {} cerrada: {:?}", id.fmt_short(), conn.close_reason());
        // La voz y el vídeo iban por esta conexión: sus canales se cierran.
        let voice = self.inner.voice.lock().unwrap().remove(&id).is_some();
        let video = self.inner.video.lock().unwrap().remove(&id).is_some();
        if voice || video {
            let _ = self.inner.events.send(Event::TalkLost { peer: id.to_string() });
        }
    }

    /// Recibe un adjunto de `size` bytes en `path` (por trozos, a un archivo
    /// temporal). Si ya se tenía (`known`), se lee y se tira.
    async fn receive_media(
        &self,
        recv: &mut iroh::endpoint::RecvStream,
        from: EndpointId,
        path: PathBuf,
        size: u64,
        max: u64,
        known: bool,
    ) -> Result<Option<PathBuf>, Error> {
        if size > max {
            return Err(Error::Protocol("adjunto demasiado grande".into()));
        }
        let _slot = ImageSlot::take(&self.inner.receiving, from)
            .ok_or_else(|| Error::Protocol("demasiados adjuntos a la vez".into()))?;
        // Ni 25 MB en memoria ni un adjunto a medias con su nombre final.
        let part = path.with_extension("part");
        tokio::fs::create_dir_all(path.parent().expect("con carpeta")).await?;
        let mut file = create_private(&part).await?;
        let mut limited = recv.take(size);
        let copied = timed(LONG, tokio::io::copy(&mut limited, &mut file)).await;
        drop(file);
        if copied.as_ref().map_or(true, |n| *n != size) {
            let _ = tokio::fs::remove_file(&part).await;
            copied?;
            return Err(Error::Protocol("adjunto incompleto".into()));
        }
        if known {
            let _ = tokio::fs::remove_file(&part).await;
            return Ok(None);
        }
        tokio::fs::rename(&part, &path).await?;
        Ok(Some(path))
    }

    async fn handle(
        &self,
        from: EndpointId,
        mut send: iroh::endpoint::SendStream,
        mut recv: iroh::endpoint::RecvStream,
    ) -> Result<(), Error> {
        let peer = from.to_string();
        match read_frame(&mut recv, SHORT).await? {
            Frame::Chat { id, ts, name, text, image, audio } => {
                // El id forma el nombre del archivo del adjunto: solo un uuid
                // tal cual (nada de `../` ni rutas absolutas).
                if !is_message_id(&id) {
                    return Err(Error::Protocol("id de mensaje no válido".into()));
                }
                let known = self.inner.store.knows(&peer, &id);
                let mut message = ChatMessage::new(id.clone(), peer.clone(), false, ts, Status::Received);
                message.text = text;
                if let Some(meta) = image {
                    let path = self.inner.store.media_path(&id, &meta.ext);
                    message.image = self.receive_media(&mut recv, from, path, meta.size, MAX_IMAGE, known).await?;
                } else if let Some(meta) = audio {
                    let path = self.inner.store.media_path(&id, &meta.ext);
                    message.audio = self.receive_media(&mut recv, from, path, meta.size, MAX_AUDIO, known).await?;
                    message.duration_ms = Some(meta.duration_ms);
                }
                write_frame(&mut send, &Frame::Ack).await?;
                let _ = send.finish();
                // Un reintento de algo que ya teníamos: basta con confirmarlo.
                if known {
                    return Ok(());
                }
                self.inner.store.append(&message)?;
                let _ = self.inner.events.send(Event::Chat { message, name: Some(name) });
            }
            Frame::Once { id, ts, name, image } => {
                if !is_message_id(&id) {
                    return Err(Error::Protocol("id de mensaje no válido".into()));
                }
                let known = self.inner.store.knows(&peer, &id);
                let path = self.inner.store.once_path(&id, &image.ext);
                let saved = self.receive_media(&mut recv, from, path, image.size, MAX_IMAGE, known).await?;
                write_frame(&mut send, &Frame::Ack).await?;
                let _ = send.finish();
                if known {
                    return Ok(());
                }
                let mut message = ChatMessage::new(id, peer, false, ts, Status::Received);
                message.image = saved;
                message.once = true;
                self.inner.store.append(&message)?;
                let _ = self.inner.events.send(Event::Chat { message, name: Some(name) });
            }
            Frame::Opened { id } => {
                write_frame(&mut send, &Frame::Ack).await?;
                let _ = send.finish();
                let sent = self.inner.store.history(&peer).into_iter().find(|m| m.id == id && m.once && m.outgoing && !m.opened);
                if let Some(mut message) = sent {
                    message.opened = true;
                    self.inner.store.append(&message)?;
                    let _ = self.inner.events.send(Event::Chat { message, name: None });
                }
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
    // El acuse sale en cuanto el otro lo tiene todo: si tarda, la conexión no contesta.
    match read_frame(&mut recv, SHORT).await? {
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

async fn read_frame<R: AsyncRead + Unpin, T: DeserializeOwned>(r: &mut R, limit: Duration) -> Result<T, Error> {
    let len = timed(limit, r.read_u32()).await? as usize;
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

/// Crea un archivo que solo puede leer este usuario (las fotos de una vez).
async fn create_private(path: &Path) -> io::Result<tokio::fs::File> {
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    options.open(path).await
}

async fn write_private(path: &Path, data: &[u8]) -> io::Result<()> {
    let mut file = create_private(path).await?;
    file.write_all(data).await?;
    file.flush().await
}

/// Borra un archivo pisando antes su contenido (lo que se pueda: en discos
/// SSD y con copias del sistema no hay garantía).
async fn shred(path: &Path) {
    if let Ok(meta) = tokio::fs::metadata(path).await
        && let Ok(mut file) = tokio::fs::OpenOptions::new().write(true).open(path).await
    {
        let _ = file.write_all(&vec![0u8; meta.len() as usize]).await;
        let _ = file.sync_all().await;
    }
    let _ = tokio::fs::remove_file(path).await;
}

/// Un id de mensaje válido: un uuid en su forma de siempre (como los que se crean aquí).
fn is_message_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|u| u.hyphenated().to_string() == id)
}

/// Una foto recibiéndose: cuenta para el límite por equipo mientras dura.
struct ImageSlot<'a> {
    map: &'a Mutex<HashMap<EndpointId, usize>>,
    id: EndpointId,
}

impl<'a> ImageSlot<'a> {
    fn take(map: &'a Mutex<HashMap<EndpointId, usize>>, id: EndpointId) -> Option<Self> {
        let mut map_guard = map.lock().unwrap();
        let n = map_guard.entry(id).or_default();
        if *n >= IMAGES_AT_ONCE {
            return None;
        }
        *n += 1;
        Some(Self { map, id })
    }
}

impl Drop for ImageSlot<'_> {
    fn drop(&mut self) {
        let mut map = self.map.lock().unwrap();
        if let Some(n) = map.get_mut(&self.id) {
            *n -= 1;
            if *n == 0 {
                map.remove(&self.id);
            }
        }
    }
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
    /// Ids que ya hay en el historial de cada equipo, para descartar los
    /// repetidos sin releer el archivo entero con cada mensaje.
    known: Mutex<HashMap<String, HashSet<String>>>,
}

impl Store {
    fn file(&self, peer: &str) -> PathBuf {
        self.dir.join(format!("{}.jsonl", normalize(peer)))
    }

    fn media_dir(&self) -> PathBuf {
        self.dir.join("media")
    }

    fn media_path(&self, id: &str, ext: &str) -> PathBuf {
        let id: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(64).collect();
        let ext: String = ext.chars().filter(char::is_ascii_alphanumeric).take(5).collect();
        let ext = if ext.is_empty() { "bin".to_string() } else { ext.to_lowercase() };
        self.media_dir().join(format!("{id}.{ext}"))
    }

    fn once_path(&self, id: &str, ext: &str) -> PathBuf {
        let path = self.media_path(id, ext);
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        path.with_file_name(format!("{ONCE_PREFIX}{name}"))
    }

    /// Si `path` es una foto de la carpeta del chat (y no otro archivo del equipo).
    fn is_media(&self, path: &Path) -> bool {
        let dir = self.media_dir();
        path.parent() == Some(dir.as_path())
            && path.file_name().and_then(|n| n.to_str()).is_some_and(|n| !n.starts_with('.') && !n.contains(".."))
            && std::fs::symlink_metadata(path).is_ok_and(|m| m.is_file())
    }

    fn append(&self, message: &ChatMessage) -> io::Result<()> {
        use std::io::Write;
        std::fs::create_dir_all(&self.dir)?;
        let mut line = serde_json::to_vec(message)?;
        line.push(b'\n');
        std::fs::OpenOptions::new().create(true).append(true).open(self.file(&message.peer))?.write_all(&line)?;
        if let Some(ids) = self.known.lock().unwrap().get_mut(&normalize(&message.peer)) {
            ids.insert(message.id.clone());
        }
        Ok(())
    }

    fn private_file(&self) -> PathBuf {
        self.dir.join("private.json")
    }

    /// Los equipos con chat privado, guardados.
    fn private(&self) -> HashSet<String> {
        std::fs::read(self.private_file())
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok())
            .unwrap_or_default()
            .into_iter()
            .filter(|p| crate::parse_code(p).is_some())
            .collect()
    }

    fn save_private(&self, private: &HashSet<String>) -> io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let list: Vec<&String> = private.iter().collect();
        std::fs::write(self.private_file(), serde_json::to_vec(&list)?)
    }

    /// Borra el historial con `peer` y sus fotos y notas de voz (pisándolas antes).
    fn wipe(&self, peer: &str) {
        let peer = normalize(peer);
        for message in self.history(&peer) {
            for path in [message.image, message.audio].into_iter().flatten() {
                if self.is_media(&path) {
                    if let Ok(meta) = std::fs::metadata(&path) {
                        let _ = std::fs::write(&path, vec![0u8; meta.len() as usize]);
                    }
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
        let _ = std::fs::remove_file(self.file(&peer));
        self.known.lock().unwrap().remove(&peer);
    }

    /// Si el historial de `peer` ya tiene el mensaje `id`.
    fn knows(&self, peer: &str, id: &str) -> bool {
        let peer = normalize(peer);
        let mut known = self.known.lock().unwrap();
        let ids = known
            .entry(peer.clone())
            .or_insert_with(|| read_history(&self.file(&peer)).into_iter().map(|m| m.id).collect());
        ids.contains(id)
    }

    fn history(&self, peer: &str) -> Vec<ChatMessage> {
        read_history(&self.file(peer))
    }

    fn pending(&self) -> Vec<ChatMessage> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return Vec::new() };
        entries
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
            .flat_map(|e| {
                // Solo los historiales de verdad: `<código>.jsonl` con mensajes de ese equipo.
                let stem = e.path().file_stem().and_then(|s| s.to_str()).map(str::to_string);
                read_history(&e.path()).into_iter().filter(move |m| stem.as_deref() == Some(m.peer.as_str()))
            })
            .filter(|m| m.outgoing && m.status == Status::Pending)
            .filter(|m| m.image.as_ref().is_none_or(|p| self.is_media(p)))
            .filter(|m| m.audio.as_ref().is_none_or(|p| self.is_media(p)))
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
