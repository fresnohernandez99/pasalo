#[cfg(target_os = "android")]
mod android;
mod talk;

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use pasalo_core::protocol::{DISCOVERY_PORT, TRANSFER_PORT};
use pasalo_core::{
    Discovery, Event, EventSender, Greeting, Lobby, LobbyUser, LocalInfo, Partner, Peer, Receiver, Remote, SendOptions,
    Signal, Talk, Target, TransferId,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(desktop)]
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::mpsc;
#[cfg(desktop)]
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

type CmdResult<T> = Result<T, CmdError>;

/// Error de un comando. La interfaz traduce `code` y muestra `detail` tal cual.
#[derive(Debug, Serialize)]
struct CmdError {
    code: &'static str,
    detail: String,
}

impl CmdError {
    fn new(code: &'static str, detail: impl ToString) -> Self {
        Self { code, detail: detail.to_string() }
    }

    /// Errores sin traducción propia (E/S, diálogos…): solo se muestra el detalle.
    fn other(e: impl std::fmt::Display) -> Self {
        Self::new("other", e)
    }

    fn core(e: pasalo_core::Error) -> Self {
        Self { code: e.code(), detail: e.detail() }
    }
}

/// Server de conexión por defecto (ver `server/README.md`). Se puede cambiar
/// en Ajustes.
const DEFAULT_SERVER: &str = "https://pasalo-server.vercel.app";

#[derive(Clone, Serialize, Deserialize)]
struct Settings {
    name: String,
    dir: PathBuf,
    #[serde(default = "default_server")]
    server: String,
}

fn default_server() -> String {
    DEFAULT_SERVER.to_string()
}

/// Un envío que se puede pausar (abortando la tarea) y reanudar (volviendo a
/// enviar lo mismo con el mismo id).
struct Outgoing {
    target: Target,
    paths: Vec<PathBuf>,
    task: Option<JoinHandle<()>>,
}

struct AppState {
    settings_path: PathBuf,
    settings: Mutex<Settings>,
    local: Mutex<LocalInfo>,
    receiver: Receiver,
    discovery: tokio::sync::Mutex<Option<Discovery>>,
    /// iroh. Arranca en modo solo red local; pasa a internet al conectarse.
    /// `None` si no se pudo arrancar.
    remote: Option<Remote>,
    /// Chat y llamadas; existe si hay `remote`.
    talk: Option<Talk>,
    /// Sesión en el server mientras se está conectado y sin pareja.
    lobby: tokio::sync::Mutex<Option<Lobby>>,
    /// El otro equipo, tras aceptar una conexión.
    partner: Mutex<Option<Partner>>,
    chat_dir: PathBuf,
    voice: Mutex<Option<talk::VoiceCall>>,
    events: EventSender,
    outgoing: Mutex<HashMap<TransferId, Outgoing>>,
}

impl AppState {
    fn save_settings(&self) -> CmdResult<()> {
        let settings = self.settings.lock().unwrap().clone();
        let json = serde_json::to_vec_pretty(&settings).map_err(CmdError::other)?;
        std::fs::write(&self.settings_path, json).map_err(CmdError::other)
    }

    fn spawn_send(&self, id: TransferId) {
        let mut outgoing = self.outgoing.lock().unwrap();
        let Some(job) = outgoing.get_mut(&id) else { return };
        if job.task.as_ref().is_some_and(|task| !task.is_finished()) {
            return;
        }
        let (target, paths) = (job.target.clone(), job.paths.clone());
        let local = self.local.lock().unwrap().clone();
        let events = self.events.clone();
        job.task = Some(tokio::spawn(async move {
            let opts = SendOptions::default();
            let _ = pasalo_core::send_paths(id, &target, &local, &paths, &opts, &events).await;
        }));
    }

    /// `IP:puerto`, solo `IP` (puerto por defecto) o el código de un equipo remoto.
    fn parse_target(&self, target: &str) -> CmdResult<Target> {
        let target = target.trim();
        if let Ok(addr) = target.parse::<SocketAddr>() {
            return Ok(Target::Lan(addr));
        }
        if let Ok(ip) = target.parse::<IpAddr>() {
            return Ok(Target::Lan(SocketAddr::new(ip, TRANSFER_PORT)));
        }
        let Some(code) = pasalo_core::parse_code(target) else {
            return Err(CmdError::new("invalid_target", target));
        };
        match &self.remote {
            Some(remote) => Ok(Target::Remote(remote.clone(), code)),
            None => Err(CmdError::new("remote_unavailable", "")),
        }
    }

