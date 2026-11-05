#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("error de E/S: {0}")]
    Io(#[from] std::io::Error),
    #[error("error leyendo archivos locales: {0}")]
    Local(std::io::Error),
    #[error("tiempo de espera agotado")]
    Timeout,
    #[error("error de protocolo: {0}")]
    Protocol(String),
    #[error("el receptor rechazó la transferencia: {0}")]
    Rejected(String),
    #[error("el receptor informó un error: {0}")]
    Remote(String),
    #[error("sustituida por una conexión más reciente")]
    Superseded,
}

impl Error {
    /// Errores tras los que tiene sentido reconectar y reanudar.
    pub fn is_retryable(&self) -> bool {
        matches!(self, Error::Io(_) | Error::Timeout | Error::Remote(_))
    }
}
