//! Enlaces para añadir un equipo sin pasar por el server:
//! `https://pasalo-server.vercel.app/?c=<código>&n=<nombre>`. En Android los
//! abre la app directamente (App Link); en el resto, la página de ese enlace
//! abre `pasalo://add?c=…&n=…`. El server no interviene en la conexión: el
//! código ya basta para llegar por los relays de iroh.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{App, AppHandle, Emitter, Manager, State, Url};
use tauri_plugin_deep_link::DeepLinkExt;

use crate::error::{CmdError, CmdResult};
use crate::state::AppState;

/// Dominio de los enlaces (el mismo que declara la app en Android).
const HOST: &str = "pasalo-server.vercel.app";
/// Largo máximo del nombre que viene en un enlace.
const NAME_MAX: usize = 64;

#[derive(Clone, Serialize)]
pub struct Link {
    code: String,
    name: String,
}

/// El último enlace abierto que la interfaz todavía no ha recogido (puede
/// llegar antes de que cargue, al abrir la app con él).
#[derive(Default)]
pub struct Pending(Mutex<Option<Link>>);

/// Un enlace nuestro con un código válido.
pub fn parse(url: &Url) -> Option<Link> {
    let ours = match url.scheme() {
        "pasalo" => true,
        "https" | "http" => url.host_str() == Some(HOST),
        _ => false,
    };
    if !ours {
        return None;
    }
    let (mut code, mut name) = (None, String::new());
    for (key, value) in url.query_pairs() {
        match &*key {
            "c" => code = Some(value.trim().to_string()),
            "n" => name = value.trim().chars().take(NAME_MAX).collect(),
            _ => {}
        }
    }
    let code = code?;
    pasalo_core::parse_code(&code)?;
    Some(Link { code, name })
}

/// Escucha los enlaces con que se abre la app, también el del arranque.
pub fn init(app: &App) {
    let handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            opened(&handle, &url);
        }
    });
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            opened(app.handle(), &url);
        }
    }
    // En Windows y Linux el esquema se registra al ejecutar (sin instalador, p. ej. en AppImage).
    #[cfg(any(windows, target_os = "linux"))]
    let _ = app.deep_link().register_all();
}

fn opened(app: &AppHandle, url: &Url) {
    let Some(link) = parse(url) else { return };
    *app.state::<Pending>().0.lock().unwrap() = Some(link);
    let _ = app.emit("pasalo_link", ());
}

/// El enlace pendiente, si lo hay. Se recoge una sola vez.
#[tauri::command]
pub fn link_take(pending: State<'_, Pending>) -> Option<Link> {
    pending.0.lock().unwrap().take()
}

/// Un enlace pegado a mano (o de otra forma) en vez de abierto.
#[tauri::command]
pub fn link_parse(text: String) -> Option<Link> {
    Url::parse(text.trim()).ok().as_ref().and_then(parse)
}

/// El enlace de este equipo, para compartirlo.
#[tauri::command]
pub fn link_mine(state: State<'_, AppState>) -> CmdResult<String> {
    let remote = state.remote.as_ref().ok_or_else(|| CmdError::new("remote_unavailable", ""))?;
    let name = state.settings.lock().unwrap().name.clone();
    let mut url = Url::parse(&format!("https://{HOST}/")).map_err(CmdError::other)?;
    url.query_pairs_mut().append_pair("c", &remote.code()).append_pair("n", &name);
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Clave pública del primer ejemplo de la RFC 8032, en hex.
    const CODE: &str = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

    #[test]
    fn parses_our_links_only() {
        let web = parse(&Url::parse(&format!("https://{HOST}/?c={CODE}&n=Ana%20M")).unwrap()).unwrap();
        assert_eq!((web.code.as_str(), web.name.as_str()), (CODE, "Ana M"));
        assert!(parse(&Url::parse(&format!("pasalo://add?c={CODE}")).unwrap()).is_some());
        assert!(parse(&Url::parse(&format!("https://evil.example/?c={CODE}")).unwrap()).is_none());
        assert!(parse(&Url::parse(&format!("https://{HOST}/?c=nope")).unwrap()).is_none());
    }
}
