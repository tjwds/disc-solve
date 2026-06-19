// Thin wrappers over the Tauri command surface (src-tauri/src/lib.rs).

import { invoke } from "@tauri-apps/api/core";
import type { DupReport, Node, ScanResult, TimeMachineStatus } from "./types";
import type { ImageFile, SortSettings } from "./sort";

/** True when running inside the Tauri shell (vs. a plain browser dev preview). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function scanPath(path: string): Promise<ScanResult> {
  return invoke("scan_path", { path });
}

/** The real, unpruned direct children of a folder from the last scan (one level). */
export function listChildren(path: string): Promise<Node[]> {
  return invoke("list_children", { path });
}

/** Find byte-identical duplicate files in the last scan (hashes contents). */
export function findDuplicates(): Promise<DupReport> {
  return invoke("find_duplicates");
}

export function homeDir(): Promise<string | null> {
  return invoke("home_dir");
}

/** Moves a path to the macOS Trash (recoverable). Guarded on the Rust side. */
export function moveToTrash(path: string): Promise<string> {
  return invoke("move_to_trash", { path });
}

export function revealInFinder(path: string): Promise<void> {
  return invoke("reveal_in_finder", { path });
}

export function openTerminalHere(path: string): Promise<void> {
  return invoke("open_terminal_here", { path });
}

export function quickLook(path: string): Promise<void> {
  return invoke("quick_look", { path });
}

/** Opens the Trash in Finder so the user can empty it themselves. */
export function openTrash(): Promise<void> {
  return invoke("open_trash");
}

export function timeMachineStatus(): Promise<TimeMachineStatus> {
  return invoke("time_machine_status");
}

// ---- "Get organized" sort flow ----

export function loadSettings(): Promise<SortSettings> {
  return invoke("load_settings");
}

export function saveSettings(settings: SortSettings): Promise<void> {
  return invoke("save_settings", { settings });
}

/** Loose images at the top level of each folder, newest first. */
export function listLooseImages(folders: string[]): Promise<ImageFile[]> {
  return invoke("list_loose_images", { folders });
}

/** Move an image into a destination folder; resolves to its new path (for undo). */
export function fileImage(path: string, destDir: string): Promise<string> {
  return invoke("file_image", { path, destDir });
}

/** Import an image into Apple Photos and trash the original; resolves to the
 *  in-Trash path of the original (for undo). */
export function fileToPhotos(path: string): Promise<string> {
  return invoke("file_to_photos", { path });
}

/** Move an image to the Trash; resolves to its in-Trash path (for undo). */
export function sortTrash(path: string): Promise<string> {
  return invoke("sort_trash", { path });
}

/** Undo a file/trash by moving the file from `from` back to `to`. */
export function sortRestore(from: string, to: string): Promise<void> {
  return invoke("sort_restore", { from, to });
}

/** Native folder picker; resolves to the chosen path, or null if cancelled. */
export function chooseFolder(prompt?: string): Promise<string | null> {
  return invoke("choose_folder", { prompt });
}
