//! Read-only, parallel filesystem scanner.
//!
//! SAFETY: this module never writes, never deletes, and never follows symlinks.
//! It only calls [`std::fs::symlink_metadata`] (lstat) and [`std::fs::read_dir`].
//! The `read_only_scan_does_not_mutate` test asserts the invariant.
//!
//! Parallelism: directories are walked concurrently via rayon. Hard-link dedup
//! uses a shared set that is only locked for the (rare) multi-link file, so the
//! common path stays lock-free.

use crate::category::{categorize, Category};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// One node in the size tree. Files have no children; directories aggregate
/// their descendants' on-disk size.
#[derive(Serialize, Clone, Debug)]
pub struct Node {
    pub name: String,
    pub path: String,
    /// On-disk allocation in bytes (512-byte blocks), with hard links counted once.
    pub size: u64,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub category: Category,
    /// Number of files at or below this node (a file is 1).
    pub item_count: u64,
    /// Most recent modification time (unix seconds) at or below this node.
    pub mtime: i64,
    pub children: Vec<Node>,
}

/// Live progress counters, updated across worker threads during a scan. Read
/// them from another thread (e.g. a poller) to drive a progress bar.
/// `dirs_scanned / dirs_discovered` is a self-normalizing progress estimate.
#[derive(Default)]
pub struct Progress {
    pub files: AtomicU64,
    pub bytes: AtomicU64,
    pub dirs_scanned: AtomicU64,
    pub dirs_discovered: AtomicU64,
    pub errors: AtomicU64,
}

/// Receives every regular file as the walk encounters it, so a streaming consumer
/// (duplicate detection) can start work while the walk is still running. Called
/// from many threads at once, hence `Sync`.
pub trait FileSink: Sync {
    fn file(&self, path: &str, size: u64);
}

struct Ctx<'a> {
    seen_inodes: Mutex<HashSet<(u64, u64)>>,
    progress: &'a Progress,
    sink: Option<&'a dyn FileSink>,
}

