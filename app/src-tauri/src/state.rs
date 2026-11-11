//! Estado de la app, compartido por todos los comandos.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Mutex;

use pasalo_core::protocol::{DISCOVERY_PORT, TRANSFER_PORT};
use pasalo_core::{CallStats, Discovery, EventSender, Lobby, LocalInfo, Partner, Receiver, Remote, SendOptions, Talk, Target, TransferId};
use tokio::task::JoinHandle;

use crate::error::{CmdError, CmdResult};
use crate::settings::Settings;
use crate::call;

/// Un envío que se puede pausar (abortando la tarea) y reanudar (volviendo a
/// enviar lo mismo con el mismo id).
pub struct Outgoing {
    pub target: Target,
    pub paths: Vec<PathBuf>,
    pub task: Option<JoinHandle<()>>,
}

pub struct AppState {
    pub settings_path: PathBuf,
    pub settings: Mutex<Settings>,
    pub local: Mutex<LocalInfo>,
    pub receiver: Receiver,
    pub discovery: tokio::sync::Mutex<Option<Discovery>>,
    /// iroh. Arranca en modo solo red local; pasa a internet al conectarse.
    /// `None` si no se pudo arrancar.
    pub remote: Option<Remote>,
    /// Chat y llamadas; existe si hay `remote`.
    pub talk: Option<Talk>,
    /// Sesión en el server mientras se está conectado y sin pareja.
    pub lobby: tokio::sync::Mutex<Option<Lobby>>,
    /// El otro equipo, tras aceptar una conexión.
    pub partner: Mutex<Option<Partner>>,
    /// With the "several people" setting: everyone accepted while staying on
    /// the server (`partner` stays empty then).
    pub partners: Mutex<Vec<Partner>>,
    /// La sesión del server mientras hay pareja: solo avisa de que se está
    /// ocupado, para los amigos.
    pub busy: Mutex<Option<Lobby>>,
    pub chat_dir: PathBuf,
    /// Llamadas terminadas, para subir sus estadísticas cuando el usuario lo pida.
    pub call_stats: CallStats,
    pub voice: Mutex<Option<call::VoiceCall>>,
    pub video: Mutex<Option<call::VideoCall>>,
    pub events: EventSender,
    pub outgoing: Mutex<HashMap<TransferId, Outgoing>>,
}

impl AppState {
    pub fn save_settings(&self) -> CmdResult<()> {
        let settings = self.settings.lock().unwrap().clone();
        let json = serde_json::to_vec_pretty(&settings).map_err(CmdError::other)?;
        std::fs::write(&self.settings_path, json).map_err(CmdError::other)
    }

    pub fn spawn_send(&self, id: TransferId) {
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
    pub fn parse_target(&self, target: &str) -> CmdResult<Target> {
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

    pub async fn restart_discovery(&self) {
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

impl AppState {
    pub fn talk(&self) -> CmdResult<&Talk> {
        self.talk.as_ref().ok_or_else(|| CmdError::new("remote_unavailable", ""))
    }
}
