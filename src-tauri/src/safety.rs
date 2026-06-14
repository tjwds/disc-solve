//! The deletion guard. Every path bound for the Trash passes through
//! [`validate_trash_target`] first. It is deliberately conservative: when in
//! doubt, it refuses. Nothing here deletes anything — it only decides whether a
//! path is *eligible* to be moved to the Trash by the caller.

use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
pub enum SafetyError {
    NotAbsolute,
    NotFound,
    IsSymlink,
    Protected,
    OutsideRoot,
}

impl SafetyError {
    pub fn message(&self) -> String {
        match self {
            SafetyError::NotAbsolute => "Path must be absolute".into(),
            SafetyError::NotFound => "Path does not exist".into(),
            SafetyError::IsSymlink => "Refusing to trash a symlink".into(),
            SafetyError::Protected => "Refusing to trash a protected system or top-level location".into(),
            SafetyError::OutsideRoot => "Path is outside the scanned folder".into(),
        }
    }
}

/// Subtrees that are never user data. A target inside any of these is refused.
const PROTECTED_SUBTREES: &[&str] = &[
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/private/etc",
    "/private/var",
    "/dev",
    "/cores",
    "/Network",
    "/Library", // top-level system library; ~/Library is fine (different prefix)
    "/opt",
];

/// Exact paths that may never be trashed as a whole, even though items *inside*
/// them can be. Includes container roots and the user's home directory.
fn protected_exact() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = ["/", "/Users", "/Applications", "/Volumes", "/private", "/tmp"]
        .iter()
        .map(PathBuf::from)
        .collect();
    if let Some(home) = home_dir() {
        v.push(home);
    }
    v
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Validate that `target` is eligible to be moved to the Trash, given the root of
/// the current scan. Returns the canonical path on success.
///
/// Rules (all must hold):
/// 1. absolute, exists, and is not a symlink (we never trash *through* links);
/// 2. lies within `allowed_root` (the folder the user actually scanned);
/// 3. is not `allowed_root` itself, nor any protected subtree or container root.
pub fn validate_trash_target(target: &Path, allowed_root: &Path) -> Result<PathBuf, SafetyError> {
    if !target.is_absolute() {
        return Err(SafetyError::NotAbsolute);
    }

    // lstat (does not follow symlinks). Missing => refuse.
    let meta = std::fs::symlink_metadata(target).map_err(|_| SafetyError::NotFound)?;
    if meta.file_type().is_symlink() {
        return Err(SafetyError::IsSymlink);
    }

    // Canonicalize both sides so `..`, `.`, and symlinked parents can't sneak the
    // target out of `allowed_root` or into a protected location.
    let canon = std::fs::canonicalize(target).map_err(|_| SafetyError::NotFound)?;
    let root = std::fs::canonicalize(allowed_root).map_err(|_| SafetyError::OutsideRoot)?;

    if !canon.starts_with(&root) {
        return Err(SafetyError::OutsideRoot);
    }
    // Never the scanned root itself.
    if canon == root {
        return Err(SafetyError::Protected);
    }
    for exact in protected_exact() {
        if let Ok(canon_exact) = std::fs::canonicalize(&exact) {
            if canon == canon_exact {
                return Err(SafetyError::Protected);
            }
        }
    }
    let canon_str = canon.to_string_lossy();
    let root_str = root.to_string_lossy();
    let under = |p: &str, sub: &str| p == sub || p.starts_with(&format!("{sub}/"));
    for sub in PROTECTED_SUBTREES {
        // Protect system subtrees — unless the user deliberately scoped the scan
        // *into* that subtree, in which case targets within their chosen folder
        // are legitimate. (This also lets the test suite operate under /private/var.)
        if under(&canon_str, sub) && !under(&root_str, sub) {
            return Err(SafetyError::Protected);
        }
    }

    Ok(canon)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn relative_path_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            validate_trash_target(Path::new("relative/x"), tmp.path()),
            Err(SafetyError::NotAbsolute)
        );
    }

    #[test]
    fn missing_path_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("nope");
        assert_eq!(
            validate_trash_target(&missing, tmp.path()),
            Err(SafetyError::NotFound)
        );
    }

    #[test]
    fn symlink_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real.bin");
        fs::write(&real, b"hi").unwrap();
        let link = tmp.path().join("link.bin");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_eq!(
            validate_trash_target(&link, tmp.path()),
            Err(SafetyError::IsSymlink)
        );
    }

    #[test]
    fn scanned_root_itself_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            validate_trash_target(tmp.path(), tmp.path()),
            Err(SafetyError::Protected)
        );
    }

    #[test]
    fn outside_root_rejected() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let f = other.path().join("f.bin");
        fs::write(&f, b"hi").unwrap();
        assert_eq!(
            validate_trash_target(&f, root.path()),
            Err(SafetyError::OutsideRoot)
        );
    }

    #[test]
    fn parent_escape_via_dotdot_rejected() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let f = other.path().join("f.bin");
        fs::write(&f, b"hi").unwrap();
        // root/../<other>/f.bin canonicalizes outside root.
        let sneaky = root.path().join("..").join(other.path().file_name().unwrap()).join("f.bin");
        assert!(matches!(
            validate_trash_target(&sneaky, root.path()),
            Err(SafetyError::OutsideRoot) | Err(SafetyError::NotFound)
        ));
    }

    #[test]
    fn ordinary_file_inside_root_is_accepted() {
        let root = tempfile::tempdir().unwrap();
        let sub = root.path().join("Downloads");
        fs::create_dir(&sub).unwrap();
        let f = sub.join("big.bin");
        fs::write(&f, b"data").unwrap();
        let ok = validate_trash_target(&f, root.path()).unwrap();
        assert!(ok.ends_with("big.bin"));
    }

    #[test]
    fn system_locations_rejected_even_if_root_is_slash() {
        // With root "/", these exist on macOS and must still be refused.
        for p in ["/System", "/usr", "/bin", "/", "/Users", "/Applications"] {
            let path = Path::new(p);
            if path.exists() {
                assert_eq!(
                    validate_trash_target(path, Path::new("/")),
                    Err(SafetyError::Protected),
                    "{p} must be protected"
                );
            }
        }
    }

    #[test]
    fn home_directory_itself_rejected() {
        if let Some(home) = home_dir() {
            if home.exists() {
                assert_eq!(
                    validate_trash_target(&home, Path::new("/")),
                    Err(SafetyError::Protected)
                );
            }
        }
    }
}
