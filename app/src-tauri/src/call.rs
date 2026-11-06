//! Comandos de las llamadas. La voz se graba, comprime y suena aquí
//! (`pasalo-call`); el vídeo lo comprime la interfaz con WebCodecs y aquí solo
//! se lleva y se trae por la conexión de iroh, como la voz. Las señales
//! (invitar, contestar, colgar…) van por `call_signal`.

use std::sync::Arc;

use pasalo_call::Mode;
use pasalo_core::Signal;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::{AppHandle, State};
use tokio::task::JoinHandle;

use crate::error::{CmdError, CmdResult};
use crate::state::AppState;

/// Llamada de voz en marcha.
pub struct VoiceCall {
    pub peer: String,
    call: Arc<pasalo_call::Call>,
    /// Para medir lo que pasa de verdad por la conexión.
    link: pasalo_core::VoiceSender,
    pump: JoinHandle<()>,
}

/// Vídeo de una videollamada en marcha.
pub struct VideoCall {
    peer: String,
    sender: pasalo_core::VideoSender,
    pump: JoinHandle<()>,
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
    let started = start_voice(&state, &peer, mode).await;
    // Si no arrancó, nada se queda a medias: ni el canal ni el audio en modo llamada.
    if started.is_err() {
        if let Some(talk) = &state.talk {
            talk.end_voice(&peer);
        }
        #[cfg(target_os = "android")]
        {
            use tauri::Manager;
            app.state::<crate::android::Android>().call_audio(false, false);
        }
    }
    let _ = &app;
    started
}

async fn start_voice(state: &AppState, peer: &str, mode: Mode) -> CmdResult<()> {
    let talk = state.talk()?;
    let mut link = talk.voice(peer).await.map_err(CmdError::core)?;
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
    *state.voice.lock().unwrap() = Some(VoiceCall { peer: peer.to_string(), call, link: measured, pump });
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

/// Corta la voz y el vídeo si son con `peer` (se desconectó o se perdió la conexión).
pub fn stop_with(app: &AppHandle, state: &AppState, peer: &str) {
    let same = |other: &str| pasalo_core::parse_code(other) == pasalo_core::parse_code(peer);
    if state.voice.lock().unwrap().as_ref().is_some_and(|v| same(&v.peer)) {
        stop(app, state);
    }
    if state.video.lock().unwrap().as_ref().is_some_and(|v| same(&v.peer)) {
        stop_video(state);
    }
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

/// Empieza a llevar vídeo con `peer`: lo que llegue sale por `frames`, una
/// imagen comprimida por mensaje, tal cual la mandó el otro lado.
#[tauri::command]
pub async fn video_start(
    state: State<'_, AppState>,
    peer: String,
    frames: Channel<InvokeResponseBody>,
) -> CmdResult<()> {
    stop_video(&state);
    let mut link = state.talk()?.video(&peer).await.map_err(CmdError::core)?;
    let pump = tokio::spawn(async move {
        while let Some(frame) = link.rx.recv().await {
            if frames.send(InvokeResponseBody::Raw(frame.to_vec())).is_err() {
                break;
            }
        }
    });
    *state.video.lock().unwrap() = Some(VideoCall { peer, sender: link.sender, pump });
    Ok(())
}

/// Manda una imagen (el cuerpo de la petición, en binario). `false` si se
/// descartó porque la red va atrasada: la siguiente tiene que ser clave.
#[tauri::command]
pub async fn video_send(state: State<'_, AppState>, request: Request<'_>) -> CmdResult<bool> {
    let frame = match request.body() {
        InvokeBody::Raw(frame) => bytes::Bytes::copy_from_slice(frame),
        // En Android la IPC va por postMessage y el binario llega como JSON.
        InvokeBody::Json(json) => json_bytes(json).ok_or_else(|| CmdError::other("imagen no válida"))?.into(),
    };
    let video = state.video.lock().unwrap();
    let Some(video) = video.as_ref() else { return Ok(false) };
    Ok(video.sender.send(frame))
}

/// Un `Uint8Array` pasado a JSON: `[1, 2, …]` o `{"0": 1, "1": 2, …}`.
fn json_bytes(json: &serde_json::Value) -> Option<Vec<u8>> {
    let byte = |v: &serde_json::Value| v.as_u64().and_then(|n| u8::try_from(n).ok());
    match json {
        serde_json::Value::Array(items) => items.iter().map(byte).collect(),
        serde_json::Value::Object(map) => (0..map.len()).map(|i| map.get(&i.to_string()).and_then(byte)).collect(),
        _ => None,
    }
}

#[tauri::command]
pub fn video_stop(state: State<'_, AppState>) {
    stop_video(&state);
}

fn stop_video(state: &AppState) {
    if let Some(video) = state.video.lock().unwrap().take() {
        video.pump.abort();
        if let Some(talk) = &state.talk {
            talk.end_video(&video.peer);
        }
    }
}