    async fn restart_discovery(&self) {
        let mut discovery = self.discovery.lock().await;
        if let Some(old) = discovery.take() {
            old.shutdown().await;
        }
        let local = self.local.lock().unwrap().clone();
        *discovery = Discovery::start(local, DISCOVERY_PORT, self.events.clone())
            .await
            .inspect_err(|e| eprintln!("no se pudo iniciar el descubrimiento: {e}"))
            .ok();
    }
}

#[derive(Serialize)]
struct Snapshot {
    name: String,
    dir: PathBuf,
    port: u16,
    ips: Vec<String>,
    /// Código de iroh de este equipo.
    code: Option<String>,
    /// En el móvil no hay carpetas que elegir ni arrastrar y soltar.
    mobile: bool,
    peers: Vec<Peer>,
    server: String,
    /// En el server (buscando con quién conectarse).
    online: bool,
    partner: Option<Partner>,
}

#[tauri::command]
async fn snapshot(state: State<'_, AppState>) -> CmdResult<Snapshot> {
    let settings = state.settings.lock().unwrap().clone();
    let port = state.local.lock().unwrap().transfer_port;
    let peers = match &*state.discovery.lock().await {
        Some(discovery) => discovery.peers(),
        None => Vec::new(),
    };
    let code = state.remote.as_ref().map(Remote::code);
    let mobile = cfg!(mobile);
    let online = state.lobby.lock().await.is_some();
    let partner = state.partner.lock().unwrap().clone();
    Ok(Snapshot {
        name: settings.name,
        dir: settings.dir,
        port,
        ips: local_ips(),
        code,
        mobile,
        peers,
        server: settings.server,
        online,
        partner,
    })
}

#[tauri::command]
async fn refresh(state: State<'_, AppState>) -> CmdResult<()> {
    if let Some(discovery) = &*state.discovery.lock().await {
        discovery.announce().await;
    }
    Ok(())
}

#[tauri::command]
async fn set_name(state: State<'_, AppState>, name: String) -> CmdResult<()> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(CmdError::new("empty_name", ""));
    }
    state.settings.lock().unwrap().name = name.clone();
    state.save_settings()?;
    let local = {
        let mut local = state.local.lock().unwrap();
        local.name = name;
        local.clone()
    };
    state.receiver.set_local(local);
    if let Some(talk) = &state.talk {
        talk.set_name(&*state.settings.lock().unwrap().name);
    }
    state.restart_discovery().await;
    Ok(())
}

#[tauri::command]
async fn choose_dir(app: AppHandle, state: State<'_, AppState>) -> CmdResult<Option<PathBuf>> {
    let Some(dir) = pick_folder(app).await? else { return Ok(None) };
    state.settings.lock().unwrap().dir = dir.clone();
    state.save_settings()?;
    state.receiver.set_dest(&dir);
    Ok(Some(dir))
}

#[tauri::command]
fn open_dir(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let dir = state.receiver.dest();
    std::fs::create_dir_all(&dir).map_err(CmdError::other)?;
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(CmdError::other)
}

#[tauri::command]
fn reveal(app: AppHandle, path: PathBuf) -> CmdResult<()> {
    app.opener().reveal_item_in_dir(path).map_err(CmdError::other)
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn pick_files(app: AppHandle) -> CmdResult<Vec<PathBuf>> {
    app.state::<android::Android>().pick_files().await.map_err(|e| CmdError::new("pick_failed", e))
}

#[cfg(desktop)]
#[tauri::command]
async fn pick_files(app: AppHandle) -> CmdResult<Vec<PathBuf>> {
    let (tx, rx) = oneshot::channel();
    app.dialog().file().pick_files(move |files| {
        let _ = tx.send(files);
    });
    let files = rx.await.map_err(CmdError::other)?.unwrap_or_default();
    Ok(files.into_iter().filter_map(|f| f.into_path().ok()).collect())
}

#[cfg(mobile)]
#[tauri::command]
async fn pick_folder(_app: AppHandle) -> CmdResult<Option<PathBuf>> {
    Err(CmdError::new("mobile_files_only", ""))
}

#[cfg(desktop)]
#[tauri::command]
async fn pick_folder(app: AppHandle) -> CmdResult<Option<PathBuf>> {
    let (tx, rx) = oneshot::channel();
    app.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder);
    });
    let folder = rx.await.map_err(CmdError::other)?;
    Ok(folder.and_then(|f| f.into_path().ok()))
}

