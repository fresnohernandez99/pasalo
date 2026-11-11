//! Cliente del server de señalización (carpeta `server/`, para Vercel con
//! MongoDB). El server solo presenta a los equipos: lista quién está
//! conectado y lleva las solicitudes de conexión. Cuando una se acepta, cada
//! lado recibe el código de iroh del otro, los dos se van del server y desde
//! ahí hablan directamente por iroh.
//!
//! Nada se conecta solo: [`Lobby::join`] se llama cuando el usuario lo pide.
//! Mientras se está en el server, una petición larga (`sync`) espera hasta
//! 20 s a que cambie algo, así que estar conectado sin hacer nada cuesta una
//! petición pequeña cada 20 s.
//!
//! Emparejado, la sesión sigue en el server con un `ping` cada
//! [`PING_EVERY`] (sin recibir nada) para que los amigos lo vean ocupado,
//! hasta [`Lobby::leave`].
//!
//! With `multi` (the "chat with several people" setting) pairing doesn't end
//! the session: it keeps syncing, stays listed and can accept more requests,
//! each one a new [`Event::LobbyPaired`].

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{Error, Event, EventSender, Remote};

/// Lo que el server espera como mucho antes de contestar un `sync` sin novedades.
const SYNC_WAIT: Duration = Duration::from_secs(20);
/// Cada cuánto avisa una pareja de que sigue ocupada (el server la olvida a los 45 s).
const PING_EVERY: Duration = Duration::from_secs(25);

/// Un equipo conectado al server, tal como lo ven los demás.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LobbyUser {
    pub id: String,
    pub name: String,
    pub platform: String,
    /// Su código de iroh: solo viene en las solicitudes de un amigo.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

/// Un amigo que está en el server (ver [`Lobby::friends`]).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Friend {
    pub code: String,
    /// El id de su sesión de ahora, para pedirle conectarse.
    pub id: String,
    pub name: String,
    pub platform: String,
    /// Emparejado con otro: no se le puede pedir nada.
    pub busy: bool,
}

#[derive(Deserialize)]
struct Friends {
    friends: Vec<Friend>,
}

/// El otro equipo de una conexión aceptada.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Partner {
    pub id: String,
    pub name: String,
    pub platform: String,
    /// Su código de iroh.
    pub code: String,
}

/// Sesión en el server. Clonarla es barato.
#[derive(Clone)]
pub struct Lobby {
    inner: Arc<Inner>,
}

struct Inner {
    http: reqwest::Client,
    base: String,
    me: LobbyUser,
    code: String,
    token: String,
    events: EventSender,
    /// Solicitudes recibidas que esperan respuesta, por id.
    incoming: Mutex<HashMap<String, LobbyUser>>,
    /// Solicitudes enviadas sin respuesta, por id.
    outgoing: Mutex<HashMap<String, LobbyUser>>,
    left: AtomicBool,
    /// Emparejado: ya solo se hace `ping`.
    paired: AtomicBool,
    /// Several partners at once: pairing never stops the `sync` loop.
    multi: bool,
}

#[derive(Deserialize)]
struct SyncReply {
    v: String,
    /// Solo vienen si cambió algo desde `v`.
    users: Option<Vec<LobbyUser>>,
    requests: Option<Vec<IncomingRequest>>,
    answers: Option<Vec<Answer>>,
}

#[derive(Deserialize)]
struct IncomingRequest {
    id: String,
    from: LobbyUser,
}

#[derive(Deserialize)]
struct Answer {
    id: String,
    /// `accepted`, `declined`, `cancelled` o `expired`.
    state: String,
    #[serde(default)]
    code: Option<String>,
}

/// Una página de los que están en línea (ver [`Lobby::users`]).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsersPage {
    pub users: Vec<LobbyUser>,
    /// Cuántos hay en total con esa búsqueda.
    pub total: u64,
    pub offset: u64,
}

#[derive(Deserialize)]
struct Created {
    id: String,
}

#[derive(Deserialize)]
struct Accepted {
    partner: Option<Partner>,
}

/// Id para entrar en el server: uno nuevo en cada sesión, para que el server
/// (que se lo enseña a todos los conectados) no exponga el `device_id`
/// permanente del equipo.
pub fn session_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

