#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use pasalo_core::protocol::{DISCOVERY_PORT, TRANSFER_PORT};
use pasalo_core::{Discovery, Event, EventSender, LocalInfo, Peer, Receiver, SendOptions, TransferId};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

type CmdResult<T> = Result<T, String>;

#[derive(Clone, Serialize, Deserialize)]
struct Settings {
    name: String,
    dir: PathBuf,
}

/// Un envío que se puede pausar (abortando la tarea) y reanudar (volviendo a
/// enviar lo mismo con el mismo id).
struct Outgoing {
    addr: SocketAddr,
    paths: Vec<PathBuf>,
    task: Option<JoinHandle<()>>,
}

struct AppState {
    settings_path: PathBuf,
    settings: Mutex<Settings>,
    local: Mutex<LocalInfo>,
    receiver: Receiver,
    discovery: tokio::sync::Mutex<Option<Discovery>>,
    events: EventSender,
    outgoing: Mutex<HashMap<TransferId, Outgoing>>,
}

impl AppState {
    fn save_settings(&self) -> CmdResult<()> {
        let settings = self.settings.lock().unwrap().clone();
        let json = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
        std::fs::write(&self.settings_path, json).map_err(|e| e.to_string())
    }

    fn spawn_send(&self, id: TransferId) {
        let mut outgoing = self.outgoing.lock().unwrap();
        let Some(job) = outgoing.get_mut(&id) else { return };
        if job.task.as_ref().is_some_and(|task| !task.is_finished()) {
            return;
        }
        let (addr, paths) = (job.addr, job.paths.clone());
        let local = self.local.lock().unwrap().clone();
        let events = self.events.clone();
        job.task = Some(tokio::spawn(async move {
            let opts = SendOptions::default();
            let _ = pasalo_core::send_paths(id, addr, &local, &paths, &opts, &events).await;
        }));
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
    Ok(Snapshot { name: settings.name, dir: settings.dir, port, ips: local_ips(), peers })
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
        return Err("El nombre no puede estar vacío".into());
    }
    state.settings.lock().unwrap().name = name.clone();
    state.save_settings()?;
    let local = {
        let mut local = state.local.lock().unwrap();
        local.name = name;
        local.clone()
    };
    state.receiver.set_local(local);
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
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal(app: AppHandle, path: PathBuf) -> CmdResult<()> {
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn pick_files(app: AppHandle) -> CmdResult<Vec<PathBuf>> {
    let (tx, rx) = oneshot::channel();
    app.dialog().file().pick_files(move |files| {
        let _ = tx.send(files);
    });
    let files = rx.await.map_err(|e| e.to_string())?.unwrap_or_default();
    Ok(files.into_iter().filter_map(|f| f.into_path().ok()).collect())
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> CmdResult<Option<PathBuf>> {
    let (tx, rx) = oneshot::channel();
    app.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder);
    });
    let folder = rx.await.map_err(|e| e.to_string())?;
    Ok(folder.and_then(|f| f.into_path().ok()))
}

#[tauri::command]
async fn send(state: State<'_, AppState>, target: String, paths: Vec<PathBuf>) -> CmdResult<TransferId> {
    if paths.is_empty() {
        return Err("No hay nada que enviar".into());
    }
    let addr = parse_target(&target)?;
    let id = pasalo_core::new_transfer_id();
    state.outgoing.lock().unwrap().insert(id, Outgoing { addr, paths, task: None });
    state.spawn_send(id);
    Ok(id)
}

#[tauri::command]
async fn send_text(state: State<'_, AppState>, target: String, text: String) -> CmdResult<()> {
    let addr = parse_target(&target)?;
    let local = state.local.lock().unwrap().clone();
    pasalo_core::send_text(addr, &local, &text).await.map_err(|e| e.to_string())
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

/// `IP:puerto` o solo `IP` (puerto por defecto).
fn parse_target(target: &str) -> CmdResult<SocketAddr> {
    let target = target.trim();
    if let Ok(addr) = target.parse::<SocketAddr>() {
        return Ok(addr);
    }
    target
        .parse::<IpAddr>()
        .map(|ip| SocketAddr::new(ip, TRANSFER_PORT))
        .map_err(|_| format!("\"{target}\" no es una dirección IP válida"))
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
    Settings { name: pasalo_core::default_device_name(), dir: downloads.join("Pasalo") }
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let config_dir = app.path().app_config_dir()?;
    std::fs::create_dir_all(&config_dir)?;
    let device_id = pasalo_core::load_or_create_device_id(&config_dir.join("device_id"))?;
    let settings_path = config_dir.join("settings.json");
    let settings = load_settings(&settings_path, &handle);

    let (events, mut rx) = mpsc::unbounded_channel::<Event>();
    let emitter = handle.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            let _ = emitter.emit("pasalo", &event);
        }
    });

    let state = tauri::async_runtime::block_on(async {
        // Si el puerto está ocupado (otra instancia, el CLI…), cualquiera libre:
        // el descubrimiento anuncia el que toque.
        let listener = match Receiver::bind(TRANSFER_PORT).await {
            Ok(listener) => listener,
            Err(_) => Receiver::bind(0).await?,
        };
        let mut local = LocalInfo::new(device_id, settings.name.clone());
        local.transfer_port = listener.local_addr()?.port();

        let receiver = Receiver::new(&settings.dir, local.clone(), events.clone());
        let running = receiver.clone();
        tokio::spawn(async move { running.run(listener).await });

        let state = AppState {
            settings_path,
            settings: Mutex::new(settings),
            local: Mutex::new(local),
            receiver,
            discovery: tokio::sync::Mutex::new(None),
            events,
            outgoing: Mutex::default(),
        };
        state.restart_discovery().await;
        Ok::<_, std::io::Error>(state)
    })?;
    app.manage(state);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(setup)
        .invoke_handler(tauri::generate_handler![
            snapshot, refresh, set_name, choose_dir, open_dir, reveal, pick_files, pick_folder, send,
            send_text, pause, resume, forget
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar Pasalo");
}
