//! Pasalo en el navegador: lo que tiene que ir en Rust (iroh, el códec de la
//! voz y BLAKE3) expuesto a JavaScript. Los protocolos (archivos, chat,
//! llamadas, server) están en `web/js/`, que habla con esto.
//!
//! En el navegador iroh no tiene UDP: todo va por los relays de n0 (por
//! WebSocket) y los códigos se publican y se buscan por pkarr sobre HTTPS.
//! Por lo demás, el protocolo es el mismo que el de las apps.
//!
//! Cada método asíncrono devuelve una `Promise`. Los errores llegan a
//! JavaScript como texto.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use bytes::Bytes;
use iroh::address_lookup::{AddressLookupBuilder, PkarrPublisher, PkarrResolver};
use iroh::endpoint::{AckFrequencyConfig, Connection, QuicTransportConfig, RecvStream, SendStream, VarInt, presets};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayConfig, RelayMap, RelayMode, SecretKey};
use js_sys::{Array, Promise, Uint8Array};
use n0_future::time::timeout;
use pasalo_call::Mode;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;

const PASALO_ALPN: &[u8] = b"pasalo/1";
const TALK_ALPN: &[u8] = b"pasalo/talk/1";
/// Bytes en vuelo por stream (como en las apps).
const STREAM_WINDOW: u32 = 16 * 1024 * 1024;

