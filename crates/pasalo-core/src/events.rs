use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::mpsc::UnboundedSender;

use crate::Peer;

pub type TransferId = u64;
pub type EventSender = UnboundedSender<Event>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Incoming,
    Outgoing,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    PeerFound(Peer),
    PeerLost {
        device_id: String,
    },
    /// Se emite en cada intento; `resumed_bytes` indica lo que ya no hace falta enviar.
    TransferStarted {
        id: TransferId,
        direction: Direction,
        peer: String,
        /// Nombres de primer nivel de lo que se envía (archivos y carpetas).
        roots: Vec<String>,
        files: usize,
        total_bytes: u64,
        resumed_bytes: u64,
    },
    Progress {
        id: TransferId,
        done_bytes: u64,
        total_bytes: u64,
    },
    TransferFinished {
        id: TransferId,
        direction: Direction,
        saved: Vec<PathBuf>,
    },
    TransferFailed {
        id: TransferId,
        direction: Direction,
        /// Mensaje completo, en español (lo que muestra el CLI).
        error: String,
        /// Tipo de error estable, para que la interfaz lo traduzca (ver [`crate::Error::code`]).
        code: &'static str,
        /// El detalle sin el prefijo del tipo.
        detail: String,
        will_retry: bool,
    },
    TextReceived {
        from: String,
        text: String,
    },
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Id para un envío nuevo. Reutilizarlo en otro `send_paths` continúa el mismo envío.
pub fn new_transfer_id() -> TransferId {
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

const PROGRESS_EVERY: Duration = Duration::from_millis(100);

/// Emite eventos de progreso como mucho cada `PROGRESS_EVERY`.
pub(crate) struct Progress<'a> {
    events: &'a EventSender,
    id: TransferId,
    done: u64,
    total: u64,
    last: Instant,
}

impl<'a> Progress<'a> {
    pub fn new(events: &'a EventSender, id: TransferId, done: u64, total: u64) -> Self {
        let progress = Self { events, id, done, total, last: Instant::now() };
        progress.emit();
        progress
    }

    pub fn add(&mut self, bytes: u64) {
        self.done += bytes;
        if self.last.elapsed() >= PROGRESS_EVERY {
            self.last = Instant::now();
            self.emit();
        }
    }

    pub fn finish(&self) {
        self.emit();
    }

    fn emit(&self) {
        let _ = self.events.send(Event::Progress {
            id: self.id,
            done_bytes: self.done,
            total_bytes: self.total,
        });
    }
}