fn name_of(path: &Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn leaf(path: &Path, size: u64, is_symlink: bool, category: Category, mtime: i64) -> Node {
    Node {
        name: name_of(path),
        path: path.display().to_string(),
        size,
        is_dir: false,
        is_symlink,
        category,
        item_count: 1,
        mtime,
        children: vec![],
    }
}

/// Recursively scan `path` in parallel, reporting each regular file to `sink`
/// (if any) as it is found, so a streaming consumer can run concurrently with
/// the walk. Updates `progress` as it goes and returns a node even on error
/// (size 0), so a single unreadable entry never aborts.
pub fn scan_with_sink(path: &Path, progress: &Progress, sink: Option<&dyn FileSink>) -> Node {
    let ctx = Ctx {
        seen_inodes: Mutex::new(HashSet::new()),
        progress,
        sink,
    };
    walk(path, &ctx)
}

fn walk(path: &Path, ctx: &Ctx) -> Node {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(_) => {
            ctx.progress.errors.fetch_add(1, Ordering::Relaxed);
            return Node {
                name: name_of(path),
                path: path.display().to_string(),
                size: 0,
                is_dir: false,
                is_symlink: false,
                category: Category::Other,
                item_count: 0,
                mtime: 0,
                children: vec![],
            };
        }
    };

    // Symlinks are recorded but never followed: count the link's own size only.
    if meta.file_type().is_symlink() {
        let size = meta.blocks() * 512;
        ctx.progress.files.fetch_add(1, Ordering::Relaxed);
        ctx.progress.bytes.fetch_add(size, Ordering::Relaxed);
        return leaf(path, size, true, Category::Other, meta.mtime());
    }

    if meta.is_dir() {
        ctx.progress.dirs_discovered.fetch_add(1, Ordering::Relaxed);
        let entries: Vec<fs::DirEntry> = match fs::read_dir(path) {
            Ok(rd) => rd.flatten().collect(),
            Err(_) => {
                ctx.progress.errors.fetch_add(1, Ordering::Relaxed);
                Vec::new()
            }
        };
        // Walk the children in parallel; rayon collects them in input order.
        let mut children: Vec<Node> = entries
            .into_par_iter()
            .map(|e| walk(&e.path(), ctx))
            .collect();
        children.sort_by(|a, b| b.size.cmp(&a.size)); // largest first
        let total: u64 = children.iter().map(|c| c.size).sum();
        let count: u64 = children.iter().map(|c| c.item_count).sum();
        // "Last activity" for a directory = the newest mtime at or below it.
        let mtime = children
            .iter()
            .map(|c| c.mtime)
            .max()
            .unwrap_or(0)
            .max(meta.mtime());
        ctx.progress.dirs_scanned.fetch_add(1, Ordering::Relaxed);
        Node {
            name: name_of(path),
            path: path.display().to_string(),
            size: total,
            is_dir: true,
            is_symlink: false,
            category: categorize(path, true),
            item_count: count,
            mtime,
            children,
        }
    } else {
        // Regular file. Count on-disk blocks, deduping hard links by (dev, inode)
        // so a file linked from N places is only counted once.
        let mut size = meta.blocks() * 512;
        if meta.nlink() > 1 {
            let key = (meta.dev(), meta.ino());
            let mut seen = ctx.seen_inodes.lock().unwrap();
            if !seen.insert(key) {
                size = 0; // already counted at the first occurrence
            }
        }
        ctx.progress.files.fetch_add(1, Ordering::Relaxed);
        ctx.progress.bytes.fetch_add(size, Ordering::Relaxed);
        // Build the path string once and hand it to the streaming sink (if any),
        // so duplicate detection can begin hashing this file during the walk.
        let path_str = path.display().to_string();
        if let Some(sink) = ctx.sink {
            sink.file(&path_str, size);
        }
        Node {
            name: name_of(path),
            path: path_str,
            size,
            is_dir: false,
            is_symlink: false,
            category: categorize(path, false),
            item_count: 1,
            mtime: meta.mtime(),
            children: vec![],
        }
    }
}

/// Build a *pruned copy* of a scanned tree for display, leaving the original
/// intact. Within each directory, keep the largest `max_children` entries that
/// are at least `min_size`, and fold everything else into a single synthetic
/// "N smaller items" node (empty path, so it is not actionable). On-disk totals
/// and item counts are preserved exactly. This bounds the node count so the IPC
/// payload and the treemap stay fast.
///
/// The full tree is retained server-side (see [`find_dir`]) so the list view can
/// fetch a folder's complete, unpruned contents one level at a time.
pub fn pruned(node: &Node, min_size: u64, max_children: usize) -> Node {
    let mut order: Vec<&Node> = node.children.iter().collect();
    order.sort_by(|a, b| b.size.cmp(&a.size));

    let mut kept: Vec<Node> = Vec::new();
    let mut dropped_size = 0u64;
    let mut dropped_count = 0u64;
    let mut dropped_mtime = 0i64;
    for (i, child) in order.into_iter().enumerate() {
        if i < max_children && child.size >= min_size {
            kept.push(pruned(child, min_size, max_children));
        } else {
            dropped_size += child.size;
            dropped_count += child.item_count;
            dropped_mtime = dropped_mtime.max(child.mtime);
        }
    }
    if dropped_size > 0 {
        kept.push(Node {
            name: format!("{dropped_count} smaller items"),
            path: String::new(),
            size: dropped_size,
            is_dir: false,
            is_symlink: false,
            category: Category::Other,
            item_count: dropped_count,
            mtime: dropped_mtime,
            children: vec![],
        });
        kept.sort_by(|a, b| b.size.cmp(&a.size));
    }
    Node {
        name: node.name.clone(),
        path: node.path.clone(),
        size: node.size,
        is_dir: node.is_dir,
        is_symlink: node.is_symlink,
        category: node.category,
        item_count: node.item_count,
        mtime: node.mtime,
        children: kept,
    }
}

