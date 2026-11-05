//! Lo que en Android hay que hacer desde Kotlin (`PasaloPlugin.kt`): tener
//! el `MulticastLock` para recibir los anuncios de la LAN y elegir archivos,
//! que llegan como `content://` y se copian a la caché para enviarlos.

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

impl Android {
    pub async fn pick_files(&self) -> Result<Vec<PathBuf>, String> {
        let picked: Picked = self.0.run_mobile_plugin_async("pickFiles", ()).await.map_err(|e| e.to_string())?;
        Ok(picked.paths)
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