#[tauri::command]
async fn send(state: State<'_, AppState>, target: String, paths: Vec<PathBuf>) -> CmdResult<TransferId> {
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
async fn send_text(state: State<'_, AppState>, target: String, text: String) -> CmdResult<()> {
    let target = state.parse_target(&target)?;
    let local = state.local.lock().unwrap().clone();
    pasalo_core::send_text(&target, &local, &text).await.map_err(CmdError::core)
}

/// Comprueba que se llega a un equipo (por IP o por código) y devuelve cómo se llama.
#[tauri::command]
async fn probe(state: State<'_, AppState>, target: String) -> CmdResult<Greeting> {
    let target = state.parse_target(&target)?;
    let local = state.local.lock().unwrap().clone();
    pasalo_core::probe(&target, &local).await.map_err(|e| CmdError::new("connect_failed", e.detail()))
}

/// Acepta o rechaza un envío que pide permiso.
#[tauri::command]
fn transfer_decide(state: State<'_, AppState>, id: TransferId, accept: bool) -> bool {
    state.receiver.decide(id, accept)
}

#[tauri::command]
async fn set_server(state: State<'_, AppState>, server: String) -> CmdResult<()> {
    let server = server.trim().trim_end_matches('/').to_string();
    if !server.starts_with("https://") && !server.starts_with("http://") {
        return Err(CmdError::new("invalid_server", server));
    }
    state.settings.lock().unwrap().server = server;
    state.save_settings()
}

/// Sale a internet y entra en el server. Hasta aquí la app no intenta nada fuera de la LAN.
#[tauri::command]
async fn net_connect(state: State<'_, AppState>) -> CmdResult<()> {
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
async fn net_disconnect(state: State<'_, AppState>) -> CmdResult<()> {
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
async fn lobby_request(state: State<'_, AppState>, to: LobbyUser) -> CmdResult<String> {
    lobby(&state).await?.request(&to).await.map_err(CmdError::core)
}

#[tauri::command]
async fn lobby_cancel(state: State<'_, AppState>, request: String) -> CmdResult<()> {
    lobby(&state).await?.cancel(&request).await.map_err(CmdError::core)
}

/// Contesta una solicitud. Al aceptar llega también `Event::LobbyPaired`.
#[tauri::command]
async fn lobby_answer(state: State<'_, AppState>, request: String, accept: bool) -> CmdResult<Option<Partner>> {
    lobby(&state).await?.answer(&request, accept).await.map_err(CmdError::core)
}

#[tauri::command]
async fn pause(state: State<'_, AppState>, id: TransferId) -> CmdResult<()> {
    if let Some(task) = state.outgoing.lock().unwrap().get_mut(&id).and_then(|job| job.task.take()) {
        task.abort();
    }
    Ok(())
}

#[tauri::command]
async fn resume(state: State<'_, AppState>, id: TransferId) -> CmdResult<()> {
    state.spawn_send(id);
    Ok(())
}

#[tauri::command]
async fn forget(state: State<'_, AppState>, id: TransferId) -> CmdResult<()> {
    if let Some(task) = state.outgoing.lock().unwrap().remove(&id).and_then(|job| job.task) {
        task.abort();
    }
    Ok(())
}

fn local_ips() -> Vec<String> {
    let mut ips: Vec<String> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|iface| !iface.is_loopback())
        .filter_map(|iface| match iface.addr {
            if_addrs::IfAddr::V4(v4) => Some(v4.ip.to_string()),
            _ => None,
        })
        .collect();
    ips.sort();
    ips.dedup();
    ips
}

fn load_settings(path: &Path, app: &AppHandle) -> Settings {
    if let Some(mut settings) = std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok()) {
        // Guardado cuando no había server por defecto.
        if settings.server.is_empty() {
            settings.server = default_server();
        }
        return settings;
    }
    let server = default_server();
    let downloads = app.path().download_dir().or_else(|_| app.path().home_dir()).unwrap_or_default();
    let dir = downloads.join("Pasalo");
    #[cfg(target_os = "android")]
    let (name, dir) = {
        // `download_dir()` da la carpeta privada de la app, que el usuario no ve.
        let public = PathBuf::from("/storage/emulated/0/Download/Pasalo");
        (android::device_name(), android::receive_dir(public, dir))
    };
    #[cfg(not(target_os = "android"))]
    let name = pasalo_core::default_device_name();
    Settings { name, dir, server }
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let config_dir = app.path().app_config_dir()?;
    std::fs::create_dir_all(&config_dir)?;
    let device_id = pasalo_core::load_or_create_device_id(&config_dir.join("device_id"))?;
    let settings_path = config_dir.join("settings.json");
    let settings = load_settings(&settings_path, &handle);

    let chat_dir = app.path().app_data_dir()?.join("chat");
    let (events, mut rx) = mpsc::unbounded_channel::<Event>();

    let state = tauri::async_runtime::block_on(async {
        // Si el puerto está ocupado (otra instancia, el CLI…), cualquiera libre:
        // el descubrimiento anuncia el que toque.
        let listener = match Receiver::bind(TRANSFER_PORT).await {
            Ok(listener) => listener,
            Err(_) => Receiver::bind(0).await?,
        };
        let mut local = LocalInfo::new(device_id, settings.name.clone());
        local.transfer_port = listener.local_addr()?.port();

        // Offline primero: iroh solo habla con la LAN hasta que el usuario se conecte.
        let remote = Remote::start(Some(&config_dir.join("remote_key")), false)
            .await
            .inspect_err(|e| eprintln!("no se pudieron iniciar las conexiones remotas: {e}"))
            .ok();
        if let Some(remote) = &remote {
            local.code = Some(remote.code());
            local.remote_port = remote.port();
        }
        let talk = remote.clone().map(|r| Talk::new(r, settings.name.clone(), &chat_dir, events.clone()));

        let receiver = Receiver::new(&settings.dir, local.clone(), events.clone());
        let running = receiver.clone();
        tokio::spawn(async move { running.run(listener).await });
        if let Some(remote) = remote.clone() {
            let (running, talk) = (receiver.clone(), talk.clone());
            tokio::spawn(async move { running.run_remote(remote, talk).await });
        }

        let state = AppState {
            settings_path,
            settings: Mutex::new(settings),
            local: Mutex::new(local),
            receiver,
            discovery: tokio::sync::Mutex::new(None),
            remote,
            talk,
            lobby: Default::default(),
            partner: Default::default(),
            chat_dir,
            voice: Mutex::new(None),
            events,
            outgoing: Mutex::default(),
        };
        state.restart_discovery().await;
        Ok::<_, std::io::Error>(state)
    })?;

    // Los eventos esperan en el canal hasta aquí, así que no se pierde ninguno.
    let (emitter, talk) = (handle.clone(), state.talk.clone());
    app.manage(state);
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            // Un equipo de la LAN con chat: se le puede hablar directo y sin internet.
            if let (Event::PeerFound(peer), Some(talk)) = (&event, &talk)
                && let (Some(code), Some(addr)) = (&peer.code, peer.remote_addr)
            {
                talk.set_lan_addr(code, addr);
            }
            let state = emitter.state::<AppState>();
            match &event {
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
            let _ = emitter.emit("pasalo", &event);
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(target_os = "android")]
    let builder = builder.plugin(android::init());
    builder
        .setup(setup)
        .invoke_handler(tauri::generate_handler![
            snapshot, refresh, set_name, choose_dir, open_dir, reveal, pick_files, pick_folder, send,
            send_text, probe, pause, resume, forget, transfer_decide, set_server, net_connect, net_disconnect,
            lobby_request, lobby_cancel, lobby_answer,
            talk::chat_history, talk::chat_send, talk::chat_send_image, talk::chat_image, talk::call_signal,
            talk::voice_start, talk::voice_mode, talk::voice_mute, talk::voice_speaker, talk::voice_stop,
            talk::voice_stats
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar Pasalo");
}
