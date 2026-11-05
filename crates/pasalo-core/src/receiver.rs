use std::collections::{HashMap, HashSet};
use std::io::{self, SeekFrom};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

use tokio::fs::{self, OpenOptions};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWrite, AsyncWriteExt, BufReader, BufWriter};
use tokio::net::TcpListener;
use tokio::sync::watch;

use crate::events::Progress;
use crate::ledger::{LEDGER_DIR, Ledger, transfer_key};
use crate::paths::{part_path, split_safe, unique_name};
use crate::protocol::{
    CHUNK, ItemState, LONG, Message, PROTOCOL_VERSION, SHORT, configure_stream, hash_prefix, read_msg,
    timed, unexpected, write_msg,
};
use crate::{Direction, Error, Event, EventSender, LocalInfo, Remote, TALK_ALPN, Talk, TransferId};

/// Acepta conexiones y guarda lo recibido en `dest`. Acepta todo lo que llega,
/// como Dukto.
#[derive(Clone)]
pub struct Receiver {
    inner: Arc<Inner>,
}

struct Inner {
    dest: RwLock<PathBuf>,
    local: RwLock<LocalInfo>,
    events: EventSender,
    slots: Mutex<HashMap<String, Arc<Slot>>>,
}

/// Garantiza una sola sesión activa por transferencia. Si el emisor reconecta
/// mientras la sesión vieja sigue colgada esperando datos, la nueva sube la
/// generación, la vieja lo ve, suelta los archivos y la nueva continúa.
struct Slot {
    generation: watch::Sender<u64>,
    lock: tokio::sync::Mutex<()>,
}

struct Cancel {
    rx: watch::Receiver<u64>,
    generation: u64,
}

impl Cancel {
    async fn cancelled(&mut self) {
        let mine = self.generation;
        let _ = self.rx.wait_for(|g| *g != mine).await;
    }
}

impl Receiver {
    pub fn new(dest: impl Into<PathBuf>, local: LocalInfo, events: EventSender) -> Self {
        Self {
            inner: Arc::new(Inner {
                dest: RwLock::new(dest.into()),
                local: RwLock::new(local),
                events,
                slots: Mutex::default(),
            }),
        }
    }

    pub fn dest(&self) -> PathBuf {
        self.inner.dest.read().unwrap().clone()
    }

    /// Se aplica a las transferencias que empiecen a partir de ahora.
    pub fn set_dest(&self, dest: impl Into<PathBuf>) {
        *self.inner.dest.write().unwrap() = dest.into();
    }

    pub fn set_local(&self, local: LocalInfo) {
        *self.inner.local.write().unwrap() = local;
    }

