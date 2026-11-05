//! Comandos del chat y de las llamadas de voz. Las videollamadas van con
//! WebRTC en la interfaz; de aquí solo usan `call_signal`.

use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use pasalo_call::Mode;
use pasalo_core::{ChatMessage, Signal, Talk};
use serde::Serialize;
use tauri::{AppHandle, State};
use tokio::task::JoinHandle;

use crate::{AppState, CmdError, CmdResult};

/// Llamada de voz en marcha.
pub struct VoiceCall {
    peer: String,
    call: Arc<pasalo_call::Call>,
    /// Para medir lo que pasa de verdad por la conexión.
    link: pasalo_core::VoiceSender,
    pump: JoinHandle<()>,
}

impl AppState {
    fn talk(&self) -> CmdResult<&Talk> {
        self.talk.as_ref().ok_or_else(|| CmdError::new("remote_unavailable", ""))
    }
}

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

#[tauri::command]
pub async fn call_signal(
    state: State<'_, AppState>,
    peer: String,
    call: String,
    kind: String,
    data: serde_json::Value,
) -> CmdResult<()> {
    state.talk()?.signal(&peer, Signal { call, kind, data }).await.map_err(CmdError::core)
}

#[tauri::command]
pub async fn voice_start(app: AppHandle, state: State<'_, AppState>, peer: String, mode: Mode) -> CmdResult<()> {
    stop(&app, &state);
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let android = app.state::<crate::android::Android>();
        if !android.request_audio().await {
            return Err(CmdError::new("mic_denied", ""));
        }
        android.call_audio(true, false);
    }
    let talk = state.talk()?;
    let mut link = talk.voice(&peer).await.map_err(CmdError::core)?;
    let sender = link.sender.clone();
    let measured = link.sender.clone();
    // Abrir los dispositivos de audio bloquea un momento.
    let call = tokio::task::spawn_blocking(move || {
        pasalo_call::Call::start(mode, move |packet| {
            sender.send(packet.into());
        })
    })
    .await
    .map_err(CmdError::other)?
    .map_err(|e| CmdError::new("audio_failed", e))?;
    let call = Arc::new(call);
    let receiving = call.clone();
    let pump = tokio::spawn(async move {
        while let Some(packet) = link.rx.recv().await {
            receiving.push(&packet);
        }
    });
    *state.voice.lock().unwrap() = Some(VoiceCall { peer, call, link: measured, pump });
    Ok(())
}

#[tauri::command]
pub fn voice_mode(state: State<'_, AppState>, mode: Mode) {
    if let Some(voice) = &*state.voice.lock().unwrap() {
        voice.call.set_mode(mode);
    }
}

#[tauri::command]
pub fn voice_mute(state: State<'_, AppState>, muted: bool) {
    if let Some(voice) = &*state.voice.lock().unwrap() {
        voice.call.set_muted(muted);
    }
}

/// Por dónde suena en el móvil: altavoz o auricular.
// Asíncronos: los síncronos van en el hilo principal y la llamada a Kotlin
// espera a ese mismo hilo.
#[tauri::command]
pub async fn voice_speaker(app: AppHandle, speaker: bool) {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        app.state::<crate::android::Android>().call_audio(true, speaker);
    }
    let _ = (app, speaker);
}

#[tauri::command]
pub async fn voice_stop(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    stop(&app, &state);
    Ok(())
}

fn stop(app: &AppHandle, state: &AppState) {
    if let Some(voice) = state.voice.lock().unwrap().take() {
        voice.pump.abort();
        if let Some(talk) = &state.talk {
            talk.end_voice(&voice.peer);
        }
        #[cfg(target_os = "android")]
        {
            use tauri::Manager;
            app.state::<crate::android::Android>().call_audio(false, false);
        }
    }
    let _ = app;
}

#[derive(Serialize)]
pub struct VoiceStats {
    /// Bytes medidos por la conexión (UDP con cabeceras IP), acumulados: la
    /// interfaz calcula el ritmo con la diferencia entre lecturas.
    sent: u64,
    received: u64,
    lost: u64,
    recovered: u64,
}

#[tauri::command]
pub fn voice_stats(state: State<'_, AppState>) -> Option<VoiceStats> {
    use std::sync::atomic::Ordering::Relaxed;
    let voice = state.voice.lock().unwrap();
    let voice = voice.as_ref()?;
    let stats = voice.call.stats();
    let (sent, received) = voice.link.wire_bytes();
    Some(VoiceStats {
        sent,
        received,
        lost: stats.lost_packets.load(Relaxed),
        recovered: stats.recovered_packets.load(Relaxed),
    })
}
