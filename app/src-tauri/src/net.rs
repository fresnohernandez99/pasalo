//! Conexión con otras redes: entrar en el server, pedir o aceptar conectarse
//! con alguien y quedarse solo con esa pareja.
//!
//! With the "chat with several people" setting (`multi_chat`) the app stays
//! on the server after accepting: everyone accepted goes to
//! `AppState::partners`, and connections from others are still allowed.

use std::time::Duration;

use pasalo_core::{Event, Lobby, LobbyUser, Partner, Signal};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{CmdError, CmdResult};
use crate::state::AppState;

/// Lo que se espera a tener relay. Hasta entonces nadie de otra red llega a
/// este equipo por su código.
const RELAY_WAIT: Duration = Duration::from_secs(20);

/// Cuenta a la interfaz por qué paso va la conexión (`internet`, `relay`, `server`).
fn step(app: &AppHandle, step: &str) {
    let _ = app.emit("net_step", step);
}

/// Sale a internet y espera a tener relay: entonces el código de este equipo
/// ya sirve para llegar desde otra red.
async fn reach_internet(app: &AppHandle, remote: &pasalo_core::Remote) -> CmdResult<()> {
    step(app, "internet");
    remote.set_internet(true).await.map_err(CmdError::other)?;
    step(app, "relay");
    if tokio::time::timeout(RELAY_WAIT, remote.online()).await.is_err() {
        let _ = remote.set_internet(false).await;
        return Err(CmdError::new("no_relay", ""));
    }
    Ok(())
}

/// Sale a internet y entra en el server. Hasta aquí la app no intenta nada fuera de la LAN.
#[tauri::command]
pub async fn net_connect(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    if state.partner.lock().unwrap().is_some() {
        return Ok(());
    }
    join(&app, &state).await
}

