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
    /// Identificador estable del tipo de error, para traducirlo fuera.
    pub fn code(&self) -> &'static str {
        match self {
            Error::Io(_) => "io",
            Error::Local(_) => "local",
            Error::Timeout => "timeout",
            Error::Protocol(_) => "protocol",
            Error::Rejected(_) => "rejected",
            Error::Remote(_) => "remote",
            Error::Superseded => "superseded",
        }
    }

    /// El mensaje sin el prefijo del tipo (vacío si no tiene detalle).
    pub fn detail(&self) -> String {
        match self {
            Error::Io(e) | Error::Local(e) => e.to_string(),
            Error::Protocol(s) | Error::Rejected(s) | Error::Remote(s) => s.clone(),
            Error::Timeout | Error::Superseded => String::new(),
        }
    }

    /// Errores tras los que tiene sentido reconectar y reanudar.
    pub fn is_retryable(&self) -> bool {
        matches!(self, Error::Io(_) | Error::Timeout | Error::Remote(_))
    }
}
