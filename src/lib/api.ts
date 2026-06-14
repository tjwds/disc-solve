// Thin wrappers over the Tauri command surface (src-tauri/src/lib.rs).

import { invoke } from "@tauri-apps/api/core";
import type { ScanResult, TimeMachineStatus } from "./types";

/** True when running inside the Tauri shell (vs. a plain browser dev preview). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function scanPath(path: string): Promise<ScanResult> {
  return invoke("scan_path", { path });
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

export function timeMachineStatus(): Promise<TimeMachineStatus> {
  return invoke("time_machine_status");
}
