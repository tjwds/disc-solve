//! Classifies a path into a coarse file-type category. The treemap colours cells
//! by this, matching the legend in the UI. Pure and side-effect free.

use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Dev,
    Video,
    Audio,
    Photo,
    Docs,
    Apps,
    System,
    Cache,
    Archive,
    Trash,
    Other,
}

/// Top-level directories that are always part of the OS, not user data.
const SYSTEM_ROOTS: &[&str] = &["/System", "/usr", "/bin", "/sbin", "/private", "/Library", "/opt"];

/// Returns the lowercased final extension of `path`, if any.
fn ext(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
}

/// Does any path component exactly equal `needle`?
fn has_component(path: &Path, needle: &str) -> bool {
    path.components()
        .any(|c| c.as_os_str().to_str() == Some(needle))
}

pub fn categorize(path: &Path, is_dir: bool) -> Category {
    // Order matters: the most specific / structural rules win first.
    if has_component(path, ".Trash") {
        return Category::Trash;
    }

    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if name.ends_with(".app") {
        return Category::Apps;
    }
    // Developer build artifacts: regenerable, the headline "reclaimable" category.
    if has_component(path, "node_modules") || has_component(path, "DerivedData") {
        return Category::Dev;
    }
    if has_component(path, "Caches") || has_component(path, "Cache") {
        return Category::Cache;
    }

    let p = path.to_string_lossy();
    if SYSTEM_ROOTS.iter().any(|root| p.starts_with(root)) {
        return Category::System;
    }

    match ext(path).as_deref() {
        Some(
            "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "c" | "h" | "hpp" | "cpp" | "cc"
            | "java" | "rb" | "swift" | "kt" | "json" | "lock" | "toml" | "yaml" | "yml" | "sh"
            | "wasm" | "o" | "a" | "rlib",
        ) => Category::Dev,
        Some("mov" | "mp4" | "mkv" | "avi" | "m4v" | "webm" | "flv" | "wmv" | "mpg" | "mpeg") => {
            Category::Video
        }
        Some("mp3" | "wav" | "flac" | "aac" | "m4a" | "aiff" | "aif" | "ogg" | "opus") => {
            Category::Audio
        }
        Some(
            "jpg" | "jpeg" | "png" | "gif" | "heic" | "heif" | "tiff" | "tif" | "webp" | "psd"
            | "raw" | "cr2" | "nef" | "arw" | "svg" | "bmp" | "ico",
        ) => Category::Photo,
        Some(
            "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "md" | "rtf"
            | "pages" | "key" | "numbers" | "csv" | "epub",
        ) => Category::Docs,
        Some("zip" | "tar" | "gz" | "bz2" | "xz" | "zst" | "dmg" | "pkg" | "7z" | "rar" | "tgz") => {
            Category::Archive
        }
        _ => {
            let _ = is_dir; // categorisation is the same for unknown files and plain dirs
            Category::Other
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn cat(p: &str, is_dir: bool) -> Category {
        categorize(&PathBuf::from(p), is_dir)
    }

    #[test]
    fn trash_wins_over_everything() {
        assert_eq!(cat("/Users/me/.Trash/old.mov", false), Category::Trash);
    }

    #[test]
    fn app_bundles() {
        assert_eq!(cat("/Applications/Figma.app", true), Category::Apps);
    }

    #[test]
    fn dev_build_artifacts() {
        assert_eq!(cat("/Users/me/proj/node_modules/react/index.js", false), Category::Dev);
        assert_eq!(cat("/Users/me/Library/Developer/Xcode/DerivedData/x", true), Category::Dev);
    }

    #[test]
    fn caches() {
        assert_eq!(cat("/Users/me/Library/Caches/com.apple.Safari/x", false), Category::Cache);
    }

    #[test]
    fn system_roots() {
        assert_eq!(cat("/System/Library/Fonts/SF.ttf", false), Category::System);
        assert_eq!(cat("/usr/lib/x.dylib", false), Category::System);
    }

    #[test]
    fn by_extension() {
        assert_eq!(cat("/Users/me/clip.mov", false), Category::Video);
        assert_eq!(cat("/Users/me/song.flac", false), Category::Audio);
        assert_eq!(cat("/Users/me/pic.HEIC", false), Category::Photo);
        assert_eq!(cat("/Users/me/report.pdf", false), Category::Docs);
        assert_eq!(cat("/Users/me/backup.zip", false), Category::Archive);
        assert_eq!(cat("/Users/me/main.rs", false), Category::Dev);
    }

    #[test]
    fn unknown_is_other() {
        assert_eq!(cat("/Users/me/mystery.qqq", false), Category::Other);
        assert_eq!(cat("/Users/me/somedir", true), Category::Other);
    }
}
