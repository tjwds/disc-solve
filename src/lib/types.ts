// Mirrors the serde-serialized types from the Rust side (src-tauri/src/scan.rs etc.).

export type Category =
  | "dev"
  | "video"
  | "audio"
  | "photo"
  | "docs"
  | "apps"
  | "system"
  | "cache"
  | "archive"
  | "trash"
  | "other";

export interface Node {
  name: string;
  path: string;
  /** On-disk bytes, hard links counted once. */
  size: number;
  is_dir: boolean;
  is_symlink: boolean;
  category: Category;
  item_count: number;
  /** Most recent modification time (unix seconds) at or below this node. */
  mtime: number;
  children: Node[];
}

export interface ScanResult {
  tree: Node;
  files: number;
  dirs: number;
  errors: number;
}

export interface TimeMachineStatus {
  local_snapshots: number;
  latest_backup: string | null;
}