impl Lobby {
    /// Entra en el server `base` (p. ej. `https://pasalo.vercel.app`) como
    /// `me`, y se queda escuchando hasta [`Lobby::leave`] o hasta emparejarse
    /// (with `multi`, until it leaves).
    pub async fn join(base: &str, remote: &Remote, me: LobbyUser, multi: bool, events: EventSender) -> Result<Self, Error> {
        let http = reqwest::Client::builder()
            .tls_backend_preconfigured(remote.endpoint().tls_config().clone())
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(server_error)?;
        let token: String = (0..2).map(|_| uuid::Uuid::new_v4().simple().to_string()).collect();
        let lobby = Self {
            inner: Arc::new(Inner {
                http,
                base: base.trim().trim_end_matches('/').to_string(),
                me,
                code: remote.code(),
                token,
                events,
                incoming: Mutex::default(),
                outgoing: Mutex::default(),
                left: AtomicBool::new(false),
                paired: AtomicBool::new(false),
                multi,
            }),
        };
        lobby.enter().await?;
        let running = lobby.clone();
        tokio::spawn(async move { running.run().await });
        Ok(lobby)
    }

    pub fn me(&self) -> &LobbyUser {
        &self.inner.me
    }

    /// Whether this session accepts several partners (see the module docs).
    pub fn is_multi(&self) -> bool {
        self.inner.multi
    }

    /// Pide conectarse con `to` (uno de la lista) y devuelve el id de la
    /// solicitud. A un amigo (`friend`) se le dice quién es.
    pub async fn request(&self, to: &LobbyUser, friend: bool) -> Result<String, Error> {
        let created: Created = self.post("request", json!({ "to": to.id, "friend": friend })).await?;
        self.inner.outgoing.lock().unwrap().insert(created.id.clone(), to.clone());
        Ok(created.id)
    }

    /// Una página de los que están en línea, con búsqueda por nombre (`q`).
    pub async fn users(&self, q: &str, offset: u64, limit: u64) -> Result<UsersPage, Error> {
        self.post("users", json!({ "q": q, "offset": offset, "limit": limit })).await
    }

    /// Cuáles de estos códigos (los amigos) están en el server, libres u ocupados.
    pub async fn friends(&self, codes: &[String]) -> Result<Vec<Friend>, Error> {
        Ok(self.post::<Friends>("friends", json!({ "codes": codes })).await?.friends)
    }

    /// Retira una solicitud enviada.
    pub async fn cancel(&self, request: &str) -> Result<(), Error> {
        self.inner.outgoing.lock().unwrap().remove(request);
        self.post::<serde_json::Value>("cancel", json!({ "request": request })).await.map(|_| ())
    }

    /// Contesta una solicitud recibida. Si se acepta, devuelve el otro equipo
    /// y deja el server.
    pub async fn answer(&self, request: &str, accept: bool) -> Result<Option<Partner>, Error> {
        // Se quita antes: un `sync` en vuelo que ya no la trae no debe
        // contarla como retirada.
        let from = self.inner.incoming.lock().unwrap().remove(request);
        let reply = self.post::<Accepted>("answer", json!({ "request": request, "accept": accept })).await;
        let reply = match reply {
            Ok(reply) => reply,
            Err(e) => {
                if let Some(from) = from {
                    self.inner.incoming.lock().unwrap().insert(request.to_string(), from);
                }
                return Err(e);
            }
        };
        match reply.partner {
            Some(partner) if accept => {
                self.paired(partner.clone()).await;
                Ok(Some(partner))
            }
            _ => Ok(None),
        }
    }

    /// Sale del server (también la pareja, que deja de salir ocupada). Las
    /// solicitudes pendientes se cancelan.
    pub async fn leave(&self) {
        if self.inner.left.swap(true, Ordering::Relaxed) {
            return;
        }
        let _ = self.post::<serde_json::Value>("leave", json!({})).await;
    }

    pub fn has_left(&self) -> bool {
        self.inner.left.load(Ordering::Relaxed)
    }

    async fn enter(&self) -> Result<(), Error> {
        let me = &self.inner.me;
        let busy = self.inner.paired.load(Ordering::Relaxed);
        let body = json!({ "name": me.name, "platform": me.platform, "code": self.inner.code, "busy": busy, "multi": self.inner.multi });
        self.post::<serde_json::Value>("join", body).await.map(|_| ())
    }

    async fn paired(&self, partner: Partner) {
        if !self.inner.multi {
            self.inner.paired.store(true, Ordering::Relaxed);
        }
        let _ = self.inner.events.send(Event::LobbyPaired { partner });
    }

    pub fn is_paired(&self) -> bool {
        self.inner.paired.load(Ordering::Relaxed)
    }

