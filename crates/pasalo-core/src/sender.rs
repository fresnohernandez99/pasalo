use std::collections::HashSet;
use std::fs::Metadata;
use std::io::{self, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use iroh::endpoint::Connection;
use tokio::fs::File;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWrite, AsyncWriteExt, BufReader, BufWriter};
use tokio::net::TcpStream;
use walkdir::WalkDir;

use crate::compress::{self, Packer};
use crate::events::Progress;
use crate::paths::numbered;
use crate::protocol::{
    CHUNK, Item, ItemState, LONG, Message, SHORT, configure_stream, hash_prefix, read_msg, timed,
    unexpected, write_msg,
};
use crate::{Direction, Error, Event, EventSender, LocalInfo, Target, TransferId};

#[derive(Debug, Clone)]
pub struct SendOptions {
    /// Reconexiones automáticas tras un corte antes de rendirse.
    pub max_retries: u32,
}

impl Default for SendOptions {
    fn default() -> Self {
        Self { max_retries: 30 }
    }
}

struct Entry {
    item: Item,
    source: Option<PathBuf>,
}

/// Envía archivos y carpetas. Si la conexión se corta, reconecta y sigue desde
/// donde se quedó el receptor. `id` sale de [`crate::new_transfer_id`]; volver a
/// llamar con los mismos archivos (aunque sea tras reiniciar) también reanuda.
pub async fn send_paths(
    id: TransferId,
    target: &Target,
    local: &LocalInfo,
    paths: &[PathBuf],
    opts: &SendOptions,
    events: &EventSender,
) -> Result<(), Error> {
    let paths = paths.to_vec();
    let entries = tokio::task::spawn_blocking(move || build_manifest(&paths))
        .await
        .map_err(|e| Error::Local(io::Error::other(e)))?
        .map_err(Error::Local)?;

    let mut attempt = 0;
    loop {
        match send_once(target, local, &entries, id, events).await {
            Ok(wire_bytes) => {
                let _ = events.send(Event::TransferFinished {
                    id,
                    direction: Direction::Outgoing,
                    saved: Vec::new(),
                    wire_bytes,
                });
                return Ok(());
            }
            Err(e) => {
                let will_retry = e.is_retryable() && attempt < opts.max_retries;
                let _ = events.send(Event::TransferFailed {
                    id,
                    direction: Direction::Outgoing,
                    error: e.to_string(),
                    code: e.code(),
                    detail: e.detail(),
                    will_retry,
                });
                if !will_retry {
                    return Err(e);
                }
                attempt += 1;
                tokio::time::sleep(backoff(attempt)).await;
            }
        }
    }
}

pub async fn send_text(target: &Target, local: &LocalInfo, text: &str) -> Result<(), Error> {
    let (mut rd, mut wr, _conn) = connect(target).await?;
    handshake(&mut rd, &mut wr, local).await?;
    write_msg(&mut wr, &Message::Offer { items: Vec::new(), text: Some(text.to_string()) }).await?;
    match read_msg(&mut rd, SHORT).await? {
        Message::Accept { .. } => {}
        Message::Reject { reason } => return Err(Error::Rejected(reason)),
        _ => return Err(unexpected("accept")),
    }
    write_msg(&mut wr, &Message::Done).await?;
    read_result(&mut rd).await
}

/// Cómo se presenta el otro equipo.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Greeting {
    pub name: String,
    pub platform: String,
    /// Lo que entiende del protocolo (p. ej. `zstd`).
    #[serde(skip)]
    pub features: Vec<String>,
}

/// Se presenta al otro equipo sin enviar nada y devuelve cómo se llama.
/// Sirve para comprobar que se llega a un equipo remoto al añadirlo.
pub async fn probe(target: &Target, local: &LocalInfo) -> Result<Greeting, Error> {
    let (mut rd, mut wr, _conn) = connect(target).await?;
    let greeting = handshake(&mut rd, &mut wr, local).await?;
    write_msg(&mut wr, &Message::Done).await?;
    read_result(&mut rd).await?;
    Ok(greeting)
}

fn backoff(attempt: u32) -> Duration {
    Duration::from_secs(1 << attempt.min(4)).min(Duration::from_secs(10))
}

type Reader = BufReader<Box<dyn AsyncRead + Send + Unpin>>;
type Writer = BufWriter<Box<dyn AsyncWrite + Send + Unpin>>;

