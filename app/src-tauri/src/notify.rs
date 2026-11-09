//! Notificaciones de los mensajes y las llamadas que llegan con la app en
//! segundo plano (las pide `notify.js`). En Android, con las de llamada del
//! sistema (`Notifications.kt`); en escritorio, las del sistema, y en una
//! llamada además la ventana sale de la bandeja y pide atención.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
#[cfg(target_os = "android")]
use tauri::Manager;

use crate::error::CmdResult;

/// Lo que se tocó en una notificación antes de que la página estuviera lista.
#[derive(Default, Serialize, Deserialize)]
pub struct Tapped {
    #[serde(default)]
    action: Option<String>,
    #[serde(default)]
    peer: Option<String>,
    #[serde(default)]
    call: Option<String>,
}

#[tauri::command]
pub async fn notify_message(app: AppHandle, peer: String, name: String, text: String) -> CmdResult<()> {
    #[cfg(target_os = "android")]
    {
        #[derive(Serialize)]
        struct Args {
            peer: String,
            name: String,
            text: String,
        }
        let android = app.state::<crate::android::Android>();
        android.plugin("notifyMessage", Args { peer, name, text }).await;
    }
    #[cfg(desktop)]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title(&name).body(&text).extra("action", "open").extra("peer", &peer).show();
    }
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn notify_call(
    app: AppHandle,
    call: String,
    peer: String,
    name: String,
    video: bool,
    title: String,
    answer: String,
    decline: String,
) -> CmdResult<()> {
    #[cfg(target_os = "android")]
    {
        #[derive(Serialize)]
        struct Args {
            call: String,
            peer: String,
            name: String,
            video: bool,
            title: String,
        }
        let _ = (answer, decline);
        let android = app.state::<crate::android::Android>();
        android.plugin("notifyCall", Args { call, peer, name, video, title }).await;
    }
    #[cfg(desktop)]
    {
        use tauri_plugin_notification::{Action, ActionType, NotificationExt};
        let _ = (peer, video);
        let notification = app.notification();
        // Los botones van en el idioma de la interfaz: se registran cada vez.
        let buttons = vec![Action::builder("answer", answer).build(), Action::builder("decline", decline).build()];
        let _ = notification.register_action_types(vec![ActionType::builder("call").actions(buttons).build()]);
        let _ = notification.builder().title(&name).body(&title).action_type_id("call").extra("action", "focus").extra("call", &call).show();
        // La pantalla de la llamada (con contestar y colgar) está en la ventana.
        crate::tray::show_window(&app);
        if let Some(window) = tauri::Manager::get_webview_window(&app, "main") {
            let _ = window.request_user_attention(Some(tauri::UserAttentionType::Critical));
        }
    }
    Ok(())
}

/// Quita la de la llamada `call` o las del chat con `peer`.
#[tauri::command]
pub async fn notify_clear(app: AppHandle, call: Option<String>, peer: Option<String>) -> CmdResult<()> {
    #[cfg(target_os = "android")]
    {
        #[derive(Serialize)]
        struct Args {
            call: Option<String>,
            peer: Option<String>,
        }
        let android = app.state::<crate::android::Android>();
        android.plugin("notifyClear", Args { call, peer }).await;
    }
    #[cfg(desktop)]
    {
        // Las del sistema se quedan en su centro de notificaciones.
        let _ = (app, call, peer);
    }
    Ok(())
}

/// Lo que se tocó en una notificación con la app cerrada (Android).
#[tauri::command]
pub async fn notify_take(app: AppHandle) -> CmdResult<Tapped> {
    #[cfg(target_os = "android")]
    return Ok(app.state::<crate::android::Android>().take_notification().await);
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(Tapped::default())
    }
}

/// Escritorio: tocar la notificación o uno de sus botones (contestar,
/// rechazar) se lo pasa a la página, como en Android.
#[cfg(desktop)]
pub fn init(app: &AppHandle) {
    use tauri::{Emitter, Manager};
    use tauri_plugin_notification::NotificationExt;
    let handle = app.clone();
    let _ = app.notification().on_action(move |performed| {
        let extra = performed.notification().map(|n| n.extra().clone()).unwrap_or_default();
        let text = |key: &str| extra.get(key).and_then(|v| v.as_str()).map(str::to_string);
        let action = match performed.action_id() {
            "answer" | "decline" => performed.action_id().to_string(),
            _ => text("action").unwrap_or_else(|| "focus".into()),
        };
        if action != "decline" {
            crate::tray::show_window(&handle);
        }
        let tapped = Tapped { action: Some(action), peer: text("peer"), call: text("call") };
        if let Some(window) = handle.get_webview_window("main") {
            let _ = window.emit("pasalo_notification", &tapped);
        }
    });
}

// ---------- permisos (la sección de Ajustes, ver permissions.js) ----------

#[derive(Serialize, Deserialize)]
pub struct Permission {
    id: String,
    /// `granted`, `ask` (se puede pedir) o `denied` (solo desde los ajustes del sistema).
    state: String,
}

/// Los permisos que se gestionan aquí. En escritorio y en la web, el
/// micrófono y la cámara los lleva la propia página (ver permissions.js).
#[tauri::command]
pub async fn permissions(app: AppHandle) -> CmdResult<Vec<Permission>> {
    #[cfg(target_os = "android")]
    {
        #[derive(Deserialize)]
        struct List {
            list: Vec<Permission>,
        }
        let android = app.state::<crate::android::Android>();
        return Ok(android.call::<List>("permissions", ()).await.map(|l| l.list).unwrap_or_default());
    }
    #[cfg(desktop)]
    {
        // Las apps de escritorio no piden permiso: se quitan desde los ajustes del sistema.
        let _ = app;
        Ok(vec![Permission { id: "notifications".into(), state: "granted".into() }])
    }
}

/// Lo pide (Android) o abre los ajustes del sistema donde se concede.
#[tauri::command]
pub async fn permission_request(app: AppHandle, id: String) -> CmdResult<()> {
    #[cfg(target_os = "android")]
    {
        #[derive(Serialize)]
        struct Args {
            id: String,
        }
        app.state::<crate::android::Android>().plugin("requestPermission", Args { id }).await;
    }
    #[cfg(desktop)]
    {
        use tauri_plugin_opener::OpenerExt;
        let url = match (std::env::consts::OS, id.as_str()) {
            ("macos", "notifications") => "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
            ("macos", "microphone") => "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
            ("macos", "camera") => "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
            ("windows", "notifications") => "ms-settings:notifications",
            ("windows", "microphone") => "ms-settings:privacy-microphone",
            ("windows", "camera") => "ms-settings:privacy-webcam",
            _ => return Ok(()),
        };
        let _ = app.opener().open_url(url, None::<&str>);
    }
    Ok(())
}
