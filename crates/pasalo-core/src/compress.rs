//! Compresión de los datos de los archivos con zstd, solo cuando los dos
//! equipos la anuncian en su `Hello` y solo cuando ahorra algo.
//!
//! Con compresión, el contenido de cada archivo va en bloques de hasta
//! [`CHUNK`] bytes originales, cada uno con una cabecera `u32` big-endian: el
//! bit alto dice si va comprimido y el resto es la longitud de lo que sigue.
//! La reanudación, el progreso y el hash usan siempre los bytes originales.
//!
//! Fotos, vídeos, música y archivos comprimidos no ganan nada, así que ni se
//! intenta. Con el resto se prueba bloque a bloque: si uno no baja al menos
//! un 3 %, los siguientes van sin comprimir durante un rato antes de volver a
//! probar, para no gastar CPU en algo que no se comprime.

use std::io;
use std::path::Path;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::Error;
use crate::protocol::{CHUNK, SHORT, timed};

pub(crate) const FEATURE: &str = "zstd";
const COMPRESSED: u32 = 1 << 31;
/// Bloques sin comprimir tras uno que no se dejó comprimir.
const BACKOFF: u32 = 16;

/// Extensiones de formatos que ya van comprimidos.
const PACKED: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "avif", "jxl", "mp4", "m4v", "mov", "mkv", "webm", "avi",
    "3gp", "mp3", "m4a", "aac", "ogg", "oga", "opus", "flac", "wma", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar",
    "zst", "lz4", "br", "apk", "aab", "ipa", "jar", "xapk", "docx", "xlsx", "pptx", "odt", "ods", "odp", "epub",
    "dmg", "woff", "woff2",
];

/// Lado que envía: comprime los bloques que merezcan la pena.
pub(crate) struct Packer {
    compressor: zstd::bulk::Compressor<'static>,
    out: Vec<u8>,
    /// Bloques que quedan sin intentar comprimir.
    skip: u32,
    /// Bytes de datos que han salido (cabeceras incluidas).
    pub wire: u64,
}

impl Packer {
    /// `level` 1 en la LAN (prima la velocidad), 3 entre redes (prima el ahorro).
    pub fn new(level: i32) -> io::Result<Self> {
        Ok(Self {
            compressor: zstd::bulk::Compressor::new(level)?,
            out: Vec::with_capacity(zstd::zstd_safe::compress_bound(CHUNK)),
            skip: 0,
            wire: 0,
        })
    }

    /// Prepara el envío de un archivo nuevo.
    pub fn start_file(&mut self, path: &Path) {
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        self.skip = if PACKED.contains(&ext.as_str()) { u32::MAX } else { 0 };
    }

    pub async fn write<W: AsyncWrite + Unpin>(&mut self, w: &mut W, data: &[u8]) -> Result<(), Error> {
        let mut packed = false;
        if self.skip == 0 {
            self.out.clear();
            let saved = self.compressor.compress_to_buffer(data, &mut self.out).is_ok()
                && self.out.len() < data.len() - data.len() * 3 / 100;
            if saved {
                packed = true;
            } else {
                self.skip = BACKOFF;
            }
        } else if self.skip != u32::MAX {
            self.skip -= 1;
        }
        let (flag, body) = if packed { (COMPRESSED, &self.out[..]) } else { (0, data) };
        timed(SHORT, async {
            w.write_u32(flag | body.len() as u32).await?;
            w.write_all(body).await
        })
        .await?;
        self.wire += 4 + body.len() as u64;
        Ok(())
    }
}

/// Lado que recibe.
pub(crate) struct Unpacker {
    decompressor: zstd::bulk::Decompressor<'static>,
    packed: Vec<u8>,
    pub wire: u64,
}

impl Unpacker {
    pub fn new() -> io::Result<Self> {
        Ok(Self { decompressor: zstd::bulk::Decompressor::new()?, packed: Vec::new(), wire: 0 })
    }

    /// Lee un bloque y deja en `out` sus bytes originales (como mucho `max`).
    /// `limit` es la espera hasta la cabecera: el primer bloque de un archivo
    /// puede tardar si el emisor está hasheando lo que ya se envió.
    pub async fn read<R: AsyncRead + Unpin>(
        &mut self,
        r: &mut R,
        limit: std::time::Duration,
        max: usize,
        out: &mut Vec<u8>,
    ) -> Result<(), Error> {
        let header = timed(limit, r.read_u32()).await?;
        let len = (header & !COMPRESSED) as usize;
        let bad = || Error::Protocol("bloque de datos no válido".into());
        if len > zstd::zstd_safe::compress_bound(CHUNK) {
            return Err(bad());
        }
        self.wire += 4 + len as u64;
        out.clear();
        if header & COMPRESSED == 0 {
            if len == 0 || len > max {
                return Err(bad());
            }
            out.resize(len, 0);
            return timed(SHORT, r.read_exact(out)).await.map(|_| ());
        }
        self.packed.resize(len, 0);
        timed(SHORT, r.read_exact(&mut self.packed)).await?;
        out.reserve(max);
        self.decompressor.decompress_to_buffer(&self.packed, out).map_err(|_| bad())?;
        if out.is_empty() || out.len() > max {
            return Err(bad());
        }
        Ok(())
    }
}
