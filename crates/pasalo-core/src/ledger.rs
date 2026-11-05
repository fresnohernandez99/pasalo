//! Estado de una recepción en curso, guardado en disco para poder reanudarla
//! aunque se cierre la app.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::protocol::Item;

pub(crate) const LEDGER_DIR: &str = ".pasalo";

#[derive(Debug, Default, Serialize, Deserialize)]
pub(crate) struct Ledger {
    /// Nombre de primer nivel ofrecido → nombre elegido en destino (p. ej. `Fotos` → `Fotos (1)`).
    pub roots: BTreeMap<String, String>,
    /// Índices de archivos ya recibidos, verificados y renombrados.
    pub done: BTreeSet<u32>,
}

impl Ledger {
    pub fn load(path: &Path) -> Option<Self> {
        serde_json::from_slice(&std::fs::read(path).ok()?).ok()
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_vec(self)?)?;
        std::fs::rename(tmp, path)
    }
}

/// Identifica una transferencia: mismo emisor y mismos archivos (tamaño y fecha
/// incluidos). Si algo cambia en origen, es otra transferencia y empieza de cero.
pub(crate) fn transfer_key(device_id: &str, items: &[Item]) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(device_id.as_bytes());
    hasher.update(&[0]);
    hasher.update(&serde_json::to_vec(items).expect("los items siempre se serializan"));
    hasher.finalize().to_hex()[..32].to_string()
}
