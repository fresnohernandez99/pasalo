//! Conexión con otras redes: entrar en el server, pedir o aceptar conectarse
//! con alguien y quedarse solo con esa pareja.

use pasalo_core::{Event, Lobby, LobbyUser, Partner, Signal};
use tauri::State;

use crate::error::{CmdError, CmdResult};
use crate::state::AppState;

/// Sale a internet y entra en el server. Hasta aquí la app no intenta nada fuera de la LAN.
#[tauri::command]
pub async fn net_connect(state: State<'_, AppState>) -> CmdResult<()> {
    let remote = state.remote.as_ref().ok_or_else(|| CmdError::new("remote_unavailable", ""))?;
    let mut lobby = state.lobby.lock().await;
    if lobby.is_some() || state.partner.lock().unwrap().is_some() {
        return Ok(());
    }
    let (server, me) = {
        let settings = state.settings.lock().unwrap();
        let local = state.local.lock().unwrap();
        let me = LobbyUser { id: local.device_id.clone(), name: local.name.clone(), platform: local.platform.clone() };
        (settings.server.clone(), me)
    };
    if server.is_empty() {
        return Err(CmdError::new("no_server", ""));
    }
    remote.set_internet(true).await.map_err(CmdError::other)?;
    match Lobby::join(&server, remote, me, state.events.clone()).await {
        Ok(joined) => {
            *lobby = Some(joined);
            Ok(())
        }
        Err(e) => {
            let _ = remote.set_internet(false).await;
            Err(CmdError::new("server", e.detail()))
        }
    }
}

/// Sale del server y de la conexión con la pareja (avisándola), y vuelve a
/// solo red local.
#[tauri::command]
pub async fn net_disconnect(state: State<'_, AppState>) -> CmdResult<()> {
    if let Some(lobby) = state.lobby.lock().await.take() {
        lobby.leave().await;
    }
    let partner = state.partner.lock().unwrap().take();
    if let (Some(partner), Some(talk)) = (partner, &state.talk) {
        let bye = Signal { call: String::new(), kind: "unpair".into(), data: serde_json::Value::Null };
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), talk.signal(&partner.code, bye)).await;
    }
    state.receiver.set_only(None);
    if let Some(remote) = &state.remote {
        remote.set_only(None);
        remote.set_internet(false).await.map_err(CmdError::other)?;
    }
    Ok(())
}

async fn lobby(state: &AppState) -> CmdResult<Lobby> {
    state.lobby.lock().await.clone().ok_or_else(|| CmdError::new("not_online", ""))
}

#[tauri::command]
pub async fn lobby_request(state: State<'_, AppState>, to: LobbyUser) -> CmdResult<String> {
    lobby(&state).await?.request(&to).await.map_err(CmdError::core)
}

#[tauri::command]
pub async fn lobby_cancel(state: State<'_, AppState>, request: String) -> CmdResult<()> {
    lobby(&state).await?.cancel(&request).await.map_err(CmdError::core)
}

/// Contesta una solicitud. Al aceptar llega también `Event::LobbyPaired`.
#[tauri::command]
pub async fn lobby_answer(state: State<'_, AppState>, request: String, accept: bool) -> CmdResult<Option<Partner>> {
    lobby(&state).await?.answer(&request, accept).await.map_err(CmdError::core)
}

/// Lo que cambia en el estado con algunos eventos, antes de pasarlos a la interfaz.
pub async fn on_event(state: &AppState, event: &Event) {
    match event {
        // Emparejados: fuera del server y solo la pareja puede llegar.
        Event::LobbyPaired { partner } => {
            state.lobby.lock().await.take();
            *state.partner.lock().unwrap() = Some(partner.clone());
            state.receiver.set_only(Some(partner.id.clone()));
            if let Some(remote) = &state.remote {
                remote.set_only(pasalo_core::parse_code(&partner.code));
            }
        }
        // La pareja se despidió: se vuelve a solo red local.
        Event::Signal { peer, signal, .. } if signal.kind == "unpair" => {
            let ours = state.partner.lock().unwrap().as_ref().is_some_and(|p| p.code == *peer);
            if ours {
                state.partner.lock().unwrap().take();
                state.receiver.set_only(None);
                if let Some(remote) = &state.remote {
                    remote.set_only(None);
                    let _ = remote.set_internet(false).await;
                }
            }
        }
        _ => {}
    }
}
