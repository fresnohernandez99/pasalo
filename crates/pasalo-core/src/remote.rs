//! Conexiones entre redes distintas con iroh: cada equipo tiene un código (su
//! clave pública) y se le llama por ese código, sin IPs ni puertos abiertos.
//! iroh intenta la conexión directa atravesando el NAT y, si no puede, pasa
//! por un relay. Por encima va el mismo protocolo que en la LAN.

use std::io;
use std::net::SocketAddr;
use std::path::Path;

use iroh::endpoint::{Connection, QuicTransportConfig, RecvStream, SendStream, VarInt, presets};
use iroh::{Endpoint, EndpointAddr, EndpointId, SecretKey};

use crate::Error;
use crate::protocol::{SHORT, timed};

/// Identifica el protocolo de pasalo dentro de iroh.
pub const ALPN: &[u8] = b"pasalo/1";

/// Bytes en vuelo por stream. El valor por defecto (1,25 MB) limita a unos
/// 12 MB/s con 100 ms de latencia; con este, una transferencia entre redes
/// lejanas puede llenar la conexión.
const STREAM_WINDOW: u32 = 16 * 1024 * 1024;

/// Punto de conexión remoto de este equipo. Clonarlo es barato.
#[derive(Debug, Clone)]
pub struct Remote {
    pub(crate) endpoint: Endpoint,
}

impl Remote {
    /// Arranca el punto de conexión. Con `key_path` el código se guarda ahí y
    /// no cambia entre reinicios; sin él se usa uno de usar y tirar (para enviar).
    pub async fn start(key_path: Option<&Path>) -> io::Result<Self> {
        let key = match key_path {
            Some(path) => load_or_create_key(path)?,
            None => SecretKey::generate(),
        };
        let transport = QuicTransportConfig::builder()
            .stream_receive_window(VarInt::from_u32(STREAM_WINDOW))
            .receive_window(VarInt::from_u32(2 * STREAM_WINDOW))
            .send_window(2 * STREAM_WINDOW as u64)
            .build();
        let endpoint = Endpoint::builder(presets::N0)
            .transport_config(transport)
            .secret_key(key)
            .alpns(vec![ALPN.to_vec(), crate::talk::TALK_ALPN.to_vec()])
            .bind()
            .await
            .map_err(io::Error::other)?;
        Ok(Self { endpoint })
    }

    /// Código que hay que pasarle a otro equipo para que pueda enviarnos cosas.
    pub fn code(&self) -> String {
        self.endpoint.id().to_string()
    }

    /// Puerto UDP IPv4 donde escucha iroh, para anunciarlo en la LAN.
    pub fn port(&self) -> Option<u16> {
        self.endpoint.bound_sockets().iter().find(|a| a.is_ipv4()).map(|a| a.port())
    }

    /// Espera a estar conectado a un relay: hasta entonces los demás no pueden
    /// encontrar este equipo por su código.
    pub async fn online(&self) {
        self.endpoint.online().await;
    }

    /// Cierra las conexiones avisando al otro lado.
    pub async fn shutdown(&self) {
        self.endpoint.close().await;
    }

    /// Conecta con `id`. Con `lan` (su IP:puerto de iroh en la LAN, si se
    /// conoce por el descubrimiento) la conexión directa no necesita internet.
    pub(crate) async fn connect(&self, id: EndpointId, alpn: &[u8], lan: Option<SocketAddr>) -> Result<Connection, Error> {
        let addr = match lan {
            Some(lan) => EndpointAddr::new(id).with_ip_addr(lan),
            None => EndpointAddr::new(id),
        };
        timed(SHORT, async { self.endpoint.connect(addr, alpn).await.map_err(io::Error::other) }).await
    }

    pub(crate) async fn open(&self, id: EndpointId) -> Result<(Connection, SendStream, RecvStream), Error> {
        let conn = self.connect(id, ALPN, None).await?;
        let (send, recv) = conn.open_bi().await.map_err(io::Error::other)?;
        Ok((conn, send, recv))
    }
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