/// Abre el canal. Con un equipo remoto también devuelve la conexión, que hay
/// que mantener viva mientras se usa: al soltarla se cierra.
async fn connect(target: &Target) -> Result<(Reader, Writer, Option<Connection>), Error> {
    let (rd, wr, conn): (Box<dyn AsyncRead + Send + Unpin>, Box<dyn AsyncWrite + Send + Unpin>, _) = match target {
        Target::Lan(addr) => {
            let stream = timed(SHORT, TcpStream::connect(addr)).await?;
            configure_stream(&stream);
            let (rd, wr) = stream.into_split();
            (Box::new(rd), Box::new(wr), None)
        }
        Target::Remote(remote, id) => {
            let (conn, send, recv) = remote.open(*id).await?;
            (Box::new(recv), Box::new(send), Some(conn))
        }
    };
    Ok((BufReader::new(rd), BufWriter::with_capacity(CHUNK, wr), conn))
}

async fn handshake(rd: &mut Reader, wr: &mut Writer, local: &LocalInfo) -> Result<Greeting, Error> {
    write_msg(wr, &local.hello()).await?;
    match read_msg(rd, SHORT).await? {
        Message::Hello { name, platform, features, .. } => Ok(Greeting { name, platform, features }),
        Message::Reject { reason } => Err(Error::Rejected(reason)),
        _ => Err(unexpected("hello")),
    }
}

async fn read_result<R: AsyncRead + Unpin>(rd: &mut R) -> Result<(), Error> {
    match read_msg(rd, LONG).await? {
        Message::Result { error: None } => Ok(()),
        Message::Result { error: Some(e) } => Err(Error::Remote(e)),
        Message::Reject { reason } => Err(Error::Rejected(reason)),
        _ => Err(unexpected("result")),
    }
}

/// Un intento de envío. Devuelve los bytes de contenido que pasaron por la red.
async fn send_once(
    target: &Target,
    local: &LocalInfo,
    entries: &[Entry],
    id: TransferId,
    events: &EventSender,
) -> Result<u64, Error> {
    let (mut rd, mut wr, _conn) = connect(target).await?;
    let greeting = handshake(&mut rd, &mut wr, local).await?;
    let peer = greeting.name;
    // En la LAN la red sobra y se prima la velocidad; entre redes, el ahorro.
    let level = match target {
        Target::Lan(_) => 1,
        Target::Remote(..) => 3,
    };
    let mut packer = match greeting.features.iter().any(|f| f == compress::FEATURE) {
        true => Some(Packer::new(level).map_err(Error::Local)?),
        false => None,
    };

    let items = entries.iter().map(|e| e.item.clone()).collect();
    write_msg(&mut wr, &Message::Offer { items, text: None }).await?;
    let _ = events.send(Event::TransferWaiting { id, peer: peer.clone() });
    // El receptor puede tardar en contestar: lo tiene que aceptar el usuario,
    // o está hasheando lo que ya tenía.
    let states = match read_msg(&mut rd, LONG).await? {
        Message::Accept { items } => items,
        Message::Reject { reason } => return Err(Error::Rejected(reason)),
        _ => return Err(unexpected("accept")),
    };
    if states.len() != entries.len() {
        return Err(Error::Protocol("la respuesta no corresponde a la oferta".into()));
    }

    let files = entries.iter().filter(|e| !e.item.is_dir);
    let total = files.clone().map(|e| e.item.size).sum();
    let resumed = entries
        .iter()
        .zip(&states)
        .filter(|(e, _)| !e.item.is_dir)
        .map(|(e, state)| match state {
            ItemState::Skip => e.item.size,
            ItemState::From { offset } => (*offset).min(e.item.size),
        })
        .sum();
    let roots: Vec<String> =
        entries.iter().filter(|e| !e.item.path.contains('/')).map(|e| e.item.path.clone()).collect();
    let code = match target {
        Target::Remote(_, id) => Some(id.to_string()),
        Target::Lan(_) => None,
    };
    let _ = events.send(Event::TransferStarted {
        id,
        direction: Direction::Outgoing,
        peer,
        code,
        roots,
        files: files.count(),
        total_bytes: total,
        resumed_bytes: resumed,
    });

    let mut progress = Progress::new(events, id, resumed, total);
    let mut raw = 0;
    for (i, (entry, state)) in entries.iter().zip(&states).enumerate() {
        let (ItemState::From { offset }, Some(source)) = (state, &entry.source) else { continue };
        if *offset > entry.item.size {
            return Err(Error::Protocol(format!("desplazamiento no válido para {}", entry.item.path)));
        }
        let hash = send_file(&mut wr, source, *offset, entry.item.size, &mut progress, packer.as_mut()).await?;
        raw += entry.item.size - offset;
        write_msg(&mut wr, &Message::FileEnd { index: i as u32, hash }).await?;
    }
    progress.finish();

    write_msg(&mut wr, &Message::Done).await?;
    read_result(&mut rd).await?;
    Ok(packer.map_or(raw, |p| p.wire))
}

