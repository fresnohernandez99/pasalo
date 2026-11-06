//! Conexión con otras redes: entrar en el server, pedir o aceptar conectarse
//! con alguien y quedarse solo con esa pareja.

use std::time::Duration;

use pasalo_core::{Event, Lobby, LobbyUser, Partner, Signal};
use tauri::{AppHandle, Manager, State};

use crate::error::{CmdError, CmdResult};
use crate::state::AppState;

/// Sale a internet y entra en el server. Hasta aquí la app no intenta nada fuera de la LAN.
#[tauri::command]
pub async fn net_connect(state: State<'_, AppState>) -> CmdResult<()> {
    if state.partner.lock().unwrap().is_some() {
        return Ok(());
    }
    join(&state).await
}

async fn join(state: &AppState) -> CmdResult<()> {
    let remote = state.remote.as_ref().ok_or_else(|| CmdError::new("remote_unavailable", ""))?;
    let mut lobby = state.lobby.lock().await;
    if lobby.is_some() {
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
pub async fn net_disconnect(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    if let Some(lobby) = state.lobby.lock().await.take() {
        lobby.leave().await;
    }
    let partner = state.partner.lock().unwrap().clone();
    if let (Some(partner), Some(talk)) = (&partner, &state.talk) {
        let bye = Signal { call: String::new(), kind: "unpair".into(), data: serde_json::Value::Null };
        let _ = tokio::time::timeout(Duration::from_secs(5), talk.signal(&partner.code, bye)).await;
    }
    drop_partner(&app, &state);
    if let Some(remote) = &state.remote {
        remote.set_internet(false).await.map_err(CmdError::other)?;
    }
    Ok(())
}

/// Deja la pareja (si la hay): corta la llamada y la conexión con ella y
/// vuelve a aceptar a cualquiera. Devuelve la pareja que había.
fn drop_partner(app: &AppHandle, state: &AppState) -> Option<Partner> {
    let partner = state.partner.lock().unwrap().take()?;
    crate::call::stop_with(app, state, &partner.code);
    if let Some(talk) = &state.talk {
        talk.release(&partner.code);
    }
    state.receiver.set_only(None);
    if let Some(remote) = &state.remote {
        remote.set_only(None);
    }
    Some(partner)
}

/// Lo que se espera a la pareja recién emparejada (puede tardar en enterarse
/// y en encontrar la ruta) y, después, a que vuelva tras un corte.
const FIRST_CONTACT: Duration = Duration::from_secs(60);
const RECONNECT: Duration = Duration::from_secs(20);

/// Mantiene abierta la conexión con la pareja. Si se cae y no vuelve (la
/// otra app se cerró o se quedó sin red), se deja la pareja y se vuelve al
/// server para poder conectarse de nuevo.
fn watch_partner(app: AppHandle, partner: Partner) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let Some(talk) = state.talk.clone() else { return };
        let released = talk.hold(&partner.code, FIRST_CONTACT, RECONNECT).await;
        let ours = state.partner.lock().unwrap().as_ref().is_some_and(|p| p.code == partner.code);
        if released || !ours {
            return;
        }
        eprintln!("la pareja {} dejó de responder", partner.name);
        drop_partner(&app, &state);
        let online = join(&state).await.is_ok();
        let _ = state.events.send(Event::PartnerLost { code: partner.code, name: partner.name, online });
    });
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
pub async fn on_event(app: &AppHandle, event: &Event) {
    let state = app.state::<AppState>();
    match event {
        // Emparejados: fuera del server y solo la pareja puede llegar.
        Event::LobbyPaired { partner } => {
            state.lobby.lock().await.take();
            *state.partner.lock().unwrap() = Some(partner.clone());
            state.receiver.set_only(Some(partner.id.clone()));
            if let Some(remote) = &state.remote {
                remote.set_only(pasalo_core::parse_code(&partner.code));
            }
            watch_partner(app.clone(), partner.clone());
        }
        // La pareja se despidió: se vuelve a solo red local.
        Event::Signal { peer, signal, .. } if signal.kind == "unpair" => {
            let ours = state.partner.lock().unwrap().as_ref().is_some_and(|p| p.code == *peer);
            if ours {
                drop_partner(app, &state);
                if let Some(remote) = &state.remote {
                    let _ = remote.set_internet(false).await;
                }
            }
        }
        // Se cortó la conexión en plena llamada: no se sigue grabando ni sonando.
        Event::TalkLost { peer } => crate::call::stop_with(app, &state, peer),
        _ => {}
    }
}
