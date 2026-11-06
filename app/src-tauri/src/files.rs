//! Envío y recepción de archivos: elegir qué enviar, enviarlo, pausarlo,
//! reanudarlo o cancelarlo, y contestar a quien quiere enviarnos algo.

use std::path::PathBuf;

use pasalo_core::{Greeting, TransferId};
use tauri::{AppHandle, State};
#[cfg(desktop)]
use tauri_plugin_dialog::DialogExt;
#[cfg(desktop)]
use tokio::sync::oneshot;
#[cfg(target_os = "android")]
use tauri::Manager;

use crate::error::{CmdError, CmdResult};
use crate::state::{AppState, Outgoing};

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn pick_files(app: AppHandle) -> CmdResult<Vec<PathBuf>> {
    app.state::<crate::android::Android>().pick_files().await.map_err(|e| CmdError::new("pick_failed", e))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn pick_files(app: AppHandle) -> CmdResult<Vec<PathBuf>> {
    let (tx, rx) = oneshot::channel();
    app.dialog().file().pick_files(move |files| {
        let _ = tx.send(files);
    });
    let files = rx.await.map_err(CmdError::other)?.unwrap_or_default();
    Ok(files.into_iter().filter_map(|f| f.into_path().ok()).collect())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn pick_folder(_app: AppHandle) -> CmdResult<Option<PathBuf>> {
    Err(CmdError::new("mobile_files_only", ""))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> CmdResult<Option<PathBuf>> {
    let (tx, rx) = oneshot::channel();
    app.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder);
    });
    let folder = rx.await.map_err(CmdError::other)?;
    Ok(folder.and_then(|f| f.into_path().ok()))
}

#[tauri::command]
pub async fn send(state: State<'_, AppState>, target: String, paths: Vec<PathBuf>) -> CmdResult<TransferId> {
    if paths.is_empty() {
        return Err(CmdError::new("nothing_to_send", ""));
    }
    let target = state.parse_target(&target)?;
    let id = pasalo_core::new_transfer_id();
    state.outgoing.lock().unwrap().insert(id, Outgoing { target, paths, task: None });
    state.spawn_send(id);
    Ok(id)
}

#[tauri::command]
pub async fn send_text(state: State<'_, AppState>, target: String, text: String) -> CmdResult<()> {
    let target = state.parse_target(&target)?;
    let local = state.local.lock().unwrap().clone();
    pasalo_core::send_text(&target, &local, &text).await.map_err(CmdError::core)
}

/// Comprueba que se llega a un equipo (por IP o por código) y devuelve cómo se llama.
#[tauri::command]
pub async fn probe(state: State<'_, AppState>, target: String) -> CmdResult<Greeting> {
    let target = state.parse_target(&target)?;
    let local = state.local.lock().unwrap().clone();
    pasalo_core::probe(&target, &local).await.map_err(|e| CmdError::new("connect_failed", e.detail()))
}

/// Acepta o rechaza un envío que pide permiso.
#[tauri::command]
pub fn transfer_decide(state: State<'_, AppState>, id: TransferId, accept: bool) -> bool {
    state.receiver.decide(id, accept)
}

#[tauri::command]
pub async fn pause(state: State<'_, AppState>, id: TransferId) -> CmdResult<()> {
    if let Some(task) = state.outgoing.lock().unwrap().get_mut(&id).and_then(|job| job.task.take()) {
        task.abort();
    }
    Ok(())
}

#[tauri::command]
pub async fn resume(state: State<'_, AppState>, id: TransferId) -> CmdResult<()> {
    state.spawn_send(id);
    Ok(())
}

#[tauri::command]
pub async fn forget(state: State<'_, AppState>, id: TransferId) -> CmdResult<()> {
    if let Some(task) = state.outgoing.lock().unwrap().remove(&id).and_then(|job| job.task) {
        task.abort();
    }
    Ok(())
}

/// Cancela una recepción en curso: se borra lo recibido y el emisor deja de
/// intentarlo. Para cancelar un envío propio, `forget`.
#[tauri::command]
pub async fn cancel_incoming(state: State<'_, AppState>, id: TransferId) -> CmdResult<bool> {
    Ok(state.receiver.cancel(id))
}
