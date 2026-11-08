//! App de Pasalo (Tauri). La interfaz está en `ui/`; aquí, los comandos que
//! usa, repartidos por tema, y el arranque.

#[cfg(target_os = "android")]
mod android;
mod call;
mod chat;
mod error;
mod files;
mod links;
mod net;
mod settings;
mod state;
mod stats;

use std::sync::Mutex;

use pasalo_core::protocol::TRANSFER_PORT;
use pasalo_core::{Event, LocalInfo, Receiver, Remote, Talk};
use tauri::{Emitter, Manager};
use tokio::sync::mpsc;

use crate::settings::load_settings;
use crate::state::AppState;

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
            call_stats: pasalo_core::CallStats::new(config_dir.join("call_stats.jsonl")),
            chat_dir,
            voice: Mutex::new(None),
            video: Mutex::new(None),
            events,
            outgoing: Mutex::default(),
        };
        state.restart_discovery().await;
        Ok::<_, std::io::Error>(state)
    })?;

    crate::links::init(app);

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
            crate::net::on_event(&emitter, &event).await;
            let _ = emitter.emit("pasalo", &event);
        }
    });
    Ok(())
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Para diagnosticar: con `RUST_LOG=pasalo_core=debug` el núcleo cuenta
    // por la salida de errores qué pasa con las conexiones.
    if std::env::var_os("RUST_LOG").is_some() {
        let _ = tracing_subscriber::fmt()
            .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
            .with_writer(std::io::stderr)
            .try_init();
    }
    let builder = tauri::Builder::default();
    // En Windows y Linux abrir un enlace lanza otra instancia: se le pasa a la
    // que ya está abierta y esa se cierra. Tiene que ir antes que deep-link.
    #[cfg(any(windows, target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_focus();
        }
    }));
    let builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .manage(links::Pending::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(target_os = "android")]
    let builder = builder.plugin(android::init());
    builder
        .setup(setup)
        .invoke_handler(tauri::generate_handler![
            settings::snapshot, settings::refresh, settings::set_name, settings::choose_dir, settings::open_dir,
            settings::reveal, settings::set_server, settings::local_network, settings::check_update,
            settings::open_release, settings::keep_alive, settings::local_addresses,
            files::pick_files, files::pick_folder, files::share_take, files::send, files::send_text, files::probe, files::pause,
            files::resume, files::forget, files::transfer_decide, files::cancel_incoming,
            net::net_connect, net::net_direct, net::net_disconnect,
            links::link_take, links::link_parse, links::link_mine, net::lobby_request, net::lobby_users, net::lobby_cancel, net::lobby_answer,
            chat::chat_history, chat::chat_send, chat::chat_send_image, chat::chat_image, chat::chat_send_audio,
            chat::chat_send_once, chat::chat_once_open, chat::secure_view, chat::chat_private,
            chat::chat_set_private, chat::chat_wipe,
            stats::call_record, stats::stats_pending, stats::stats_upload,
            call::call_signal, call::voice_start, call::voice_mode, call::voice_mute, call::voice_speaker,
            call::voice_stop, call::voice_stats, call::video_start, call::video_recv, call::video_send, call::video_stop
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar Pasalo");
}
