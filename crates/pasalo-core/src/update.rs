//! ¿Hay una versión nueva? Se le pregunta a GitHub por la última release
//! publicada (las pre-releases no cuentan). Solo cuando el usuario lo pide:
//! nada se consulta solo.

use std::cmp::Ordering;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::{Error, Remote};

/// Repositorio donde se publican las releases.
pub const REPO: &str = "fresnohernandez99/pasalo";

/// Lo que se sabe de la última versión publicada.
#[derive(Debug, Clone, Serialize)]
pub struct Release {
    /// Sin la `v` delante (p. ej. `1.2.0`).
    pub version: String,
    /// Si es más nueva que `current`.
    pub newer: bool,
    /// Página de la release.
    pub url: String,
    /// Descarga directa del archivo para este equipo, si se reconoce.
    pub download: Option<String>,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

/// Busca la última release y la compara con `current` (la versión instalada).
/// `asset` dice qué archivo de la release es para este equipo (p. ej. el APK
/// de su arquitectura). Usa los certificados que ya trae iroh.
pub async fn latest_release(remote: &Remote, current: &str, asset: impl Fn(&str) -> bool) -> Result<Release, Error> {
    let http = reqwest::Client::builder()
        .tls_backend_preconfigured(remote.endpoint().tls_config().clone())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| Error::Server(e.to_string()))?;
    let response = http
        .get(format!("https://api.github.com/repos/{REPO}/releases/latest"))
        // GitHub rechaza las peticiones sin User-Agent.
        .header("user-agent", concat!("pasalo/", env!("CARGO_PKG_VERSION")))
        .header("accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| Error::Server(e.to_string()))?;
    let status = response.status();
    // Sin ninguna release publicada todavía.
    if status.as_u16() == 404 {
        return Ok(Release { version: current.to_string(), newer: false, url: format!("https://github.com/{REPO}/releases"), download: None });
    }
    if !status.is_success() {
        return Err(Error::Server(format!("GitHub {}", status.as_u16())));
    }
    let bytes = response.bytes().await.map_err(|e| Error::Server(e.to_string()))?;
    let release: GithubRelease = serde_json::from_slice(&bytes).map_err(|e| Error::Server(e.to_string()))?;
    let version = release.tag_name.trim_start_matches('v').to_string();
    Ok(Release {
        newer: compare(&version, current) == Ordering::Greater,
        download: release.assets.into_iter().find(|a| asset(&a.name)).map(|a| a.browser_download_url),
        url: release.html_url,
        version,
    })
}

/// Compara versiones `1.2.3` o `1.2.3-rc1`. Una pre-release va antes que la
/// versión final con los mismos números.
pub fn compare(a: &str, b: &str) -> Ordering {
    let parse = |v: &str| {
        let v = v.trim().trim_start_matches('v');
        let (numbers, pre) = v.split_once('-').unwrap_or((v, ""));
        let numbers: Vec<u64> = numbers.split('.').map(|n| n.parse().unwrap_or(0)).collect();
        (numbers, pre.to_string())
    };
    let ((mut na, pa), (mut nb, pb)) = (parse(a), parse(b));
    let len = na.len().max(nb.len());
    na.resize(len, 0);
    nb.resize(len, 0);
    na.cmp(&nb).then_with(|| match (pa.is_empty(), pb.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => pa.cmp(&pb),
    })
}

#[cfg(test)]
mod tests {
    use super::compare;
    use std::cmp::Ordering::*;

    #[test]
    fn versions() {
        assert_eq!(compare("1.0.0", "0.1.0"), Greater);
        assert_eq!(compare("v1.0.1", "1.0.0"), Greater);
        assert_eq!(compare("1.0", "1.0.0"), Equal);
        assert_eq!(compare("1.0.0-rc1", "1.0.0"), Less);
        assert_eq!(compare("1.0.0", "1.0.0-rc3"), Greater);
        assert_eq!(compare("1.10.0", "1.9.0"), Greater);
    }
}
