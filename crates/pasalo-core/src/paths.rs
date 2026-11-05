use std::path::{Path, PathBuf};

pub(crate) const PART_EXT: &str = ".pasalo-part";

/// Divide una ruta recibida en componentes seguros, o `None` si intenta salir
/// de la carpeta de destino.
pub(crate) fn split_safe(path: &str) -> Option<Vec<String>> {
    let mut out = Vec::new();
    for component in path.split('/') {
        if component.is_empty() || component == "." || component == ".." || component.contains('\0') {
            return None;
        }
        out.push(sanitize_component(component));
    }
    (!out.is_empty()).then_some(out)
}

/// Adapta un nombre de archivo a las reglas de Windows; en el resto de sistemas lo deja igual.
fn sanitize_component(component: &str) -> String {
    if !cfg!(windows) {
        return component.to_string();
    }
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let mut name: String = component
        .chars()
        .map(|c| if c < ' ' || "<>:\"\\|?*".contains(c) { '_' } else { c })
        .collect();
    while name.ends_with('.') || name.ends_with(' ') {
        name.pop();
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        name.insert(0, '_');
    }
    if name.is_empty() {
        name.push('_');
    }
    name
}

/// `foto.jpg` → `foto (n).jpg`; las carpetas no tienen extensión.
pub(crate) fn numbered(name: &str, is_dir: bool, n: u32) -> String {
    match name.rfind('.') {
        Some(i) if !is_dir && i > 0 => format!("{} ({n}){}", &name[..i], &name[i..]),
        _ => format!("{name} ({n})"),
    }
}

/// Un nombre que no choque con nada de `dir` ni con lo que diga `also_taken`.
pub(crate) fn unique_name(dir: &Path, name: &str, is_dir: bool, also_taken: impl Fn(&str) -> bool) -> String {
    let taken = |n: &str| also_taken(n) || dir.join(n).exists() || dir.join(format!("{n}{PART_EXT}")).exists();
    if !taken(name) {
        return name.to_string();
    }
    (1..).map(|n| numbered(name, is_dir, n)).find(|n| !taken(n)).expect("rango infinito")
}

pub(crate) fn part_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(PART_EXT);
    s.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_escaping_paths() {
        assert!(split_safe("../x").is_none());
        assert!(split_safe("a/../../x").is_none());
        assert!(split_safe("/etc/passwd").is_none());
        assert!(split_safe("a//b").is_none());
        assert!(split_safe("").is_none());
        assert_eq!(split_safe("a/b.txt").unwrap(), ["a", "b.txt"]);
    }

    #[test]
    fn numbers_names() {
        assert_eq!(numbered("foto.jpg", false, 2), "foto (2).jpg");
        assert_eq!(numbered(".bashrc", false, 1), ".bashrc (1)");
        assert_eq!(numbered("v1.2", true, 1), "v1.2 (1)");
    }
}
