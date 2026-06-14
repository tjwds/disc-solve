# disc-solve

A modern, open-source disk-usage steward for macOS — the spiritual successor to
Disk Inventory X, with organization and backup awareness. Built on
[Tauri](https://tauri.app/) (Rust backend, React/TypeScript frontend).

## Safety

The app is read-only by default and treats deletion with caution:

- The scanner only calls `lstat` (`std::fs::symlink_metadata`) and `read_dir`. It
  never opens files for writing, never deletes, and never follows symlinks. A test
  (`read_only_scan_does_not_mutate`) asserts a scan leaves every file untouched.
- The **only** deletion path is "Move to Trash", which goes through the macOS Trash
  (recoverable) via the `trash` crate — never `std::fs::remove_*`.
- Every trash target passes [`safety::validate_trash_target`] first, which refuses
  anything that is not inside the scanned folder, plus system locations, the home
  directory, container roots, and symlinks. The guard is exhaustively unit-tested,
  and `move_to_trash` is structured so an invalid target never reaches the trasher.

## Develop

Requires Node and a Rust toolchain.

```sh
npm install
npm run tauri dev      # run the app
```

## Test

```sh
npm test                       # frontend logic (treemap, formatting, suggestions)
cargo test --manifest-path src-tauri/Cargo.toml   # scanner, safety guard, actions
```

## Architecture

- `src-tauri/src/scan.rs` — read-only parallel scanner (rayon); on-disk size via
  512-byte blocks, hard links counted once by `(dev, inode)`, symlinks recorded but
  not followed. Exposes live `Progress` atomics (`dirs_scanned / dirs_discovered`) that
  the scan command polls to emit a `scan-progress` event for the UI's progress bar.
- `src-tauri/src/safety.rs` — the deletion guard.
- `src-tauri/src/actions.rs` — Reveal in Finder, Open Terminal Here, Quick Look, and
  the guarded Move to Trash (with a mockable `Trasher` so tests never touch real files).
- `src-tauri/src/category.rs` — file-type classification used for treemap colors.
- `src-tauri/src/backup.rs` — Time Machine snapshot/last-backup reporting via `tmutil`.
- `src/lib/treemap.ts` — squarified treemap layout (pure, tested).
- `src/lib/suggestions.ts` — per-category totals and reclaimable suggestions from a scan.
- `src/App.tsx` — the UI: sidebar dashboard, drill-down treemap, breadcrumb, inspector.

## License

MIT — see [LICENSE](./LICENSE).