    /// Emparejado: solo se avisa de que se sigue (ocupado) hasta salir.
    async fn keep_busy(&self) {
        while !self.has_left() {
            tokio::time::sleep(PING_EVERY).await;
            if self.has_left() {
                return;
            }
            match self.post::<serde_json::Value>("ping", json!({})).await {
                // El server nos olvidó (p. ej. un corte largo): se vuelve a entrar, ocupado.
                Err(Error::Server(s)) if s.starts_with("401") && !self.has_left() => {
                    let _ = self.enter().await;
                }
                // Un server sin `ping` (anterior a los amigos): no hay a quién avisar.
                Err(Error::Server(s)) if s.starts_with("404") => return,
                _ => {}
            }
        }
    }

    /// Escucha al server hasta salir: lista de equipos, solicitudes recibidas
    /// y respuestas a las enviadas. Al emparejarse pasa a [`Self::keep_busy`].
    async fn run(&self) {
        let mut v = String::new();
        let mut fails = 0u32;
        while !self.has_left() {
            if self.is_paired() {
                return self.keep_busy().await;
            }
            let reply = self.post::<SyncReply>("sync", json!({ "v": v })).await;
            if self.has_left() || self.is_paired() {
                continue;
            }
            let reply = match reply {
                Ok(reply) => reply,
                Err(e) => {
                    let _ = self.inner.events.send(Event::LobbyError { detail: e.detail() });
                    fails += 1;
                    tokio::time::sleep(Duration::from_secs(5 << fails.min(3))).await;
                    // Si el server nos olvidó (caducó la sesión), se vuelve a entrar.
                    if matches!(&e, Error::Server(s) if s.starts_with("401")) {
                        let _ = self.enter().await;
                    }
                    v.clear();
                    continue;
                }
            };
            if fails > 0 {
                fails = 0;
                let _ = self.inner.events.send(Event::LobbyError { detail: String::new() });
            }
            v = reply.v;
            if let Some(users) = reply.users {
                let _ = self.inner.events.send(Event::LobbyUsers { users });
            }
            if let Some(requests) = reply.requests {
                self.update_incoming(requests);
            }
            for answer in reply.answers.unwrap_or_default() {
                let Some(to) = self.inner.outgoing.lock().unwrap().remove(&answer.id) else { continue };
                match (answer.state.as_str(), answer.code) {
                    ("accepted", Some(code)) => {
                        let partner = Partner { id: to.id, name: to.name, platform: to.platform, code };
                        self.paired(partner).await;
                        if !self.inner.multi {
                            break;
                        }
                    }
                    (state, _) => {
                        let _ = self.inner.events.send(Event::LobbyAnswer {
                            request: answer.id,
                            accepted: false,
                            reason: state.to_string(),
                        });
                    }
                }
            }
        }
    }

    fn update_incoming(&self, requests: Vec<IncomingRequest>) {
        let mut incoming = self.inner.incoming.lock().unwrap();
        let now: HashMap<String, LobbyUser> = requests.into_iter().map(|r| (r.id, r.from)).collect();
        for request in incoming.keys().filter(|id| !now.contains_key(*id)) {
            let _ = self.inner.events.send(Event::LobbyRequestGone { request: request.clone() });
        }
        for (request, from) in &now {
            if !incoming.contains_key(request) {
                let _ = self.inner.events.send(Event::LobbyRequest { request: request.clone(), from: from.clone() });
            }
        }
        *incoming = now;
    }

    async fn post<T: DeserializeOwned>(&self, action: &str, mut body: serde_json::Value) -> Result<T, Error> {
        body["id"] = self.inner.me.id.clone().into();
        body["token"] = self.inner.token.clone().into();
        let timeout = match action {
            "sync" => SYNC_WAIT + Duration::from_secs(15),
            _ => Duration::from_secs(20),
        };
        let response = self
            .inner
            .http
            .post(format!("{}/api/v1/{action}", self.inner.base))
            .header("content-type", "application/json")
            .body(serde_json::to_vec(&body).expect("JSON válido"))
            .timeout(timeout)
            .send()
            .await
            .map_err(server_error)?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(server_error)?;
        if !status.is_success() {
            let message = serde_json::from_slice::<serde_json::Value>(&bytes)
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
                .unwrap_or_default();
            return Err(Error::Server(format!("{} {message}", status.as_u16())));
        }
        serde_json::from_slice(&bytes).map_err(|e| Error::Server(e.to_string()))
    }
}

fn server_error(e: reqwest::Error) -> Error {
    // Sin la cadena de causas, reqwest solo dice "error sending request".
    let mut detail = e.to_string();
    let mut source = std::error::Error::source(&e);
    while let Some(cause) = source {
        detail = format!("{detail}: {cause}");
        source = cause.source();
    }
    Error::Server(detail)
}
