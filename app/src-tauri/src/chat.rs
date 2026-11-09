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

/// Si el chat con `peer` es privado.
#[tauri::command]
pub fn chat_private(state: State<'_, AppState>, peer: String) -> CmdResult<bool> {
    Ok(state.talk()?.is_private(&peer))
}

/// Marca el chat con `peer` como privado (o no). La interfaz avisa al otro.
#[tauri::command]
pub fn chat_set_private(state: State<'_, AppState>, peer: String, on: bool) -> CmdResult<()> {
    state.talk()?.set_private(&peer, on).map_err(CmdError::core)
}

/// Borra el historial con `peer` si el chat es privado (al desconectarse).
#[tauri::command]
pub fn chat_wipe(state: State<'_, AppState>, peer: String) -> CmdResult<bool> {
    Ok(state.talk()?.wipe_private(&peer))
}

/// Registro local en el chat con `peer`: una partida o unos archivos.
#[tauri::command]
pub fn chat_log(state: State<'_, AppState>, peer: String, record: serde_json::Value) -> CmdResult<ChatMessage> {
    state.talk()?.log_event(&peer, record).map_err(CmdError::core)
}

/// Nota de voz (`data` en base64, ya comprimida por la interfaz).
#[tauri::command]
pub async fn chat_send_audio(
    state: State<'_, AppState>,
    peer: String,
    data: String,
    ext: String,
    duration_ms: u64,
) -> CmdResult<ChatMessage> {
    let bytes = BASE64.decode(data).map_err(CmdError::other)?;
    state.talk()?.send_audio(&peer, &bytes, &ext, duration_ms).await.map_err(CmdError::core)
}

/// Foto de una sola vez (`data` en base64, ya reducida por la interfaz).
#[tauri::command]
pub async fn chat_send_once(state: State<'_, AppState>, peer: String, data: String, ext: String) -> CmdResult<ChatMessage> {
    let bytes = BASE64.decode(data).map_err(CmdError::other)?;
    state.talk()?.send_once(&peer, &bytes, &ext).await.map_err(CmdError::core)
}

/// Abre una foto de una vez: la devuelve como `data:` URL y la borra.
#[tauri::command]
pub async fn chat_once_open(state: State<'_, AppState>, peer: String, id: String) -> CmdResult<String> {
    let (bytes, ext) = state.talk()?.open_once(&peer, &id).await.map_err(CmdError::core)?;
    Ok(format!("data:{};base64,{}", mime_for(&ext), BASE64.encode(bytes)))
}

/// Foto o nota de voz del chat como `data:` URL. Solo sirve archivos de la
/// carpeta del chat, y nunca las fotos de una vez (esas, con `chat_once_open`).
#[tauri::command]
pub async fn chat_image(state: State<'_, AppState>, path: PathBuf) -> CmdResult<String> {
    let path = path.canonicalize().map_err(CmdError::other)?;
    let dir = state.chat_dir.canonicalize().map_err(CmdError::other)?;
    let once = path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(pasalo_core::ONCE_PREFIX));
    if !path.starts_with(&dir) || once {
        return Err(CmdError::other("ruta fuera del chat"));
    }
    let mime = mime_for(path.extension().and_then(|e| e.to_str()).unwrap_or(""));
    let bytes = tokio::fs::read(&path).await.map_err(CmdError::other)?;
    Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

fn mime_for(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "webm" => "audio/webm",
        "ogg" | "opus" => "audio/ogg",
        "m4a" | "mp4" | "aac" => "audio/mp4",
        _ => "image/jpeg",
    }
}

/// Mientras se ve una foto de una vez: sin capturas ni grabación de pantalla
/// (Android, macOS y Windows; en Linux el sistema no lo permite).
#[tauri::command]
pub async fn secure_view(app: tauri::AppHandle, on: bool) {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        app.state::<crate::android::Android>().secure(on).await;
    }
    #[cfg(desktop)]
    {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_content_protected(on);
        }
    }
    let _ = (app, on);
}

