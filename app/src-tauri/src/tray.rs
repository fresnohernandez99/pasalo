//! Icono en la bandeja del sistema (escritorio): cerrar o minimizar la ventana
//! la esconde ahí y Pasalo sigue recibiendo archivos, mensajes y llamadas.
//! Desde el icono se vuelve a abrir o se sale de verdad.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Window, WindowEvent, Wry};

/// Las entradas del menú, para traducirlas cuando cambia el idioma. Solo
/// existe si el icono se pudo crear (en Linux hace falta appindicator).
pub struct Tray {
    show: MenuItem<Wry>,
    quit: MenuItem<Wry>,
}

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Abrir Pasalo", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Pasalo")
        .menu(&menu)
        // En macOS el icono de la barra de menús abre el menú; en Windows el
        // clic izquierdo abre la ventana y el derecho, el menú.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    app.manage(Tray { show, quit });
    Ok(())
}

/// Saca la ventana de la bandeja (o del Dock) al frente.
pub fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Cerrar o minimizar la ventana la esconde en la bandeja, si hay icono; sin
/// él no habría forma de volver a ella, y se cierra o minimiza como siempre.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.app_handle().try_state::<Tray>().is_none() {
        return;
    }
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = window.hide();
        }
        // En macOS minimizar va al Dock, como en cualquier app.
        #[cfg(not(target_os = "macos"))]
        WindowEvent::Resized(_) if window.is_minimized().unwrap_or(false) => {
            let _ = window.hide();
        }
        _ => {}
    }
}

/// Los textos del menú en el idioma de la interfaz.
#[tauri::command]
pub fn tray_labels(app: AppHandle, show: String, quit: String) {
    if let Some(tray) = app.try_state::<Tray>() {
        let _ = tray.show.set_text(show);
        let _ = tray.quit.set_text(quit);
    }
}
