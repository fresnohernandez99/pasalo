//! Núcleo de pasalo: descubrimiento de equipos en la LAN y transferencias
//! de archivos que se pueden reanudar si se interrumpen.

mod discovery;
mod error;
mod events;
mod ledger;
mod paths;
pub mod protocol;
mod receiver;
mod sender;

use std::path::Path;

pub use discovery::{Discovery, Peer};
pub use error::Error;
pub use events::{Direction, Event, EventSender, TransferId, new_transfer_id};
pub use receiver::Receiver;
pub use sender::{SendOptions, send_paths, send_text};

/// Identidad de este equipo tal como la ven los demás.
#[derive(Debug, Clone)]
pub struct LocalInfo {
    /// Identificador estable: la reanudación depende de que no cambie entre reinicios.
    pub device_id: String,
    pub name: String,
    pub platform: String,
    pub transfer_port: u16,
}

impl LocalInfo {
    pub fn new(device_id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            device_id: device_id.into(),
            name: name.into(),
            platform: std::env::consts::OS.to_string(),
            transfer_port: protocol::TRANSFER_PORT,
        }
    }

    pub(crate) fn hello(&self) -> protocol::Message {
        protocol::Message::Hello {
            version: protocol::PROTOCOL_VERSION,
            device_id: self.device_id.clone(),
            name: self.name.clone(),
            platform: self.platform.clone(),
        }
    }
}

pub fn default_device_name() -> String {
    let host = gethostname::gethostname().to_string_lossy().into_owned();
    host.trim_end_matches(".local").to_string()
}

/// Lee el identificador del equipo de `path`, creándolo la primera vez.
pub fn load_or_create_device_id(path: &Path) -> std::io::Result<String> {
    if let Ok(id) = std::fs::read_to_string(path) {
        let id = id.trim();
        if !id.is_empty() {
            return Ok(id.to_string());
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, &id)?;
    Ok(id)
}
