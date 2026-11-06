//! Conexiones entre equipos con iroh: cada equipo tiene un código (su clave
//! pública) y se le llama por ese código. Por encima va el mismo protocolo
//! que en la LAN.
//!
//! Funciona en dos modos, con el mismo código y el mismo puerto:
//!
//! - **Solo red local** (al arrancar): sin relays ni publicación del código
//!   por DNS, así que iroh no manda nada a internet. Sirve para hablar con
//!   los equipos de la LAN, cuya dirección llega por el descubrimiento.
//! - **Internet**: con los relays y el DNS de n0, para llegar a equipos de
//!   otras redes por su código. Solo se activa cuando el usuario se conecta.
//!
//! El cambio se hace en marcha, añadiendo o quitando los relays y el DNS.

use std::io;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use iroh::address_lookup::{AddressLookupBuilder, DnsAddressLookup, PkarrPublisher, PkarrResolver};
use iroh::endpoint::{
    AckFrequencyConfig, Connection, PortmapperConfig, QuicTransportConfig, RecvStream, SendStream, VarInt, presets,
};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayConfig, RelayMap, RelayMode, SecretKey};

use crate::Error;
use crate::protocol::{SHORT, timed};

/// Identifica el protocolo de pasalo dentro de iroh.
pub const ALPN: &[u8] = b"pasalo/1";

/// Bytes en vuelo por stream. El valor por defecto (1,25 MB) limita a unos
/// 12 MB/s con 100 ms de latencia; con este, una transferencia entre redes
/// lejanas puede llenar la conexión.
const STREAM_WINDOW: u32 = 16 * 1024 * 1024;

/// Punto de conexión de este equipo. Clonarlo es barato y todos los clones
/// ven el mismo modo.
#[derive(Debug, Clone)]
pub struct Remote {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    key: SecretKey,
    endpoint: Endpoint,
    /// Si está puesto, solo se aceptan conexiones de este equipo.
    only: RwLock<Option<EndpointId>>,
    /// Serializa los cambios de modo; dentro, si está en modo internet.
    switching: tokio::sync::Mutex<bool>,
}

impl Remote {
    /// Arranca el punto de conexión. Con `key_path` el código se guarda ahí y
    /// no cambia entre reinicios; sin él se usa uno de usar y tirar (para
    /// enviar). Con `internet` arranca ya conectado a los relays.
    pub async fn start(key_path: Option<&Path>, internet: bool) -> io::Result<Self> {
        let key = match key_path {
            Some(path) => load_or_create_key(path)?,
            None => SecretKey::generate(),
        };
        let endpoint = bind(&key).await?;
        let remote = Self {
            inner: Arc::new(Inner {
                key,
                endpoint,
                only: RwLock::new(None),
                switching: tokio::sync::Mutex::new(false),
            }),
        };
        remote.set_internet(internet).await?;
        Ok(remote)
    }

    /// Código que hay que pasarle a otro equipo para que pueda enviarnos cosas.
    pub fn code(&self) -> String {
        self.inner.key.public().to_string()
    }

    pub fn id(&self) -> EndpointId {
        self.inner.key.public()
    }

    pub(crate) fn endpoint(&self) -> &Endpoint {
        &self.inner.endpoint
    }

    /// Puerto UDP IPv4 donde escucha iroh, para anunciarlo en la LAN.
    pub fn port(&self) -> Option<u16> {
        self.endpoint().bound_sockets().iter().find(|a| a.is_ipv4()).map(|a| a.port())
    }

    pub async fn internet(&self) -> bool {
        *self.inner.switching.lock().await
    }

    /// Pasa a modo internet (`true`) o solo red local (`false`). Las
    /// conexiones abiertas siguen; las que dependían de un relay se caen al
    /// volver a solo red local.
    pub async fn set_internet(&self, on: bool) -> io::Result<()> {
        let mut current = self.inner.switching.lock().await;
        if *current == on {
            return Ok(());
        }
        let endpoint = &self.inner.endpoint;
        let relays: Vec<Arc<RelayConfig>> = iroh::defaults::prod::default_relay_map().relays();
        let lookup = endpoint.address_lookup().map_err(io::Error::other)?;
        if on {
            for relay in relays {
                endpoint.insert_relay(relay.url.clone(), relay).await;
            }
            lookup.add(PkarrPublisher::n0_dns().into_address_lookup(endpoint).map_err(io::Error::other)?);
            lookup.add(PkarrResolver::n0_dns().into_address_lookup(endpoint).map_err(io::Error::other)?);
            lookup.add(DnsAddressLookup::n0_dns().into_address_lookup(endpoint).map_err(io::Error::other)?);
        } else {
            lookup.clear();
            for relay in relays {
                endpoint.remove_relay(&relay.url).await;
            }
        }
        *current = on;
        Ok(())
    }

