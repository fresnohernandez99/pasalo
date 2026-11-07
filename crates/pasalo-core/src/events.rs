use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::mpsc::UnboundedSender;

use crate::lobby::{LobbyUser, Partner};
use crate::Peer;
use crate::talk::{ChatMessage, Signal};

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
    /// Alguien quiere enviarnos archivos: hay que contestar con
    /// [`crate::Receiver::decide`]. Lo que ya se aceptó antes (reanudaciones)
    /// no pregunta.
    TransferRequest {
        id: TransferId,
        peer: String,
        /// Código de iroh del otro equipo, si llegó por iroh (por la LAN no
        /// se sabe). Con él la interfaz sabe de qué chat es, aunque dos
        /// equipos se llamen igual.
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        roots: Vec<String>,
        files: usize,
        total_bytes: u64,
    },
    /// La petición ya no espera respuesta: el emisor se fue (`cancelled`) o
    /// nadie contestó a tiempo (`timeout`).
    RequestClosed {
        id: TransferId,
        reason: &'static str,
    },
    /// La oferta salió y se espera a que el otro lado la acepte.
    TransferWaiting {
        id: TransferId,
        peer: String,
    },
    /// Se emite en cada intento; `resumed_bytes` indica lo que ya no hace falta enviar.
    TransferStarted {
        id: TransferId,
        direction: Direction,
        peer: String,
        /// Código de iroh del otro equipo, si va por iroh.
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
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
        /// Bytes de contenido que pasaron por la red en el último intento
        /// (menos que el total si se comprimió o se reanudó).
        wire_bytes: u64,
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
    /// Mensaje de chat nuevo o que cambió de estado (p. ej. ya entregado).
    /// `name` es el nombre del equipo que lo envió, si llegó de fuera.
    Chat {
        message: ChatMessage,
        name: Option<String>,
    },
    /// Señal de llamada de otro equipo (`peer` es su código).
    Signal {
        peer: String,
        name: String,
        signal: Signal,
    },
    /// Se cayó la conexión con `peer` (su código) en plena llamada: la voz y
    /// el vídeo ya no llegan.
    TalkLost {
        peer: String,
    },
    /// La pareja dejó de responder sin despedirse (se quedó sin red, cerró la
    /// app…). Ya se volvió al server (`online`) o a solo red local.
    PartnerLost {
        code: String,
        name: String,
        online: bool,
    },
    /// Quién está ahora en el server de conexión (sin contarnos).
    LobbyUsers {
        users: Vec<LobbyUser>,
    },
    /// Alguien pide conectarse: se contesta con [`crate::Lobby::answer`].
    LobbyRequest {
        request: String,
        from: LobbyUser,
    },
    /// Una solicitud recibida ya no espera respuesta (la retiraron o caducó).
    LobbyRequestGone {
        request: String,
    },
    /// Respuesta a una solicitud enviada que no acabó en conexión
    /// (`reason`: `declined`, `cancelled` o `expired`).
    LobbyAnswer {
        request: String,
        accepted: bool,
        reason: String,
    },
    /// Conexión aceptada por los dos lados: ya se dejó el server.
    LobbyPaired {
        partner: Partner,
    },
    /// No se llega al server (se sigue intentando). Vacío cuando se recupera.
    LobbyError {
        detail: String,
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
