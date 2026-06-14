//! Tauri command surface for disc-solve.
//!
//! Safety posture:
//! - `scan_path` is read-only (see [`scan`]).
//! - `move_to_trash` is the only destructive command. It validates the target
//!   against the *last scanned root* held in app state and moves it to the
//!   macOS Trash (recoverable). It can never be aimed outside what was scanned.

mod actions;
mod backup;
mod category;
mod safety;
mod scan;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, State};

/// Streamed to the frontend as `scan-progress` while a scan runs. The bar shows
/// `bytes / total` (a real, monotonic fraction); `total` is the volume's used bytes.
#[derive(Clone, serde::Serialize)]
struct ScanProgress {
    files: u64,
    bytes: u64,
    total: u64,
}

/// Bytes currently used on the filesystem containing `path`, via statvfs. Returns
/// 0 if it can't be determined (the UI then falls back to a count-only indicator).
fn volume_used_bytes(path: &Path) -> u64 {
    use std::os::unix::ffi::OsStrExt;
    let Ok(cpath) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return 0;
    };
    // SAFETY: cpath is a valid NUL-terminated C string; stat is zero-initialized.
    unsafe {
        let mut stat: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(cpath.as_ptr(), &mut stat) == 0 {
            let frsize = stat.f_frsize as u64;
            let total = stat.f_blocks as u64 * frsize;
            let free = stat.f_bfree as u64 * frsize;
            total.saturating_sub(free)
        } else {
            0
        }
    }
}

/// The root of the most recent scan. `move_to_trash` refuses any target that is
/// not inside this, so the frontend can never ask us to trash an arbitrary path.
#[derive(Default)]
struct AppState {
    scan_root: Mutex<Option<PathBuf>>,
}

#[derive(serde::Serialize)]
struct ScanResult {
    tree: scan::Node,
    files: u64,
    dirs: u64,
    errors: u64,
}

#[tauri::command]
async fn scan_path(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<ScanResult, String> {
    let p = PathBuf::from(&path);
    if !p.is_absolute() {
        return Err("Path must be absolute".into());
    }
    if !p.is_dir() {
        return Err("Path is not a directory".into());
    }
    // Run the (potentially long) parallel scan on a blocking thread so the UI never
    // freezes. A separate poller emits progress ~10x/sec by reading the shared
    // atomics, decoupling event emission from the scan's hot path.
    let target = p.clone();
    let progress = Arc::new(scan::Progress::default());
    let done = Arc::new(AtomicBool::new(false));
    let total = volume_used_bytes(&p);

    let poll_app = app.clone();
    let poll_progress = progress.clone();
    let poll_done = done.clone();
    let poller = std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(100));
        let _ = poll_app.emit(
            "scan-progress",
            ScanProgress {
                files: poll_progress.files.load(Ordering::Relaxed),
                bytes: poll_progress.bytes.load(Ordering::Relaxed),
                total,
            },
        );
        if poll_done.load(Ordering::Relaxed) {
            break;
        }
    });

    let scan_progress = progress.clone();
    let (tree, files, dirs, errors) = tauri::async_runtime::spawn_blocking(move || {
        let mut tree = scan::scan(&target, &scan_progress);
        let min_size = (tree.size / 20_000).max(1_048_576); // >= 1 MB, ~0.005% of total
        scan::prune(&mut tree, min_size, 80);
        (
            tree,
            scan_progress.files.load(Ordering::Relaxed),
            scan_progress.dirs_scanned.load(Ordering::Relaxed),
            scan_progress.errors.load(Ordering::Relaxed),
        )
    })
    .await
    .map_err(|e| e.to_string())?;

    done.store(true, Ordering::Relaxed);
    let _ = poller.join();

    *state.scan_root.lock().unwrap() = Some(p);
    Ok(ScanResult { tree, files, dirs, errors })
}

#[tauri::command]
fn move_to_trash(state: State<AppState>, path: String) -> Result<String, String> {
    let root = state
        .scan_root
        .lock()
        .unwrap()
        .clone()
        .ok_or("Scan a folder before trashing anything")?;
    actions::move_to_trash(&PathBuf::from(path), &root, &actions::SystemTrasher)
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    actions::reveal_in_finder(&PathBuf::from(path))
}

#[tauri::command]
fn open_terminal_here(path: String) -> Result<(), String> {
    actions::open_terminal_here(&PathBuf::from(path))
}

#[tauri::command]
fn quick_look(path: String) -> Result<(), String> {
    actions::quick_look(&PathBuf::from(path))
}

#[tauri::command]
fn time_machine_status() -> backup::TimeMachineStatus {
    backup::time_machine_status()
}

/// Default starting point for the first scan: the user's home directory.
#[tauri::command]
fn home_dir() -> Option<String> {
    std::env::var_os("HOME").map(|h| h.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            scan_path,
            move_to_trash,
            reveal_in_finder,
            open_terminal_here,
            quick_look,
            time_machine_status,
            home_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running disc-solve");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn volume_used_is_positive_for_root() {
        // The boot volume always has some data on it.
        assert!(volume_used_bytes(Path::new("/")) > 0);
    }
}