    /// Espera a estar conectado a un relay (solo en modo internet): hasta
    /// entonces los demás no pueden encontrar este equipo por su código.
    pub async fn online(&self) {
        self.endpoint().online().await;
    }

    /// Acepta solo conexiones de `peer` (o de cualquiera, con `None`).
    pub fn set_only(&self, peer: Option<EndpointId>) {
        *self.inner.only.write().unwrap() = peer;
    }

    pub(crate) fn allows(&self, peer: EndpointId) -> bool {
        self.inner.only.read().unwrap().is_none_or(|only| only == peer)
    }

    /// Cierra las conexiones avisando al otro lado.
    pub async fn shutdown(&self) {
        self.endpoint().close().await;
    }


    /// Conecta con `id`. Con `lan` (su IP:puerto de iroh en la LAN, si se
    /// conoce por el descubrimiento) la conexión directa no necesita internet.
    pub(crate) async fn connect(&self, id: EndpointId, alpn: &[u8], lan: Option<SocketAddr>) -> Result<Connection, Error> {
        let addr = match lan {
            Some(lan) => EndpointAddr::new(id).with_ip_addr(lan),
            None => EndpointAddr::new(id),
        };
        let endpoint = self.endpoint();
        timed(SHORT, async { endpoint.connect(addr, alpn).await.map_err(io::Error::other) }).await
    }

    pub(crate) async fn open(&self, id: EndpointId) -> Result<(Connection, SendStream, RecvStream), Error> {
        let conn = self.connect(id, ALPN, None).await?;
        let (send, recv) = conn.open_bi().await.map_err(io::Error::other)?;
        Ok((conn, send, recv))
    }
}

/// Abre el punto de conexión en modo solo red local.
async fn bind(key: &SecretKey) -> io::Result<Endpoint> {
    // Cada paquete recibido pide un ACK, y con la voz eso es casi un paquete
    // de vuelta por cada uno de ida. Así el otro lado espera a juntar varios
    // (o un RTT) antes de confirmar. iroh lo limita al mayor entre el RTT y
    // 25 ms, así que la pérdida se sigue detectando a tiempo.
    let mut acks = AckFrequencyConfig::default();
    acks.ack_eliciting_threshold(VarInt::from_u32(10)).max_ack_delay(Some(Duration::from_millis(250)));
    let transport = QuicTransportConfig::builder()
        .stream_receive_window(VarInt::from_u32(STREAM_WINDOW))
        .receive_window(VarInt::from_u32(2 * STREAM_WINDOW))
        .send_window(2 * STREAM_WINDOW as u64)
        .ack_frequency_config(Some(acks))
        .build();
    // Sin relays (la lista vacía deja poner los de n0 luego), sin DNS y sin
    // sondear el router: nada sale de la LAN hasta pasar a modo internet.
    Endpoint::builder(presets::Minimal)
        .relay_mode(RelayMode::Custom(RelayMap::empty()))
        .portmapper_config(PortmapperConfig::Disabled)
        .transport_config(transport)
        .secret_key(key.clone())
        .alpns(vec![ALPN.to_vec(), crate::talk::TALK_ALPN.to_vec()])
        .bind()
        .await
        .map_err(io::Error::other)
}

/// Lee un código de equipo remoto (hex o base32), ignorando espacios.
pub fn parse_code(code: &str) -> Option<EndpointId> {
    let code: String = code.chars().filter(|c| !c.is_whitespace()).collect();
    code.parse().ok()
}

fn load_or_create_key(path: &Path) -> io::Result<SecretKey> {
    if let Ok(saved) = std::fs::read_to_string(path)
        && let Ok(key) = saved.trim().parse()
    {
        return Ok(key);
    }
    let key = SecretKey::generate();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let hex: String = key.to_bytes().iter().map(|b| format!("{b:02x}")).collect();
    std::fs::write(path, hex)?;
    // Quien tenga la clave se hace pasar por este equipo.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(key)
}
