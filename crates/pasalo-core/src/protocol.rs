//! Protocolo de transferencia.
//!
//! Cada mensaje de control va como `u32` big-endian con la longitud seguida de
//! JSON. Los datos de los archivos van en crudo entre mensajes:
//!
//! ```text
//! emisor                                  receptor
//!   Hello  ───────────────────────────────▶
//!          ◀─────────────────────────────── Hello
//!   Offer { items }  ─────────────────────▶
//!          ◀─────────────────────────────── Accept { items: [Skip | From{offset}] }
//!   por cada From{offset}:
//!     size - offset bytes en crudo ───────▶
//!     FileEnd { index, hash } ────────────▶  (BLAKE3 del archivo completo)
//!   Done  ────────────────────────────────▶
//!          ◀─────────────────────────────── Result { error }
//! ```
//!
//! La reanudación sale sola: si la conexión se corta, el emisor vuelve a
//! mandar la misma oferta y el receptor contesta desde qué byte seguir cada
//! archivo según lo que ya tiene en disco.

use std::future::Future;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

use crate::Error;

pub const PROTOCOL_VERSION: u32 = 1;
pub const DISCOVERY_PORT: u16 = 4645;
pub const TRANSFER_PORT: u16 = 4646;

pub(crate) const CHUNK: usize = 256 * 1024;
/// Tiempo máximo para un paso que debería ser inmediato (un bloque de datos, un mensaje corto).
pub(crate) const SHORT: Duration = Duration::from_secs(30);
/// Para esperas en las que el otro lado puede estar calculando hashes de archivos grandes.
/// Las conexiones muertas se detectan antes por TCP keepalive.
pub(crate) const LONG: Duration = Duration::from_secs(600);
const MAX_FRAME: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Item {
    /// Ruta relativa separada por `/`.
    pub path: String,
    pub size: u64,
    /// Segundos desde la época Unix.
    pub mtime: u64,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ItemState {
    /// El receptor ya lo tiene completo (o es una carpeta).
    Skip,
    From { offset: u64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Message {
    Hello { version: u32, device_id: String, name: String, platform: String },
    Offer { items: Vec<Item>, text: Option<String> },
    Accept { items: Vec<ItemState> },
    Reject { reason: String },
    FileEnd { index: u32, hash: String },
    Done,
    Result { error: Option<String> },
}

pub(crate) async fn timed<T>(
    limit: Duration,
    fut: impl Future<Output = std::io::Result<T>>,
) -> Result<T, Error> {
    match tokio::time::timeout(limit, fut).await {
        Ok(result) => result.map_err(Error::Io),
        Err(_) => Err(Error::Timeout),
    }
}

pub(crate) async fn write_msg<W: AsyncWrite + Unpin>(w: &mut W, msg: &Message) -> Result<(), Error> {
    let buf = serde_json::to_vec(msg).map_err(|e| Error::Protocol(e.to_string()))?;
    timed(SHORT, async {
        w.write_u32(buf.len() as u32).await?;
        w.write_all(&buf).await?;
        w.flush().await
    })
    .await
}

pub(crate) async fn read_msg<R: AsyncRead + Unpin>(r: &mut R, limit: Duration) -> Result<Message, Error> {
    let len = timed(limit, r.read_u32()).await? as usize;
    if len > MAX_FRAME {
        return Err(Error::Protocol(format!("mensaje demasiado grande ({len} bytes)")));
    }
    let mut buf = vec![0; len];
    timed(SHORT, r.read_exact(&mut buf)).await?;
    serde_json::from_slice(&buf).map_err(|e| Error::Protocol(e.to_string()))
}

pub(crate) fn unexpected(what: &str) -> Error {
    Error::Protocol(format!("se esperaba el mensaje {what}"))
}

pub(crate) fn configure_stream(stream: &tokio::net::TcpStream) {
    let _ = stream.set_nodelay(true);
    let sock = socket2::SockRef::from(stream);
    let keepalive = socket2::TcpKeepalive::new()
        .with_time(Duration::from_secs(10))
        .with_interval(Duration::from_secs(5));
    #[cfg(not(windows))]
    let keepalive = keepalive.with_retries(3);
    let _ = sock.set_tcp_keepalive(&keepalive);
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let _ = sock.set_tcp_user_timeout(Some(Duration::from_secs(30)));
}

/// Hash BLAKE3 de los primeros `len` bytes de un archivo, listo para seguir con el resto.
pub(crate) async fn hash_prefix(path: &Path, len: u64) -> std::io::Result<blake3::Hasher> {
    let file = tokio::fs::File::open(path).await?;
    let mut reader = BufReader::with_capacity(CHUNK, file).take(len);
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0; CHUNK];
    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            return Ok(hasher);
        }
        hasher.update(&buf[..n]);
    }
}
