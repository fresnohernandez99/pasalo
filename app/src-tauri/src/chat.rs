//! Comandos del chat: historial, mensajes y fotos. Todo va por el canal de
//! iroh de cada equipo (ver `pasalo_core::Talk`).

use std::path::PathBuf;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use pasalo_core::ChatMessage;
use tauri::State;

use crate::error::{CmdError, CmdResult};
use crate::state::AppState;

#[tauri::command]
pub async fn chat_history(state: State<'_, AppState>, peer: String) -> CmdResult<Vec<ChatMessage>> {
    Ok(state.talk()?.history(&peer))
}

#[tauri::command]
pub async fn chat_send(state: State<'_, AppState>, peer: String, text: String) -> CmdResult<ChatMessage> {
    if text.trim().is_empty() {
        return Err(CmdError::new("nothing_to_send", ""));
    }
    state.talk()?.send_text(&peer, text).await.map_err(CmdError::core)
}

/// `data` es la imagen en base64 (la interfaz ya la ha reducido).
#[tauri::command]
pub async fn chat_send_image(
    state: State<'_, AppState>,
    peer: String,
    data: String,
    ext: String,
) -> CmdResult<ChatMessage> {
    let bytes = BASE64.decode(data).map_err(CmdError::other)?;
    state.talk()?.send_image(&peer, &bytes, &ext).await.map_err(CmdError::core)
}

/// Imagen del chat como `data:` URL. Solo sirve archivos de la carpeta del chat.
#[tauri::command]
pub async fn chat_image(state: State<'_, AppState>, path: PathBuf) -> CmdResult<String> {
    let path = path.canonicalize().map_err(CmdError::other)?;
    let dir = state.chat_dir.canonicalize().map_err(CmdError::other)?;
    if !path.starts_with(&dir) {
        return Err(CmdError::other("ruta fuera del chat"));
    }
    let mime = match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "image/jpeg",
    };
    let bytes = tokio::fs::read(&path).await.map_err(CmdError::other)?;
    Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

