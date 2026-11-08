//! Lo que en Android hay que hacer desde Kotlin (`PasaloPlugin.kt`): tener
//! el `MulticastLock` para recibir los anuncios de la LAN y elegir archivos,
//! que llegan como `content://` y se copian a la caché para enviarlos; y el
//! micrófono y el modo de llamada para la voz.

use std::path::PathBuf;

use serde::Deserialize;
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{Manager, Wry};

pub struct Android(PluginHandle<Wry>);

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("pasalo")
        .setup(|app, api| {
            let handle = api.register_android_plugin("com.neomambi.pasalo", "PasaloPlugin")?;
            app.manage(Android(handle));
            Ok(())
        })
        .build()
}

#[derive(Deserialize)]
struct Picked {
    paths: Vec<PathBuf>,
}

#[derive(Deserialize)]
struct Granted {
    granted: bool,
}

#[derive(serde::Serialize)]
struct CallAudio {
    on: bool,
    speaker: bool,
}

impl Android {
    /// Pide el permiso del micrófono (si hace falta) y dice si está concedido.
    pub async fn request_audio(&self) -> bool {
        self.0.run_mobile_plugin_async::<Granted>("requestAudio", ()).await.is_ok_and(|g| g.granted)
    }

    /// Modo de llamada de Android: suena por el auricular (o el altavoz) y el
    /// sistema aplica su cancelación de eco.
    /// Sin capturas de pantalla mientras `on` (ver `secure` en PasaloPlugin.kt).
    pub async fn secure(&self, on: bool) {
        #[derive(serde::Serialize)]
        struct Args {
            on: bool,
        }
        let _ = self.0.run_mobile_plugin_async::<serde_json::Value>("secure", Args { on }).await;
    }

    pub fn call_audio(&self, on: bool, speaker: bool) {
        let _ = self.0.run_mobile_plugin::<serde_json::Value>("callAudio", CallAudio { on, speaker });
    }

    /// Servicio en primer plano (con su notificación) para que Android no
    /// mate el proceso: `media` 0 sin llamada, 1 de voz, 2 de vídeo.
    pub fn keep_alive(&self, on: bool, media: u8) {
        #[derive(serde::Serialize)]
        struct Args {
            on: bool,
            media: u8,
        }
        let _ = self.0.run_mobile_plugin::<serde_json::Value>("keepAlive", Args { on, media });
    }

    /// Si hay permiso para la red local (Android 17+); con `ask`, lo pide o
    /// abre los ajustes de la app si ya se negó para siempre.
    pub fn local_network(&self, ask: bool) -> bool {
        #[derive(serde::Serialize)]
        struct Args {
            ask: bool,
        }
        self.0.run_mobile_plugin::<Granted>("localNetwork", Args { ask }).is_ok_and(|g| g.granted)
    }

    /// Abre `dir` en la app de archivos; si no se puede, las descargas.
    pub async fn open_folder(&self, dir: &std::path::Path) -> Result<bool, String> {
        #[derive(serde::Serialize)]
        struct Args {
            path: String,
        }
        let args = Args { path: dir.to_string_lossy().into_owned() };
        let opened: Granted = self.0.run_mobile_plugin_async("openFolder", args).await.map_err(|e| e.to_string())?;
        Ok(opened.granted)
    }

    pub async fn pick_files(&self) -> Result<Vec<PathBuf>, String> {
        let picked: Picked = self.0.run_mobile_plugin_async("pickFiles", ()).await.map_err(|e| e.to_string())?;
        Ok(picked.paths)
    }

    /// Lo que llegó por «Compartir» desde otra app (ya copiado), si hay algo.
    pub async fn take_share(&self) -> Result<crate::files::Shared, String> {
        self.0.run_mobile_plugin_async("takeShare", ()).await.map_err(|e| e.to_string())
    }
}

/// El nombre del equipo en Android es siempre "localhost": mejor el modelo.
pub fn device_name() -> String {
    let prop = |name: &str| {
        let out = std::process::Command::new("getprop").arg(name).output().ok()?;
        let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!value.is_empty()).then_some(value)
    };
    match (prop("ro.product.manufacturer"), prop("ro.product.model")) {
        (Some(maker), Some(model)) if !model.to_lowercase().starts_with(&maker.to_lowercase()) => {
            format!("{maker} {model}")
        }
        (_, Some(model)) => model,
        _ => "Android".into(),
    }
}

/// La carpeta pública `Download/Pasalo` se puede escribir sin permisos desde
/// Android 10; en versiones anteriores se recibe en la carpeta de la app.
pub fn receive_dir(preferred: PathBuf, fallback: PathBuf) -> PathBuf {
    let probe = preferred.join(".pasalo-probe");
    let writable = std::fs::create_dir_all(&preferred).is_ok() && std::fs::write(&probe, b"").is_ok();
    let _ = std::fs::remove_file(&probe);
    if writable { preferred } else { fallback }
}
