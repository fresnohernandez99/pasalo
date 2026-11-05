#[cfg(target_os = "android")]
mod android;
mod talk;

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use pasalo_core::protocol::{DISCOVERY_PORT, TRANSFER_PORT};
use pasalo_core::{
    Discovery, Event, EventSender, Greeting, LocalInfo, Peer, Receiver, Remote, SendOptions, Talk, Target, TransferId,
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

#[derive(Clone, Serialize, Deserialize)]
struct Settings {
    name: String,
    dir: PathBuf,
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
    /// `None` si no se pudo arrancar (p. ej. sin red al abrir la app).
    remote: Option<Remote>,
    /// Chat y llamadas; existe si hay `remote`.
    talk: Option<Talk>,
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
    /// Código para que te envíen desde otras redes.
    code: Option<String>,
    /// En el móvil no hay carpetas que elegir ni arrastrar y soltar.
    mobile: bool,
    peers: Vec<Peer>,
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
    Ok(Snapshot { name: settings.name, dir: settings.dir, port, ips: local_ips(), code, mobile, peers })
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
    if let Some(settings) = std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()) {
        return settings;
    }
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
    Settings { name, dir }
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

        let remote = Remote::start(Some(&config_dir.join("remote_key")))
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
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            // Un equipo de la LAN con chat: se le puede hablar directo y sin internet.
            if let (Event::PeerFound(peer), Some(talk)) = (&event, &talk)
                && let (Some(code), Some(addr)) = (&peer.code, peer.remote_addr)
            {
                talk.set_lan_addr(code, addr);
            }
            let _ = emitter.emit("pasalo", &event);
        }
    });
    app.manage(state);
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
            send_text, probe, pause, resume, forget,
            talk::chat_history, talk::chat_send, talk::chat_send_image, talk::chat_image, talk::call_signal,
            talk::voice_start, talk::voice_mode, talk::voice_mute, talk::voice_speaker, talk::voice_stop,
            talk::voice_stats
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar Pasalo");
}