    pub async fn bind(port: u16) -> io::Result<TcpListener> {
        TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).await
    }

    pub async fn run(&self, listener: TcpListener) {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    configure_stream(&stream);
                    let this = self.clone();
                    tokio::spawn(async move {
                        let (rd, wr) = stream.into_split();
                        this.handle(rd, wr).await
                    });
                }
                Err(e) => {
                    tracing::warn!("error aceptando conexión: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    }

    /// Acepta conexiones de equipos remotos que llegan por iroh: las de
    /// archivos las atiende aquí y las del chat y las llamadas se las pasa a
    /// `talk` (si no hay, se rechazan). Termina al cerrar `remote`.
    pub async fn run_remote(&self, remote: Remote, talk: Option<Talk>) {
        while let Some(incoming) = remote.endpoint.accept().await {
            let this = self.clone();
            let talk = talk.clone();
            tokio::spawn(async move {
                let conn = match incoming.await {
                    Ok(conn) => conn,
                    Err(e) => return tracing::debug!("conexión remota fallida: {e}"),
                };
                if conn.alpn() == TALK_ALPN {
                    match talk {
                        Some(talk) => talk.accept(conn),
                        None => conn.close(0u32.into(), b"sin chat"),
                    }
                    return;
                }
                let Ok(Ok((mut send, mut recv))) = tokio::time::timeout(SHORT, conn.accept_bi()).await else {
                    return;
                };
                this.handle(&mut recv, &mut send).await;
                // Cerrar sin esperar puede perder la última respuesta: se
                // termina el canal y se deja que el emisor cierre la conexión.
                let _ = send.finish();
                let _ = tokio::time::timeout(SHORT, conn.closed()).await;
            });
        }
    }

    async fn handle<R, W>(&self, rd: R, wr: W)
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        let mut started = None;
        if let Err(e) = self.session(rd, wr, &mut started).await {
            tracing::warn!("recepción fallida: {e}");
            if let Some(id) = started {
                let _ = self.inner.events.send(Event::TransferFailed {
                    id,
                    direction: Direction::Incoming,
                    error: e.to_string(),
                    code: e.code(),
                    detail: e.detail(),
                    will_retry: false,
                });
            }
        }
    }

    fn slot(&self, key: &str) -> Arc<Slot> {
        let mut slots = self.inner.slots.lock().unwrap();
        slots
            .entry(key.to_string())
            .or_insert_with(|| {
                Arc::new(Slot { generation: watch::channel(0).0, lock: tokio::sync::Mutex::new(()) })
            })
            .clone()
    }

    async fn session<R, W>(&self, rd: R, wr: W, started: &mut Option<TransferId>) -> Result<(), Error>
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        let inner = &*self.inner;
        let dest = self.dest();
        let local = inner.local.read().unwrap().clone();
        let mut rd = BufReader::with_capacity(CHUNK, rd);
        let mut wr = BufWriter::new(wr);

        let Message::Hello { version, device_id, name: peer, .. } = read_msg(&mut rd, SHORT).await? else {
            return Err(unexpected("hello"));
        };
        write_msg(&mut wr, &local.hello()).await?;
        if version != PROTOCOL_VERSION {
            let reason = format!("versión de protocolo {version} no soportada");
            write_msg(&mut wr, &Message::Reject { reason: reason.clone() }).await?;
            return Err(Error::Rejected(reason));
        }

        let (items, text) = match read_msg(&mut rd, SHORT).await? {
            Message::Offer { items, text } => (items, text),
            // Solo venía a presentarse (ver `probe`).
            Message::Done => return write_msg(&mut wr, &Message::Result { error: None }).await,
            _ => return Err(unexpected("offer")),
        };
        if let Some(text) = text {
            write_msg(&mut wr, &Message::Accept { items: Vec::new() }).await?;
            let _ = inner.events.send(Event::TextReceived { from: peer, text });
            let Message::Done = read_msg(&mut rd, SHORT).await? else {
                return Err(unexpected("done"));
            };
            return write_msg(&mut wr, &Message::Result { error: None }).await;
        }

        let rel = items.iter().map(|item| split_safe(&item.path)).collect::<Option<Vec<_>>>();
        let Some(rel) = rel.filter(|_| items.len() <= u32::MAX as usize) else {
            let reason = "la oferta contiene rutas no válidas".to_string();
            write_msg(&mut wr, &Message::Reject { reason: reason.clone() }).await?;
            return Err(Error::Rejected(reason));
        };

        let key = transfer_key(&device_id, &items);
        let slot = self.slot(&key);
        let mut generation = 0;
        slot.generation.send_modify(|g| {
            *g += 1;
            generation = *g;
        });
        let mut cancel = Cancel { rx: slot.generation.subscribe(), generation };
        let _lock = slot.lock.lock().await;
        if *cancel.rx.borrow() != generation {
            return Err(Error::Superseded);
        }

        let ledger_path = dest.join(LEDGER_DIR).join(format!("{key}.json"));
        let previous = Ledger::load(&ledger_path);
        let resuming = previous.is_some();
        let mut ledger = previous.unwrap_or_default();
        for (comps, item) in rel.iter().zip(&items) {
            if !ledger.roots.contains_key(&comps[0]) {
                let chosen: HashSet<&String> = ledger.roots.values().collect();
                let is_dir = item.is_dir || comps.len() > 1;
                let name = unique_name(&dest, &comps[0], is_dir, |n| chosen.iter().any(|c| *c == n));
                ledger.roots.insert(comps[0].clone(), name);
            }
        }
        fs::create_dir_all(&dest).await?;
        ledger.save(&ledger_path)?;

        let finals: Vec<PathBuf> = rel
            .iter()
            .map(|comps| {
                let mut path = dest.join(&ledger.roots[&comps[0]]);
                path.extend(&comps[1..]);
                path
            })
            .collect();

        // Decide desde dónde sigue cada archivo. Los prefijos ya recibidos se
        // hashean ahora, antes de que empiecen a llegar datos.
        let mut states = Vec::with_capacity(items.len());
        let mut prefixes = Vec::with_capacity(items.len());
        let (mut total, mut resumed) = (0u64, 0u64);
        for (i, (item, path)) in items.iter().zip(&finals).enumerate() {
            let index = i as u32;
            if item.is_dir {
                fs::create_dir_all(path).await?;
                states.push(ItemState::Skip);
                prefixes.push(None);
                continue;
            }
            total += item.size;
            let finished = ledger.done.contains(&index)
                && fs::metadata(path).await.is_ok_and(|m| m.len() == item.size);
            if finished {
                resumed += item.size;
                states.push(ItemState::Skip);
                prefixes.push(None);
                continue;
            }
            ledger.done.remove(&index);
            let part = part_path(path);
            let mut offset = match resuming {
                true => fs::metadata(&part).await.map_or(0, |m| m.len()),
                false => 0,
            };
            if offset > item.size {
                offset = 0;
            }
            let prefix = match offset {
                0 => None,
                _ => Some(hash_prefix(&part, offset).await?),
            };
            resumed += offset;
            states.push(ItemState::From { offset });
            prefixes.push(prefix);
        }

        write_msg(&mut wr, &Message::Accept { items: states.clone() }).await?;
        // Mismo id en todos los intentos de la misma transferencia (cabe en un
        // número de JavaScript).
        let id = u64::from_str_radix(&key[..12], 16).expect("la clave es hexadecimal");
        *started = Some(id);
        let roots: Vec<String> = ledger.roots.values().cloned().collect();
        let _ = inner.events.send(Event::TransferStarted {
            id,
            direction: Direction::Incoming,
            peer: peer.clone(),
            roots,
            files: items.iter().filter(|item| !item.is_dir).count(),
            total_bytes: total,
            resumed_bytes: resumed,
        });

        let mut progress = Progress::new(&inner.events, id, resumed, total);
        let mut errors = Vec::new();
        // Guardar el registro tras cada archivo es O(n²) con miles de archivos
        // pequeños. Si se pierde lo del último segundo, esos archivos se
        // vuelven a pedir al reanudar.
        let mut saved_at = Instant::now();
        for (i, state) in states.iter().enumerate() {
            let ItemState::From { offset } = *state else { continue };
            let (item, path) = (&items[i], &finals[i]);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).await?;
            }
            let part = part_path(path);
            let hasher = prefixes[i].take().unwrap_or_default();
            let hash = receive_file(&mut rd, &mut cancel, &part, offset, item.size, hasher, &mut progress).await?;

            let msg = tokio::select! {
                msg = read_msg(&mut rd, LONG) => msg?,
                _ = cancel.cancelled() => return Err(Error::Superseded),
            };
            let Message::FileEnd { index, hash: expected } = msg else {
                return Err(unexpected("file_end"));
            };
            if index as usize != i {
                return Err(Error::Protocol(format!("se esperaba el archivo {i} y llegó el {index}")));
            }
            if hash == expected {
                fs::rename(&part, path).await?;
                set_mtime(path, item.mtime);
                ledger.done.insert(index);
                if saved_at.elapsed() >= LEDGER_EVERY {
                    ledger.save(&ledger_path)?;
                    saved_at = Instant::now();
                }
            } else {
                let _ = fs::remove_file(&part).await;
                errors.push(format!("{}: el contenido recibido no coincide", item.path));
            }
        }
        progress.finish();

        let Message::Done = read_msg(&mut rd, SHORT).await? else {
            return Err(unexpected("done"));
        };
        if !errors.is_empty() {
            // Para que al reintentar solo se pidan los que fallaron.
            ledger.save(&ledger_path)?;
            let error = errors.join("; ");
            write_msg(&mut wr, &Message::Result { error: Some(error.clone()) }).await?;
            return Err(Error::Remote(error));
        }

        let _ = fs::remove_file(&ledger_path).await;
        let _ = fs::remove_dir(dest.join(LEDGER_DIR)).await;
        write_msg(&mut wr, &Message::Result { error: None }).await?;
        let _ = inner.events.send(Event::TransferFinished {
            id,
            direction: Direction::Incoming,
            saved: ledger.roots.values().map(|name| dest.join(name)).collect(),
        });
        Ok(())
    }
}