fn err(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

fn timed_out() -> JsValue {
    JsValue::from_str("timeout")
}

fn ms(ms: u32) -> Duration {
    Duration::from_millis(ms as u64)
}

/// Código de un equipo en hex minúsculas (como lo guardan las apps), o
/// `undefined` si no es válido. Acepta hex o base32 y quita los espacios.
#[wasm_bindgen]
pub fn parse_code(code: &str) -> Option<String> {
    let code: String = code.chars().filter(|c| !c.is_whitespace()).collect();
    code.parse::<EndpointId>().ok().map(|id| id.to_string())
}

/// Punto de conexión de este navegador.
#[wasm_bindgen]
pub struct Node {
    key: SecretKey,
    endpoint: Endpoint,
    internet: Rc<Cell<bool>>,
}

#[wasm_bindgen]
impl Node {
    /// Arranca con la clave guardada (hex) o con una nueva. Como en las
    /// apps, empieza sin relays: nada sale a internet hasta `setInternet(true)`.
    pub fn start(secret: Option<String>) -> Promise {
        future_to_promise(async move {
            let key = secret
                .and_then(|s| s.trim().parse::<SecretKey>().ok())
                .unwrap_or_else(SecretKey::generate);
            let mut acks = AckFrequencyConfig::default();
            acks.ack_eliciting_threshold(VarInt::from_u32(10)).max_ack_delay(Some(Duration::from_millis(250)));
            let transport = QuicTransportConfig::builder()
                .stream_receive_window(VarInt::from_u32(STREAM_WINDOW))
                .receive_window(VarInt::from_u32(2 * STREAM_WINDOW))
                .send_window(2 * STREAM_WINDOW as u64)
                .ack_frequency_config(Some(acks))
                .build();
            let endpoint = Endpoint::builder(presets::Minimal)
                .relay_mode(RelayMode::Custom(RelayMap::empty()))
                .transport_config(transport)
                .secret_key(key.clone())
                .alpns(vec![PASALO_ALPN.to_vec(), TALK_ALPN.to_vec()])
                .bind()
                .await
                .map_err(err)?;
            Ok(Node { key, endpoint, internet: Rc::new(Cell::new(false)) }.into())
        })
    }

    /// Código de este equipo (su clave pública, en hex).
    #[wasm_bindgen(getter)]
    pub fn code(&self) -> String {
        self.key.public().to_string()
    }

    /// La clave secreta en hex, para guardarla y conservar el código.
    #[wasm_bindgen(getter)]
    pub fn secret(&self) -> String {
        self.key.to_bytes().iter().map(|b| format!("{b:02x}")).collect()
    }

    #[wasm_bindgen(getter)]
    pub fn internet(&self) -> bool {
        self.internet.get()
    }

    /// Añade (o quita) los relays de n0 y la publicación del código por pkarr.
    #[wasm_bindgen(js_name = setInternet)]
    pub fn set_internet(&self, on: bool) -> Promise {
        let (endpoint, internet) = (self.endpoint.clone(), self.internet.clone());
        future_to_promise(async move {
            if internet.get() == on {
                return Ok(JsValue::UNDEFINED);
            }
            let relays: Vec<Arc<RelayConfig>> = iroh::defaults::prod::default_relay_map().relays();
            let lookup = endpoint.address_lookup().map_err(err)?;
            if on {
                for relay in relays {
                    endpoint.insert_relay(relay.url.clone(), relay).await;
                }
                lookup.add(PkarrPublisher::n0_dns().into_address_lookup(&endpoint).map_err(err)?);
                lookup.add(PkarrResolver::n0_dns().into_address_lookup(&endpoint).map_err(err)?);
            } else {
                lookup.clear();
                for relay in relays {
                    endpoint.remove_relay(&relay.url).await;
                }
            }
            internet.set(on);
            Ok(JsValue::UNDEFINED)
        })
    }

    /// Termina cuando hay relay (o con `false` si no llega en `wait` ms).
    pub fn online(&self, wait: u32) -> Promise {
        let endpoint = self.endpoint.clone();
        future_to_promise(async move { Ok(timeout(ms(wait), endpoint.online()).await.is_ok().into()) })
    }

    /// Conecta con el equipo `code` por el protocolo `alpn` (`pasalo/1` o `pasalo/talk/1`).
    pub fn connect(&self, code: String, alpn: String, wait: u32) -> Promise {
        let endpoint = self.endpoint.clone();
        future_to_promise(async move {
            let id: EndpointId = parse_code(&code).ok_or_else(|| err("código no válido"))?.parse().map_err(err)?;
            let conn = timeout(ms(wait), endpoint.connect(EndpointAddr::new(id), alpn.as_bytes()))
                .await
                .map_err(|_| timed_out())?
                .map_err(err)?;
            Ok(Conn::new(conn).into())
        })
    }

    /// La siguiente conexión entrante ya establecida, o `null` si se cerró el punto de conexión.
    pub fn accept(&self) -> Promise {
        let endpoint = self.endpoint.clone();
        future_to_promise(async move {
            loop {
                let Some(incoming) = endpoint.accept().await else { return Ok(JsValue::NULL) };
                match incoming.await {
                    Ok(conn) => return Ok(Conn::new(conn).into()),
                    Err(e) => web_sys_log(&format!("conexión entrante fallida: {e}")),
                }
            }
        })
    }

    pub fn close(&self) -> Promise {
        let endpoint = self.endpoint.clone();
        future_to_promise(async move {
            endpoint.close().await;
            Ok(JsValue::UNDEFINED)
        })
    }
}

fn web_sys_log(text: &str) {
    web_sys::console::debug_1(&text.into());
}

/// Una conexión de iroh con otro equipo.
#[wasm_bindgen]
pub struct Conn {
    conn: Connection,
}

impl Conn {
    fn new(conn: Connection) -> Self {
        Self { conn }
    }
}

#[wasm_bindgen]
impl Conn {
    /// Código del otro equipo.
    #[wasm_bindgen(getter)]
    pub fn remote(&self) -> String {
        self.conn.remote_id().to_string()
    }

    #[wasm_bindgen(getter)]
    pub fn alpn(&self) -> String {
        String::from_utf8_lossy(self.conn.alpn()).into_owned()
    }

    /// Si la abrió el otro lado.
    #[wasm_bindgen(getter)]
    pub fn incoming(&self) -> bool {
        self.conn.side().is_server()
    }

    /// Identifica la conexión (dos `Conn` con el mismo id son la misma).
    #[wasm_bindgen(getter)]
    pub fn id(&self) -> f64 {
        self.conn.stable_id() as f64
    }

    #[wasm_bindgen(getter)]
    pub fn closed(&self) -> bool {
        self.conn.close_reason().is_some()
    }

    /// Termina cuando se cierra, con el motivo.
    #[wasm_bindgen(js_name = waitClosed)]
    pub fn wait_closed(&self) -> Promise {
        let conn = self.conn.clone();
        future_to_promise(async move { Ok(conn.closed().await.to_string().into()) })
    }

    pub fn close(&self, code: u32, reason: &str) {
        self.conn.close(code.into(), reason.as_bytes());
    }

    /// `[send, recv]`.
    #[wasm_bindgen(js_name = openBi)]
    pub fn open_bi(&self, wait: u32) -> Promise {
        let conn = self.conn.clone();
        future_to_promise(async move {
            let (send, recv) = timeout(ms(wait), conn.open_bi()).await.map_err(|_| timed_out())?.map_err(err)?;
            Ok(pair(send, recv))
        })
    }

    #[wasm_bindgen(js_name = openUni)]
    pub fn open_uni(&self, wait: u32) -> Promise {
        let conn = self.conn.clone();
        future_to_promise(async move {
            let send = timeout(ms(wait), conn.open_uni()).await.map_err(|_| timed_out())?.map_err(err)?;
            Ok(Send::new(send).into())
        })
    }

    /// `[send, recv]`, o `null` cuando se cierra la conexión.
    #[wasm_bindgen(js_name = acceptBi)]
    pub fn accept_bi(&self) -> Promise {
        let conn = self.conn.clone();
        future_to_promise(async move {
            match conn.accept_bi().await {
                Ok((send, recv)) => Ok(pair(send, recv)),
                Err(_) => Ok(JsValue::NULL),
            }
        })
    }

    /// `Recv`, o `null` cuando se cierra la conexión.
    #[wasm_bindgen(js_name = acceptUni)]
    pub fn accept_uni(&self) -> Promise {
        let conn = self.conn.clone();
        future_to_promise(async move {
            match conn.accept_uni().await {
                Ok(recv) => Ok(Recv::new(recv).into()),
                Err(_) => Ok(JsValue::NULL),
            }
        })
    }

    /// Envía un datagrama (no fiable). `false` si no se pudo.
    #[wasm_bindgen(js_name = sendDatagram)]
    pub fn send_datagram(&self, data: &[u8]) -> bool {
        self.conn.send_datagram(Bytes::copy_from_slice(data)).is_ok()
    }

    /// El siguiente datagrama, o `null` cuando se cierra la conexión.
    #[wasm_bindgen(js_name = readDatagram)]
    pub fn read_datagram(&self) -> Promise {
        let conn = self.conn.clone();
        future_to_promise(async move {
            match conn.read_datagram().await {
                Ok(data) => Ok(Uint8Array::from(&data[..]).into()),
                Err(_) => Ok(JsValue::NULL),
            }
        })
    }

    /// Bytes que han salido y entrado, con 28 de cabeceras IPv4 y UDP por
    /// datagrama: `[enviados, recibidos]` (como `voice_stats` en las apps).
    #[wasm_bindgen(js_name = wireBytes)]
    pub fn wire_bytes(&self) -> Vec<f64> {
        let stats = self.conn.stats();
        vec![
            (stats.udp_tx.bytes + 28 * stats.udp_tx.datagrams) as f64,
            (stats.udp_rx.bytes + 28 * stats.udp_rx.datagrams) as f64,
        ]
    }
}

fn pair(send: SendStream, recv: RecvStream) -> JsValue {
    let out = Array::new();
    out.push(&Send::new(send).into());
    out.push(&Recv::new(recv).into());
    out.into()
}

/// Lado de envío de un stream.
#[wasm_bindgen]
pub struct Send {
    stream: Rc<RefCell<Option<SendStream>>>,
}

impl Send {
    fn new(stream: SendStream) -> Self {
        Self { stream: Rc::new(RefCell::new(Some(stream))) }
    }
}

/// Saca el stream mientras se espera y lo devuelve al terminar: así dos
/// operaciones a la vez dan error en vez de romper el `RefCell`.
struct Taken<T> {
    slot: Rc<RefCell<Option<T>>>,
    value: Option<T>,
}

impl<T> Taken<T> {
    fn take(slot: &Rc<RefCell<Option<T>>>) -> Result<Self, JsValue> {
        let value = slot.borrow_mut().take().ok_or_else(|| err("stream ocupado o cerrado"))?;
        Ok(Self { slot: slot.clone(), value: Some(value) })
    }
}

impl<T> std::ops::Deref for Taken<T> {
    type Target = T;
    fn deref(&self) -> &T {
        self.value.as_ref().expect("con valor")
    }
}

impl<T> std::ops::DerefMut for Taken<T> {
    fn deref_mut(&mut self) -> &mut T {
        self.value.as_mut().expect("con valor")
    }
}

impl<T> Drop for Taken<T> {
    fn drop(&mut self) {
        *self.slot.borrow_mut() = self.value.take();
    }
}

#[wasm_bindgen]
impl Send {
    /// Escribe todo `data` (esperando a que el otro lado haga sitio, hasta `wait` ms).
    pub fn write(&self, data: Vec<u8>, wait: u32) -> Promise {
        let slot = self.stream.clone();
        future_to_promise(async move {
            let mut stream = Taken::take(&slot)?;
            timeout(ms(wait), stream.write_chunk(Bytes::from(data)))
                .await
                .map_err(|_| timed_out())?
                .map_err(err)?;
            Ok(JsValue::UNDEFINED)
        })
    }

    /// Ya no se escribe más.
    pub fn finish(&self) {
        if let Some(stream) = self.stream.borrow_mut().as_mut() {
            let _ = stream.finish();
        }
    }

    /// Termina cuando el otro lado lo ha recibido todo (tras `finish`).
    pub fn stopped(&self, wait: u32) -> Promise {
        let slot = self.stream.clone();
        future_to_promise(async move {
            let stopped = {
                let stream = slot.borrow();
                stream.as_ref().ok_or_else(|| err("stream cerrado"))?.stopped()
            };
            timeout(ms(wait), stopped).await.map_err(|_| timed_out())?.map_err(err)?;
            Ok(JsValue::UNDEFINED)
        })
    }

    #[wasm_bindgen(js_name = setPriority)]
    pub fn set_priority(&self, priority: i32) {
        if let Some(stream) = self.stream.borrow().as_ref() {
            let _ = stream.set_priority(priority);
        }
    }

    pub fn reset(&self) {
        if let Some(stream) = self.stream.borrow_mut().as_mut() {
            let _ = stream.reset(0u32.into());
        }
    }
}

/// Lado de lectura de un stream.
#[wasm_bindgen]
pub struct Recv {
    stream: Rc<RefCell<Option<RecvStream>>>,
}

impl Recv {
    fn new(stream: RecvStream) -> Self {
        Self { stream: Rc::new(RefCell::new(Some(stream))) }
    }
}

#[wasm_bindgen]
impl Recv {
    /// Lo que haya llegado (hasta `max` bytes), o `null` al final del stream.
    pub fn read(&self, max: u32, wait: u32) -> Promise {
        let slot = self.stream.clone();
        future_to_promise(async move {
            let mut stream = Taken::take(&slot)?;
            let chunk = timeout(ms(wait), stream.read_chunk(max as usize))
                .await
                .map_err(|_| timed_out())?
                .map_err(err)?;
            Ok(chunk.map_or(JsValue::NULL, |c| Uint8Array::from(&c[..]).into()))
        })
    }

    /// Todo hasta el final del stream (como mucho `max` bytes).
    #[wasm_bindgen(js_name = readToEnd)]
    pub fn read_to_end(&self, max: u32, wait: u32) -> Promise {
        let slot = self.stream.clone();
        future_to_promise(async move {
            let mut stream = Taken::take(&slot)?;
            let data = timeout(ms(wait), stream.read_to_end(max as usize))
                .await
                .map_err(|_| timed_out())?
                .map_err(err)?;
            Ok(Uint8Array::from(&data[..]).into())
        })
    }

    pub fn stop(&self) {
        if let Some(stream) = self.stream.borrow_mut().as_mut() {
            let _ = stream.stop(0u32.into());
        }
    }
}

/// BLAKE3 incremental, para verificar los archivos como las apps.
#[wasm_bindgen]
pub struct Hasher(blake3::Hasher);

#[wasm_bindgen]
impl Hasher {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self(blake3::Hasher::new())
    }

    pub fn update(&mut self, data: &[u8]) {
        self.0.update(data);
    }

    /// En hex. No consume el estado.
    pub fn hex(&self) -> String {
        self.0.finalize().to_hex().to_string()
    }
}

