//! Errores de los comandos tal como los recibe la interfaz.

use serde::Serialize;

pub type CmdResult<T> = Result<T, CmdError>;

/// Error de un comando. La interfaz traduce `code` y muestra `detail` tal cual.
#[derive(Debug, Serialize)]
pub struct CmdError {
    code: &'static str,
    detail: String,
}

impl CmdError {
    pub fn new(code: &'static str, detail: impl ToString) -> Self {
        Self { code, detail: detail.to_string() }
    }

    /// Errores sin traducción propia (E/S, diálogos…): solo se muestra el detalle.
    pub fn other(e: impl std::fmt::Display) -> Self {
        Self::new("other", e)
    }

    pub fn core(e: pasalo_core::Error) -> Self {
        Self { code: e.code(), detail: e.detail() }
    }
}