async fn join(app: &AppHandle, state: &AppState) -> CmdResult<()> {
    let remote = state.remote.as_ref().ok_or_else(|| CmdError::new("remote_unavailable", ""))?;
    let mut lobby = state.lobby.lock().await;
    if lobby.is_some() {
        return Ok(());
    }
    let (server, me, multi) = {
        let settings = state.settings.lock().unwrap();
        let local = state.local.lock().unwrap();
        let me = LobbyUser { id: pasalo_core::session_id(), name: local.name.clone(), platform: local.platform.clone(), code: None };
        (settings.server.clone(), me, settings.multi_chat)
    };
    if server.is_empty() {
        return Err(CmdError::new("no_server", ""));
    }
    reach_internet(app, remote).await?;
    step(app, "server");
    match Lobby::join(&server, remote, me, multi, state.events.clone()).await {
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

/// Sale a internet sin entrar en el server: para llegar a alguien por su
/// enlace, o para que lleguen a este equipo con el suyo.
#[tauri::command]
pub async fn net_direct(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let remote = state.remote.as_ref().ok_or_else(|| CmdError::new("remote_unavailable", ""))?;
    reach_internet(&app, remote).await
}

/// Sale del server y de la conexión con la pareja (avisándola), y vuelve a
/// solo red local.
#[tauri::command]
pub async fn net_disconnect(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    if let Some(lobby) = state.lobby.lock().await.take() {
        lobby.leave().await;
    }
    let mut partners = state.partners.lock().unwrap().clone();
    partners.extend(state.partner.lock().unwrap().clone());
    if let Some(talk) = &state.talk {
        // Everyone is told at once, so several partners don't add up the waits.
        let mut byes = tokio::task::JoinSet::new();
        for partner in partners {
            let talk = talk.clone();
            byes.spawn(async move {
                let bye = Signal { call: String::new(), kind: "unpair".into(), data: serde_json::Value::Null };
                let _ = tokio::time::timeout(Duration::from_secs(5), talk.signal(&partner.code, bye)).await;
            });
        }
        byes.join_all().await;
    }
    for partner in state.partners.lock().unwrap().clone() {
        drop_one(&app, &state, &partner.code);
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
    // Sin pareja ya no se está ocupado: fuera del server.
    if let Some(busy) = state.busy.lock().unwrap().take() {
        tauri::async_runtime::spawn(async move { busy.leave().await });
    }
    let partner = state.partner.lock().unwrap().take()?;
    crate::call::stop_with(app, state, &partner.code);
    if let Some(talk) = &state.talk {
        talk.release(&partner.code);
        // Chat privado: al desconectarse, su historial se borra.
        talk.wipe_private(&partner.code);
    }
    state.receiver.set_only(None);
    if let Some(remote) = &state.remote {
        remote.set_only(None);
    }
    Some(partner)
}

/// Drops one of the `partners` (multi mode): its call and connection go, the
/// app stays on the server. Returns whether it was one.
fn drop_one(app: &AppHandle, state: &AppState, code: &str) -> bool {
    let removed = {
        let mut partners = state.partners.lock().unwrap();
        let before = partners.len();
        partners.retain(|p| p.code != code);
        partners.len() != before
    };
    if removed {
        crate::call::stop_with(app, state, code);
        if let Some(talk) = &state.talk {
            talk.release(code);
            talk.wipe_private(code);
        }
    }
    removed
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
        if released {
            return;
        }
        // One of several: only that one goes, the app is still on the server.
        if drop_one(&app, &state, &partner.code) {
            eprintln!("{} dejó de responder", partner.name);
            let _ = state.events.send(Event::PartnerLost { code: partner.code, name: partner.name, online: true });
            return;
        }
        let ours = state.partner.lock().unwrap().as_ref().is_some_and(|p| p.code == partner.code);
        if !ours {
            return;
        }
        eprintln!("la pareja {} dejó de responder", partner.name);
        drop_partner(&app, &state);
        let online = join(&app, &state).await.is_ok();
        let _ = state.events.send(Event::PartnerLost { code: partner.code, name: partner.name, online });
    });
}

async fn lobby(state: &AppState) -> CmdResult<Lobby> {
    state.lobby.lock().await.clone().ok_or_else(|| CmdError::new("not_online", ""))
}

/// Pide conectarse con `to`; `friend` si es un amigo (se le dice quién es).
#[tauri::command]
pub async fn lobby_request(state: State<'_, AppState>, to: LobbyUser, friend: Option<bool>) -> CmdResult<String> {
    lobby(&state).await?.request(&to, friend.unwrap_or(false)).await.map_err(CmdError::core)
}

/// Cuáles de los amigos (por su código) están en el server: libres u ocupados.
#[tauri::command]
pub async fn lobby_friends(state: State<'_, AppState>, codes: Vec<String>) -> CmdResult<Vec<pasalo_core::Friend>> {
    lobby(&state).await?.friends(&codes).await.map_err(|e| CmdError::new("server", e.detail()))
}

/// Una página de los que están en línea, con búsqueda (pantalla Descubrir).
#[tauri::command]
pub async fn lobby_users(state: State<'_, AppState>, q: String, offset: u64, limit: u64) -> CmdResult<pasalo_core::UsersPage> {
    lobby(&state).await?.users(&q, offset, limit).await.map_err(|e| CmdError::new("server", e.detail()))
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
        // Emparejados: fuera de la lista (la sesión solo avisa de que se
        // está ocupado) y solo la pareja puede llegar.
        // Several people: it stays on the server, open to everyone.
        Event::LobbyPaired { partner } if state.lobby.lock().await.as_ref().is_some_and(Lobby::is_multi) => {
            let fresh = {
                let mut partners = state.partners.lock().unwrap();
                let fresh = !partners.iter().any(|p| p.code == partner.code);
                if fresh {
                    partners.push(partner.clone());
                }
                fresh
            };
            if fresh {
                watch_partner(app.clone(), partner.clone());
            }
        }
        Event::LobbyPaired { partner } => {
            *state.busy.lock().unwrap() = state.lobby.lock().await.take();
            *state.partner.lock().unwrap() = Some(partner.clone());
            state.receiver.set_only(Some(partner.id.clone()));
            if let Some(remote) = &state.remote {
                remote.set_only(pasalo_core::parse_code(&partner.code));
            }
            watch_partner(app.clone(), partner.clone());
        }
        // La pareja se despidió: se vuelve a solo red local.
        Event::Signal { peer, signal, .. } if signal.kind == "unpair" && drop_one(app, &state, peer) => {}
        Event::Signal { peer, signal, .. } if signal.kind == "unpair" => {
            let ours = state.partner.lock().unwrap().as_ref().is_some_and(|p| p.code == *peer);
            if ours {
                drop_partner(app, &state);
                if let Some(remote) = &state.remote {
                    let _ = remote.set_internet(false).await;
                }
            }
        }
        // El otro marcó (o desmarcó) el chat como privado: aquí también.
        Event::Signal { peer, signal, .. } if signal.kind == "private" => {
            if let Some(talk) = &state.talk {
                let on = signal.data.get("on").and_then(|v| v.as_bool()).unwrap_or(false);
                let _ = talk.set_private(peer, on);
            }
        }
        // El otro se desconecta: su chat privado se borra también aquí.
        Event::Signal { peer, signal, .. } if signal.kind == "wipe" => {
            if let Some(talk) = &state.talk {
                talk.wipe_private(peer);
            }
        }
        // Se cortó la conexión en plena llamada: no se sigue grabando ni sonando.
        Event::TalkLost { peer } => crate::call::stop_with(app, &state, peer),
        _ => {}
    }
}