impl Default for Hasher {
    fn default() -> Self {
        Self::new()
    }
}

fn mode(name: &str) -> Mode {
    match name {
        "high" => Mode::High,
        "low" => Mode::Low,
        "minimum" => Mode::Minimum,
        _ => Mode::Normal,
    }
}

/// Voz de una llamada: micrófono → paquetes y paquetes → altavoz, con el
/// mismo formato que las apps (ver `pasalo-call`).
#[wasm_bindgen]
pub struct Voice {
    sender: pasalo_call::Sender,
    receiver: pasalo_call::Receiver,
    stats: Arc<pasalo_call::Stats>,
    muted: Arc<AtomicBool>,
}

#[wasm_bindgen]
impl Voice {
    /// `rate` es el del AudioContext (entrada y salida).
    #[wasm_bindgen(constructor)]
    pub fn new(mode_name: &str, rate: u32) -> Self {
        let stats = Arc::new(pasalo_call::Stats::default());
        let muted = Arc::new(AtomicBool::new(false));
        let mut sender = pasalo_call::Sender::new(mode(mode_name), rate, stats.clone(), muted.clone());
        // El navegador ya cancela el eco (echoCancellation de getUserMedia).
        sender.set_echo_gate(false);
        let receiver = pasalo_call::Receiver::new(rate, stats.clone());
        Self { sender, receiver, stats, muted }
    }

    /// Muestras del micrófono; devuelve los paquetes que haya que enviar.
    pub fn record(&mut self, samples: &[f32]) -> Array {
        self.sender.push(samples).into_iter().map(|p| JsValue::from(Uint8Array::from(&p[..]))).collect()
    }

    /// Un paquete que llegó del otro lado.
    pub fn receive(&mut self, packet: &[u8]) {
        self.receiver.push(packet);
    }

    /// `n` muestras para el altavoz.
    pub fn play(&mut self, n: u32) -> Vec<f32> {
        let mut out = vec![0.0; n as usize];
        self.receiver.pull(&mut out);
        out
    }

    #[wasm_bindgen(js_name = setMode)]
    pub fn set_mode(&mut self, mode_name: &str) {
        self.sender.set_mode(mode(mode_name));
    }

    #[wasm_bindgen(js_name = setMuted)]
    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::Relaxed);
    }

    /// `[perdidos, recuperados]`.
    pub fn losses(&self) -> Vec<f64> {
        vec![
            self.stats.lost_packets.load(Ordering::Relaxed) as f64,
            self.stats.recovered_packets.load(Ordering::Relaxed) as f64,
        ]
    }
}
