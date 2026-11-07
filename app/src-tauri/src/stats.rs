//! Registro de las llamadas: cada una queda en su chat (como «Llamada de voz
//! · 3:21», con los detalles al tocarla) y en la lista de estadísticas, que
//! solo se sube al server cuando el usuario pulsa Subir en Ajustes.

use pasalo_core::ChatMessage;
use tauri::State;

use crate::error::{CmdError, CmdResult};
use crate::state::AppState;

/// Apunta una llamada que terminó. `record` lo arma la interfaz (call.js).
#[tauri::command]
pub fn call_record(state: State<'_, AppState>, peer: String, record: serde_json::Value) -> CmdResult<ChatMessage> {
    if !record.is_object() {
        return Err(CmdError::other("registro de llamada no válido"));
    }
    let message = state.talk()?.log_call(&peer, record.clone()).map_err(CmdError::core)?;
    state.call_stats.push(&record).map_err(CmdError::other)?;
    Ok(message)
}

/// Llamadas que faltan por subir.
#[tauri::command]
pub fn stats_pending(state: State<'_, AppState>) -> usize {
    state.call_stats.pending().len()
}

/// Sube las estadísticas pendientes al server de conexión. Devuelve cuántas.
#[tauri::command]
pub async fn stats_upload(state: State<'_, AppState>) -> CmdResult<usize> {
    let remote = state.remote.as_ref().ok_or_else(|| CmdError::new("remote_unavailable", ""))?;
    let server = state.settings.lock().unwrap().server.clone();
    if server.is_empty() {
        return Err(CmdError::new("no_server", ""));
    }
    let (device, platform) = {
        let local = state.local.lock().unwrap();
        (local.device_id.clone(), local.platform.clone())
    };
    state
        .call_stats
        .upload(remote, &server, &device, &platform, env!("CARGO_PKG_VERSION"))
        .await
        .map_err(|e| CmdError::new("server", e.detail()))
}
