# disc-solve

A modern, open-source disk-usage steward for macOS — the spiritual successor to
Disk Inventory X, with organization and backup awareness. Built on
[Tauri](https://tauri.app/) (Rust backend, React/TypeScript frontend).

![disc-solve's treemap view: a colour-coded map of disk usage, with a dashboard sidebar showing the type breakdown, Time Machine status, and reclaimable suggestions](./assets/disc-solve.png)

A recommendation opens as a filtered, sortable list — here, every project's
`node_modules` across the disk, with on-disk size, item count, and how stale each
one is, ready to move to the Trash:

![disc-solve's list view filtered to node_modules folders, with size bars and last-modified staleness](./assets/list-view.png)

Duplicate detection runs on a background thread after the tree is on screen, then
groups byte-identical files so you can keep one copy and reclaim the rest:

![disc-solve's duplicates view: groups of identical files, each with a suggested copy to keep and the extras ready to trash](./assets/duplicates.png)

> The screenshots above are generated from fabricated demo data (`makeDemoTree`
> in `src/lib/demo.ts`) — never a real disk — by `npm run screenshot`, which
> builds the UI, serves it, and captures it with headless Chrome. See
> [`scripts/screenshot.sh`](./scripts/screenshot.sh).

## Safety

The app is read-only by default and treats deletion with caution:

- The scanner only calls `lstat` (`std::fs::symlink_metadata`) and `read_dir`. It
  never opens files for writing, never deletes, and never follows symlinks. A test
  (`read_only_scan_does_not_mutate`) asserts a scan leaves every file untouched.
- Duplicate detection (`dups.rs`) is the one place that opens files — read-only, to
  hash their contents. It still never writes or deletes, and reports a duplicate only
  when a cryptographic (BLAKE3) hash matches, so distinct files are never grouped
  together. Hard links to one inode are collapsed, not reported as reclaimable.
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
- `src-tauri/src/dups.rs` — duplicate detection: size-bucket from the retained scan,
  then BLAKE3-hash only files that share a size. Runs on a background thread (after
  the tree renders), emits `dup-progress`, and cancels if a new scan starts.
- `src/lib/treemap.ts` — squarified treemap layout (pure, tested).
- `src/lib/suggestions.ts` — per-category totals and reclaimable suggestions from a scan.
- `src/lib/listview.ts` — list-view sorting and recommendation filters. The treemap
  payload is pruned for size, but the backend retains the full scan so the list view
  fetches any folder's complete contents on demand (`list_children`).
- `src/lib/dups.ts` — duplicates presentation: suggested keeper per group, and keeping
  the report consistent after copies are trashed.
- `src/App.tsx` — the UI: sidebar dashboard, drill-down treemap, breadcrumb, inspector,
  the filtered list view, and the duplicates view.

## License

MIT — see [LICENSE](./LICENSE).