const LEDGER_EVERY: Duration = Duration::from_secs(1);
const SYNC_FROM: u64 = 8 * 1024 * 1024;

/// Recibe el resto de un archivo en `part` y devuelve el hash del archivo completo.
async fn receive_file<R: AsyncRead + Unpin>(
    rd: &mut R,
    cancel: &mut Cancel,
    part: &Path,
    offset: u64,
    size: u64,
    mut hasher: blake3::Hasher,
    progress: &mut Progress<'_>,
) -> Result<String, Error> {
    let mut file = OpenOptions::new().write(true).create(true).truncate(false).open(part).await?;
    file.set_len(offset).await?;
    file.seek(SeekFrom::Start(offset)).await?;

    let mut buf = vec![0u8; CHUNK];
    let mut left = size - offset;
    // El emisor puede tardar en mandar el primer byte si está hasheando su prefijo.
    let mut limit = LONG;
    let result = loop {
        if left == 0 {
            break Ok(());
        }
        let want = left.min(CHUNK as u64) as usize;
        let n = tokio::select! {
            read = timed(limit, rd.read(&mut buf[..want])) => match read {
                Ok(0) => break Err(Error::Io(io::ErrorKind::UnexpectedEof.into())),
                Ok(n) => n,
                Err(e) => break Err(e),
            },
            _ = cancel.cancelled() => break Err(Error::Superseded),
        };
        limit = SHORT;
        if let Err(e) = file.write_all(&buf[..n]).await {
            break Err(e.into());
        }
        hasher.update(&buf[..n]);
        left -= n as u64;
        progress.add(n as u64);
    };
    // Vaciar siempre, también si falló: lo escrito es lo que se reanuda luego.
    let flushed = file.flush().await;
    result?;
    flushed?;
    // `sync_all` solo protege de un apagón (si se corta la red o se cierra la
    // app, lo escrito ya está en el sistema) y en macOS cuesta ~20 ms por
    // archivo: con miles de archivos pequeños era casi todo el tiempo.
    if size >= SYNC_FROM {
        file.sync_all().await?;
    }
    Ok(hasher.finalize().to_hex().to_string())
}

fn set_mtime(path: &Path, secs: u64) {
    if secs == 0 {
        return;
    }
    if let Ok(file) = std::fs::File::options().write(true).open(path) {
        let _ = file.set_modified(UNIX_EPOCH + Duration::from_secs(secs));
    }
}
