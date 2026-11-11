//! Ajustes guardados (nombre, carpeta, server) y lo que la interfaz necesita
//! saber de este equipo.

use std::path::{Path, PathBuf};

use pasalo_core::{Partner, Peer, Remote};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::error::{CmdError, CmdResult};
use crate::state::AppState;

/// Server de conexión por defecto (ver `server/README.md`). Se puede cambiar
/// en Ajustes.
const DEFAULT_SERVER: &str = "https://pasalo-server.vercel.app";

#[derive(Clone, Serialize, Deserialize)]
pub struct Settings {
    pub name: String,
    pub dir: PathBuf,
    #[serde(default = "default_server")]
    pub server: String,
    /// Chat with several people at once from the server (off: one partner, as before).
    #[serde(default)]
    pub multi_chat: bool,
}

fn default_server() -> String {
    DEFAULT_SERVER.to_string()
}

#[derive(Serialize)]
pub struct Snapshot {
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
    /// En internet sin server: alcanzable por su enlace.
    direct: bool,
    partner: Option<Partner>,
    /// With `multi_chat`: everyone accepted from the server so far.
    partners: Vec<Partner>,
    multi_chat: bool,
    /// Versión instalada.
    version: &'static str,
}

/// En Android, mantiene viva la app mientras está en línea o en una llamada
/// (`media`: 0 sin llamada, 1 de voz, 2 de vídeo). En escritorio no hace nada.
// Asíncrono: la llamada a Kotlin espera al hilo principal.
#[tauri::command]
pub async fn keep_alive(app: tauri::AppHandle, on: bool, media: u8) {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        app.state::<crate::android::Android>().keep_alive(on, media);
    }
    let _ = (app, on, media);
}

#[tauri::command]
pub async fn snapshot(state: State<'_, AppState>) -> CmdResult<Snapshot> {
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
    let partners = state.partners.lock().unwrap().clone();
    let internet = match &state.remote {
        Some(remote) => remote.internet().await,
        None => false,
    };
    let direct = internet && !online && partner.is_none();
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
        direct,
        partner,
        partners,
        multi_chat: settings.multi_chat,
        version: env!("CARGO_PKG_VERSION"),
    })
}

#[tauri::command]
pub async fn refresh(state: State<'_, AppState>) -> CmdResult<()> {
    if let Some(discovery) = &*state.discovery.lock().await {
        discovery.announce().await;
    }
    Ok(())
}

/// Las IP de este equipo ahora (cambian al pasar de Wi-Fi a datos, etc.).
#[tauri::command]
pub fn local_addresses() -> Vec<String> {
    local_ips()
}