/// Envía `source` desde `offset` y devuelve el hash del archivo completo.
/// Con `packer` va en bloques comprimidos cuando compensa.
async fn send_file<W: AsyncWrite + Unpin>(
    wr: &mut W,
    source: &Path,
    offset: u64,
    size: u64,
    progress: &mut Progress<'_>,
    mut packer: Option<&mut Packer>,
) -> Result<String, Error> {
    let mut file = File::open(source).await.map_err(Error::Local)?;
    let len = file.metadata().await.map_err(Error::Local)?.len();
    if len != size {
        let msg = format!("{} cambió de tamaño durante el envío", source.display());
        return Err(Error::Local(io::Error::other(msg)));
    }
    let mut hasher = match offset {
        0 => blake3::Hasher::new(),
        _ => hash_prefix(source, offset).await.map_err(Error::Local)?,
    };
    file.seek(SeekFrom::Start(offset)).await.map_err(Error::Local)?;
    if let Some(packer) = packer.as_deref_mut() {
        packer.start_file(source);
    }

    let mut buf = vec![0u8; CHUNK];
    let mut left = size - offset;
    while left > 0 {
        let want = left.min(CHUNK as u64) as usize;
        let n = file.read(&mut buf[..want]).await.map_err(Error::Local)?;
        if n == 0 {
            return Err(Error::Local(io::ErrorKind::UnexpectedEof.into()));
        }
        match packer.as_deref_mut() {
            Some(packer) => packer.write(wr, &buf[..n]).await?,
            None => timed(SHORT, wr.write_all(&buf[..n])).await?,
        }
        hasher.update(&buf[..n]);
        left -= n as u64;
        progress.add(n as u64);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

/// Lista de lo que se va a enviar, con carpetas recorridas recursivamente.
/// Los enlaces simbólicos se omiten.
fn build_manifest(paths: &[PathBuf]) -> io::Result<Vec<Entry>> {
    let mut entries = Vec::new();
    let mut roots = HashSet::new();
    for path in paths {
        let path = std::fs::canonicalize(path)?;
        let meta = std::fs::metadata(&path)?;
        let base = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| io::Error::other(format!("ruta sin nombre: {}", path.display())))?;
        let root = unique_root(&base, meta.is_dir(), &mut roots);
        if meta.is_file() {
            entries.push(entry(root, &meta, Some(path)));
            continue;
        }
        for found in WalkDir::new(&path).follow_links(false).sort_by_file_name() {
            let found = found?;
            let kind = found.file_type();
            if !kind.is_dir() && !kind.is_file() {
                continue;
            }
            let mut rel = root.clone();
            for component in found.path().strip_prefix(&path).expect("dentro de la raíz").components() {
                rel.push('/');
                rel.push_str(&component.as_os_str().to_string_lossy());
            }
            let source = kind.is_file().then(|| found.path().to_path_buf());
            entries.push(entry(rel, &found.metadata()?, source));
        }
    }
    Ok(entries)
}

/// Evita que dos rutas con el mismo nombre final (`a/x.txt`, `b/x.txt`) choquen.
fn unique_root(base: &str, is_dir: bool, roots: &mut HashSet<String>) -> String {
    let name = match roots.contains(base) {
        false => base.to_string(),
        true => (1..).map(|n| numbered(base, is_dir, n)).find(|n| !roots.contains(n)).expect("rango infinito"),
    };
    roots.insert(name.clone());
    name
}

fn entry(path: String, meta: &Metadata, source: Option<PathBuf>) -> Entry {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());
    let is_dir = source.is_none();
    Entry {
        item: Item { path, size: if is_dir { 0 } else { meta.len() }, mtime, is_dir },
        source,
    }
}