/// A copy of `node` with its children dropped — one level, for list-view rows.
pub fn shallow(node: &Node) -> Node {
    Node {
        name: node.name.clone(),
        path: node.path.clone(),
        size: node.size,
        is_dir: node.is_dir,
        is_symlink: node.is_symlink,
        category: node.category,
        item_count: node.item_count,
        mtime: node.mtime,
        children: vec![],
    }
}

/// Find the node at `path` within `tree` (exact match), descending by path
/// prefix. Returns `None` if absent. Synthetic aggregates (empty path) are
/// skipped. Used to serve a folder's real children to the list view.
pub fn find_dir<'a>(tree: &'a Node, path: &str) -> Option<&'a Node> {
    if tree.path == path {
        return Some(tree);
    }
    let mut cur = tree;
    loop {
        let next = cur.children.iter().find(|c| {
            !c.path.is_empty() && (c.path == path || path.starts_with(&format!("{}/", c.path)))
        })?;
        if next.path == path {
            return Some(next);
        }
        cur = next;
    }
}

fn recompute(node: &mut Node) {
    node.size = node.children.iter().map(|c| c.size).sum();
    node.item_count = node.children.iter().map(|c| c.item_count).sum();
    node.mtime = node.children.iter().map(|c| c.mtime).max().unwrap_or(node.mtime);
}

