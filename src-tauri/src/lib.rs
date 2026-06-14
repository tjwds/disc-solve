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

/// State from the most recent scan. `move_to_trash` refuses any target that is
/// not inside `scan_root`, so the frontend can never ask us to trash an arbitrary
/// path. `tree` retains the full, unpruned scan so the list view can fetch a
/// folder's complete contents (the treemap gets a pruned copy over IPC).
#[derive(Default)]
struct AppState {
    scan_root: Mutex<Option<PathBuf>>,
    tree: Mutex<Option<scan::Node>>,
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
    let (full, files, dirs, errors) = tauri::async_runtime::spawn_blocking(move || {
        let full = scan::scan(&target, &scan_progress);
        (
            full,
            scan_progress.files.load(Ordering::Relaxed),
            scan_progress.dirs_scanned.load(Ordering::Relaxed),
            scan_progress.errors.load(Ordering::Relaxed),
        )
    })
    .await
    .map_err(|e| e.to_string())?;

    done.store(true, Ordering::Relaxed);
    let _ = poller.join();

    // Pruned copy crosses to the UI for the treemap; the full tree stays here so
    // the list view can request any folder's complete contents.
    let min_size = (full.size / 20_000).max(1_048_576); // >= 1 MB, ~0.005% of total
    let tree = scan::pruned(&full, min_size, 80);
    *state.tree.lock().unwrap() = Some(full);
    *state.scan_root.lock().unwrap() = Some(p);
    Ok(ScanResult { tree, files, dirs, errors })
}

/// Returns the real, unpruned direct children of the directory at `path` from the
/// retained scan (one level, children stripped) for the list view. Read-only.
#[tauri::command]
fn list_children(state: State<AppState>, path: String) -> Result<Vec<scan::Node>, String> {
    let guard = state.tree.lock().unwrap();
    let tree = guard.as_ref().ok_or("Scan a folder first")?;
    let dir = scan::find_dir(tree, &path).ok_or("Folder not found in the last scan")?;
    Ok(dir.children.iter().map(scan::shallow).collect())
}

#[tauri::command]
fn move_to_trash(state: State<AppState>, path: String) -> Result<String, String> {
    let root = state
        .scan_root
        .lock()
        .unwrap()
        .clone()
        .ok_or("Scan a folder before trashing anything")?;
    let result = actions::move_to_trash(&PathBuf::from(&path), &root, &actions::SystemTrasher)?;
    // Keep the retained tree in sync so a re-fetched list reflects the removal.
    if let Some(tree) = state.tree.lock().unwrap().as_mut() {
        scan::remove_path(tree, &path);
    }
    Ok(result)
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

/// Opens the user's Trash in Finder so they can review and empty it themselves.
/// The app never empties the Trash or hard-deletes anything.
#[tauri::command]
fn open_trash() -> Result<(), String> {
    let home = std::env::var_os("HOME").ok_or("Could not locate the home directory")?;
    actions::open_path(&PathBuf::from(home).join(".Trash"))
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
            list_children,
            move_to_trash,
            reveal_in_finder,
            open_terminal_here,
            quick_look,
            open_trash,
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
