//! Estadísticas de las llamadas: cada llamada que termina se apunta aquí y
//! solo se sube al server cuando el usuario lo pide (Ajustes → Subir). No se
//! sube con quién fue la llamada: solo cómo fue (modo, duración, consumo,
//! pérdidas). Ver `server/lib/stats.js`.

use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::{Error, Remote};

/// Lo que acepta el server en cada subida.
const BATCH: usize = 100;
/// Campos que se suben de cada llamada (el resto, como el equipo o su
/// nombre, se queda aquí).
const FIELDS: &[&str] = &[
    "id", "media", "role", "outcome", "started", "duration_ms", "audio", "video", "sent", "received", "video_sent",
    "video_received", "lost", "recovered",
];

/// Llamadas pendientes de subir, una por línea en un `.jsonl`.
pub struct CallStats {
    path: PathBuf,
    lock: Mutex<()>,
}

impl CallStats {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into(), lock: Mutex::new(()) }
    }

    /// Apunta una llamada para subirla más tarde.
    pub fn push(&self, record: &Value) -> io::Result<()> {
        let _lock = self.lock.lock().unwrap();
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut line = serde_json::to_vec(&only_fields(record))?;
        line.push(b'\n');
        std::fs::OpenOptions::new().create(true).append(true).open(&self.path)?.write_all(&line)
    }

    /// Las que faltan por subir.
    pub fn pending(&self) -> Vec<Value> {
        let _lock = self.lock.lock().unwrap();
        self.read()
    }

    fn read(&self) -> Vec<Value> {
        let Ok(text) = std::fs::read_to_string(&self.path) else { return Vec::new() };
        text.lines().filter_map(|line| serde_json::from_str(line).ok()).collect()
    }

    /// Sube las pendientes a `server` y las quita de la lista. Devuelve cuántas subió.
    pub async fn upload(
        &self,
        remote: &Remote,
        server: &str,
        device: &str,
        platform: &str,
        version: &str,
    ) -> Result<usize, Error> {
        let pending = self.pending();
        if pending.is_empty() {
            return Ok(0);
        }
        let http = reqwest::Client::builder()
            .tls_backend_preconfigured(remote.endpoint().tls_config().clone())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| Error::Server(e.to_string()))?;
        let url = format!("{}/api/stats", server.trim().trim_end_matches('/'));
        let mut uploaded = 0;
        for batch in pending.chunks(BATCH) {
            let body = json!({ "device": device, "platform": platform, "version": version, "calls": batch });
            let response = http
                .post(&url)
                .header("content-type", "application/json")
                .body(serde_json::to_vec(&body).expect("JSON válido"))
                .send()
                .await
                .map_err(|e| Error::Server(e.to_string()))?;
            let status = response.status();
            if !status.is_success() {
                let text = response.text().await.unwrap_or_default();
                return Err(Error::Server(format!("{} {}", status.as_u16(), text.trim())));
            }
            uploaded += batch.len();
            self.forget(batch);
        }
        Ok(uploaded)
    }

    /// Quita de la lista las ya subidas (por id), dejando las que se
    /// apuntaron mientras tanto.
    fn forget(&self, done: &[Value]) {
        let _lock = self.lock.lock().unwrap();
        let ids: Vec<&Value> = done.iter().filter_map(|r| r.get("id")).collect();
        let left: Vec<Value> = self.read().into_iter().filter(|r| r.get("id").is_none_or(|id| !ids.contains(&id))).collect();
        let mut text = String::new();
        for record in &left {
            text.push_str(&record.to_string());
            text.push('\n');
        }
        let tmp = self.path.with_extension("tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(tmp, &self.path);
        }
    }
}

fn only_fields(record: &Value) -> Value {
    let mut out = Map::new();
    for field in FIELDS {
        if let Some(value) = record.get(*field) {
            out.insert((*field).to_string(), value.clone());
        }
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_what_is_uploaded() {
        let dir = tempfile::tempdir().unwrap();
        let stats = CallStats::new(dir.path().join("calls.jsonl"));
        stats.push(&json!({ "id": "a", "peer": "secreto", "name": "Ana", "duration_ms": 5 })).unwrap();
        stats.push(&json!({ "id": "b", "duration_ms": 7 })).unwrap();
        let pending = stats.pending();
        assert_eq!(pending.len(), 2);
        assert!(pending[0].get("peer").is_none() && pending[0].get("name").is_none());
        stats.forget(&pending[..1]);
        assert_eq!(stats.pending(), vec![json!({ "id": "b", "duration_ms": 7 })]);
    }
}