/// Remove the node at `path` from `tree`, recomputing each affected ancestor's
/// size/count/mtime. Returns whether something was removed. Mirrors the
/// frontend's `removePaths`, keeping the retained tree consistent after a trash.
pub fn remove_path(tree: &mut Node, path: &str) -> bool {
    let before = tree.children.len();
    tree.children.retain(|c| c.path != path);
    if tree.children.len() != before {
        recompute(tree);
        return true;
    }
    for child in &mut tree.children {
        if !child.path.is_empty() && path.starts_with(&format!("{}/", child.path)) && remove_path(child, path) {
            recompute(tree);
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::fs::File;
    use std::io::Write;
    use std::path::PathBuf;

    /// The tests don't stream files, so scan without a sink.
    fn scan(path: &Path, progress: &Progress) -> Node {
        scan_with_sink(path, progress, None)
    }

    fn write_file(path: &Path, bytes: usize) {
        let mut f = File::create(path).unwrap();
        f.write_all(&vec![b'x'; bytes]).unwrap();
        f.sync_all().unwrap();
    }

    fn snapshot(root: &Path) -> BTreeMap<PathBuf, (u64, std::time::SystemTime)> {
        let mut out = BTreeMap::new();
        fn walk(dir: &Path, root: &Path, out: &mut BTreeMap<PathBuf, (u64, std::time::SystemTime)>) {
            for e in fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                let m = fs::symlink_metadata(&p).unwrap();
                let rel = p.strip_prefix(root).unwrap().to_path_buf();
                out.insert(rel, (m.len(), m.modified().unwrap()));
                if m.is_dir() {
                    walk(&p, root, out);
                }
            }
        }
        walk(root, root, &mut out);
        out
    }

    #[test]
    fn dir_size_is_sum_of_children() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_file(&root.join("a.bin"), 200_000);
        write_file(&root.join("b.bin"), 100_000);
        let sub = root.join("sub");
        fs::create_dir(&sub).unwrap();
        write_file(&sub.join("c.bin"), 50_000);

        let p = Progress::default();
        let tree = scan(root, &p);

        assert!(tree.is_dir);
        let child_sum: u64 = tree.children.iter().map(|c| c.size).sum();
        assert_eq!(tree.size, child_sum);
        assert_eq!(p.files.load(Ordering::Relaxed), 3);
        assert_eq!(tree.item_count, 3);
        assert!(tree.children[0].size >= tree.children[1].size); // largest first
        // dirs: root + sub
        assert_eq!(p.dirs_scanned.load(Ordering::Relaxed), 2);
        assert_eq!(p.dirs_discovered.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn hard_links_counted_once() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let original = root.join("original.bin");
        write_file(&original, 300_000);
        let single = scan(root, &Progress::default()).size;

        fs::hard_link(&original, root.join("link.bin")).unwrap();
        let with_link = scan(root, &Progress::default()).size;

        assert_eq!(single, with_link, "hard link must not be double-counted");
    }

    #[test]
    fn symlinks_are_not_followed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let real = root.join("real");
        fs::create_dir(&real).unwrap();
        write_file(&real.join("big.bin"), 400_000);
        std::os::unix::fs::symlink(&real, root.join("link_to_real")).unwrap();

        let tree = scan(root, &Progress::default());
        let link = tree.children.iter().find(|c| c.name == "link_to_real").unwrap();
        assert!(link.is_symlink);
        assert!(link.children.is_empty(), "symlink must not be traversed");
        assert!(tree.size < 600_000);
    }

    #[test]
    fn read_only_scan_does_not_mutate() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_file(&root.join("a.bin"), 1234);
        let sub = root.join("nested");
        fs::create_dir(&sub).unwrap();
        write_file(&sub.join("b.bin"), 5678);

        let before = snapshot(root);
        let _ = scan(root, &Progress::default());
        let after = snapshot(root);

        assert_eq!(before, after, "scan must not create, delete, or modify anything");
    }

    #[test]
    fn scan_streams_regular_files_to_the_sink() {
        struct Collect(std::sync::Mutex<Vec<(String, u64)>>);
        impl FileSink for Collect {
            fn file(&self, path: &str, size: u64) {
                self.0.lock().unwrap().push((path.to_string(), size));
            }
        }

        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_file(&root.join("a.bin"), 200_000);
        let sub = root.join("sub");
        fs::create_dir(&sub).unwrap();
        write_file(&sub.join("b.bin"), 50_000);

        let sink = Collect(std::sync::Mutex::new(Vec::new()));
        let _ = scan_with_sink(root, &Progress::default(), Some(&sink));

        let mut got = sink.0.into_inner().unwrap();
        got.sort();
        let names: Vec<&str> = got.iter().map(|(p, _)| p.rsplit('/').next().unwrap()).collect();
        assert_eq!(names, vec!["a.bin", "b.bin"], "every regular file is streamed, dirs are not");
    }

    #[test]
    fn missing_path_yields_empty_node_not_panic() {
        let p = Progress::default();
        let node = scan(&PathBuf::from("/definitely/not/a/real/path/xyzzy"), &p);
        assert_eq!(node.size, 0);
        assert_eq!(p.errors.load(Ordering::Relaxed), 1);
    }

    fn synthetic_leaf(name: &str, path: &str, size: u64) -> Node {
        Node {
            name: name.into(),
            path: path.into(),
            size,
            is_dir: false,
            is_symlink: false,
            category: Category::Other,
            item_count: 1,
            mtime: 0,
            children: vec![],
        }
    }

    #[test]
    fn dir_mtime_is_populated_from_descendants() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_file(&root.join("a.bin"), 1000);
        let sub = root.join("sub");
        fs::create_dir(&sub).unwrap();
        write_file(&sub.join("b.bin"), 2000);

        let tree = scan(root, &Progress::default());
        assert!(tree.mtime > 0, "directory mtime should be populated");
        for c in &tree.children {
            assert!(tree.mtime >= c.mtime, "dir mtime must be >= each child's");
        }
    }

    #[test]
    fn pruned_caps_children_and_preserves_total() {
        let kids: Vec<Node> = (1..=10)
            .map(|i| synthetic_leaf(&format!("f{i}"), &format!("/f{i}"), i * 100))
            .collect();
        let total: u64 = kids.iter().map(|c| c.size).sum();
        let root = Node {
            name: "root".into(),
            path: "/".into(),
            size: total,
            is_dir: true,
            is_symlink: false,
            category: Category::Other,
            item_count: 10,
            mtime: 0,
            children: kids,
        };

        let out = pruned(&root, 1, 3);

        assert_eq!(out.children.len(), 4); // 3 kept + 1 aggregate
        let new_total: u64 = out.children.iter().map(|c| c.size).sum();
        assert_eq!(new_total, total, "prune must preserve the total");
        let agg = out.children.iter().find(|c| c.path.is_empty()).unwrap();
        assert_eq!(agg.item_count, 7);
        assert_eq!(root.children.len(), 10, "pruned must not mutate the original");
    }

    // Manual benchmark: `DS_BENCH_DIR=/path cargo test --lib bench_real_dir -- --ignored --nocapture`
    // Vary thread count with RAYON_NUM_THREADS to compare.
    #[test]
    #[ignore]
    fn bench_real_dir() {
        let dir = std::env::var("DS_BENCH_DIR").unwrap_or_else(|_| "/usr".into());
        let start = std::time::Instant::now();
        let p = Progress::default();
        let tree = scan(Path::new(&dir), &p);
        eprintln!(
            "threads={} files={} dirs={} size={}MB elapsed={:?} dir={}",
            rayon::current_num_threads(),
            p.files.load(Ordering::Relaxed),
            p.dirs_scanned.load(Ordering::Relaxed),
            tree.size / 1_048_576,
            start.elapsed(),
            dir,
        );
    }

    #[test]
    fn pruned_folds_sub_threshold_entries() {
        let root = Node {
            name: "root".into(),
            path: "/".into(),
            size: 1005,
            is_dir: true,
            is_symlink: false,
            category: Category::Other,
            item_count: 2,
            mtime: 0,
            children: vec![
                synthetic_leaf("big", "/big", 1000),
                synthetic_leaf("tiny", "/tiny", 5),
            ],
        };

        let out = pruned(&root, 100, 80);

        assert!(out.children.iter().any(|c| c.name == "big"));
        let agg = out.children.iter().find(|c| c.path.is_empty()).unwrap();
        assert_eq!(agg.size, 5);
    }

    fn dir_node(name: &str, path: &str, children: Vec<Node>) -> Node {
        Node {
            name: name.into(),
            path: path.into(),
            size: children.iter().map(|c| c.size).sum(),
            is_dir: true,
            is_symlink: false,
            category: Category::Other,
            item_count: children.iter().map(|c| c.item_count).sum(),
            mtime: children.iter().map(|c| c.mtime).max().unwrap_or(0),
            children,
        }
    }

    #[test]
    fn find_dir_locates_nested_paths() {
        let tree = dir_node(
            "root",
            "/r",
            vec![dir_node(
                "sub",
                "/r/sub",
                vec![synthetic_leaf("a", "/r/sub/a", 10)],
            )],
        );
        assert_eq!(find_dir(&tree, "/r").unwrap().path, "/r");
        assert_eq!(find_dir(&tree, "/r/sub").unwrap().path, "/r/sub");
        assert_eq!(find_dir(&tree, "/r/sub/a").unwrap().path, "/r/sub/a");
        assert!(find_dir(&tree, "/r/nope").is_none());
    }

    #[test]
    fn remove_path_removes_and_recomputes_ancestors() {
        let mut tree = dir_node(
            "root",
            "/r",
            vec![
                synthetic_leaf("a", "/r/a", 100),
                dir_node(
                    "sub",
                    "/r/sub",
                    vec![
                        synthetic_leaf("b", "/r/sub/b", 50),
                        synthetic_leaf("c", "/r/sub/c", 70),
                    ],
                ),
            ],
        );
        assert_eq!(tree.size, 220);

        assert!(remove_path(&mut tree, "/r/sub/b"));
        assert_eq!(tree.size, 170, "ancestors recompute after removal");
        let sub = find_dir(&tree, "/r/sub").unwrap();
        assert_eq!(sub.size, 70);
        assert_eq!(sub.children.len(), 1);

        assert!(!remove_path(&mut tree, "/r/missing"), "absent path removes nothing");
    }
}