#[tauri::command]
pub async fn set_name(state: State<'_, AppState>, name: String) -> CmdResult<()> {
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
pub async fn choose_dir(app: AppHandle, state: State<'_, AppState>) -> CmdResult<Option<PathBuf>> {
    let Some(dir) = crate::files::pick_folder(app).await? else { return Ok(None) };
    state.settings.lock().unwrap().dir = dir.clone();
    state.save_settings()?;
    state.receiver.set_dest(&dir);
    Ok(Some(dir))
}

// Async: en Android hablan con Kotlin, y un comando síncrono corre en el hilo
// principal, el mismo que tendría que contestar.
#[tauri::command]
pub async fn open_dir(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let dir = state.receiver.dest();
    std::fs::create_dir_all(&dir).map_err(CmdError::other)?;
    #[cfg(target_os = "android")]
    {
        open_folder(&app, &dir).await
    }
    #[cfg(not(target_os = "android"))]
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(CmdError::other)
}

#[cfg(target_os = "android")]
async fn open_folder(app: &AppHandle, dir: &Path) -> CmdResult<()> {
    match app.state::<crate::android::Android>().open_folder(dir).await {
        Ok(true) => Ok(()),
        Ok(false) => Err(CmdError::new("no_files_app", dir.display().to_string())),
        Err(e) => Err(CmdError::new("open_failed", e)),
    }
}

/// Enseña dónde quedó lo recibido: en el escritorio, el archivo marcado en su
/// carpeta; en Android, su carpeta en la app de archivos.
#[tauri::command]
pub async fn reveal(app: AppHandle, path: PathBuf) -> CmdResult<()> {
    #[cfg(target_os = "android")]
    {
        let dir = if path.is_dir() { path.as_path() } else { path.parent().unwrap_or(&path) };
        open_folder(&app, dir).await
    }
    #[cfg(not(target_os = "android"))]
    app.opener().reveal_item_in_dir(path).map_err(CmdError::other)
}

#[tauri::command]
pub async fn set_server(state: State<'_, AppState>, server: String) -> CmdResult<()> {
    let server = server.trim().trim_end_matches('/').to_string();
    if !server.starts_with("https://") && !server.starts_with("http://") {
        return Err(CmdError::new("invalid_server", server));
    }
    state.settings.lock().unwrap().server = server;
    state.save_settings()
}

/// The "chat with several people" setting. It applies the next time the app joins the server.
#[tauri::command]
pub async fn set_multi_chat(state: State<'_, AppState>, on: bool) -> CmdResult<()> {
    state.settings.lock().unwrap().multi_chat = on;
    state.save_settings()
}

/// Busca en GitHub si hay una versión más nueva que la instalada.
#[tauri::command]
pub async fn check_update(state: State<'_, AppState>) -> CmdResult<pasalo_core::update::Release> {
    let remote = state.remote.as_ref().ok_or_else(|| CmdError::new("remote_unavailable", ""))?;
    pasalo_core::update::latest_release(remote, env!("CARGO_PKG_VERSION"), is_our_asset)
        .await
        .map_err(|e| CmdError::new("update_failed", e.detail()))
}

/// El archivo de la release que le sirve a este equipo.
fn is_our_asset(name: &str) -> bool {
    if cfg!(target_os = "android") {
        name.ends_with(if cfg!(target_arch = "aarch64") { "arm64-v8a.apk" } else { "armeabi-v7a.apk" })
    } else if cfg!(target_os = "macos") {
        name.ends_with(".dmg")
    } else if cfg!(target_os = "windows") {
        name.ends_with("-setup.exe") || name.ends_with(".msi")
    } else {
        name.ends_with(".AppImage")
    }
}

/// Abre en el navegador una página o descarga de las releases (solo esas).
#[tauri::command]
pub fn open_release(app: AppHandle, url: String) -> CmdResult<()> {
    let ours = format!("https://github.com/{}/releases/", pasalo_core::update::REPO);
    if !url.starts_with(&ours) {
        return Err(CmdError::other("enlace no válido"));
    }
    app.opener().open_url(url, None::<&str>).map_err(CmdError::other)
}

/// Android: whether received files go to the public `Download/Pasalo`. If
/// they don't yet and it can be written now (the storage permission was just
/// granted), it switches to it. `None` outside Android.
#[tauri::command]
pub fn storage_public(state: State<'_, AppState>) -> CmdResult<Option<bool>> {
    #[cfg(target_os = "android")]
    {
        let public = PathBuf::from(crate::android::PUBLIC_DIR);
        let current = state.settings.lock().unwrap().dir.clone();
        let dir = crate::android::receive_dir(public.clone(), current.clone());
        if dir != current {
            state.settings.lock().unwrap().dir = dir.clone();
            state.receiver.set_dest(dir.clone());
            state.save_settings()?;
        }
        return Ok(Some(dir == public));
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = state;
        Ok(None)
    }
}

/// Permiso de red local de Android 17+ (`None` donde no hace falta). Con
/// `ask`, lo pide.
#[tauri::command]
pub fn local_network(app: AppHandle, ask: bool) -> Option<bool> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        return Some(app.state::<crate::android::Android>().local_network(ask));
    }
    #[allow(unreachable_code)]
    {
        let _ = (app, ask);
        None
    }
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

pub fn load_settings(path: &Path, app: &AppHandle) -> Settings {
    if let Some(mut settings) = std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok()) {
        // Guardado cuando no había server por defecto.
        if settings.server.is_empty() {
            settings.server = default_server();
        }
        // Received files always go to the public Downloads folder when it can
        // be written: checked on every start, not only the first one.
        #[cfg(target_os = "android")]
        {
            settings.dir = crate::android::receive_dir(PathBuf::from(crate::android::PUBLIC_DIR), settings.dir);
        }
        return settings;
    }
    let server = default_server();
    let downloads = app.path().download_dir().or_else(|_| app.path().home_dir()).unwrap_or_default();
    let dir = downloads.join("Pasalo");
    #[cfg(target_os = "android")]
    let (name, dir) = {
        // `download_dir()` da la carpeta privada de la app, que el usuario no ve.
        let public = PathBuf::from(crate::android::PUBLIC_DIR);
        (crate::android::device_name(), crate::android::receive_dir(public, dir))
    };
    #[cfg(not(target_os = "android"))]
    let name = pasalo_core::default_device_name();
    Settings { name, dir, server, multi_chat: false }
}
