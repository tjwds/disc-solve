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

struct Ctx<'a> {
    seen_inodes: Mutex<HashSet<(u64, u64)>>,
    progress: &'a Progress,
}

fn name_of(path: &Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn leaf(path: &Path, size: u64, is_symlink: bool, category: Category) -> Node {
    Node {
        name: name_of(path),
        path: path.display().to_string(),
        size,
        is_dir: false,
        is_symlink,
        category,
        item_count: 1,
        children: vec![],
    }
}

/// Recursively scan `path` in parallel, updating `progress` as it goes. Returns
/// a node even on error (size 0) so a single unreadable entry never aborts.
pub fn scan(path: &Path, progress: &Progress) -> Node {
    let ctx = Ctx {
        seen_inodes: Mutex::new(HashSet::new()),
        progress,
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
                children: vec![],
            };
        }
    };

    // Symlinks are recorded but never followed: count the link's own size only.
    if meta.file_type().is_symlink() {
        let size = meta.blocks() * 512;
        ctx.progress.files.fetch_add(1, Ordering::Relaxed);
        ctx.progress.bytes.fetch_add(size, Ordering::Relaxed);
        return leaf(path, size, true, Category::Other);
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
        ctx.progress.dirs_scanned.fetch_add(1, Ordering::Relaxed);
        Node {
            name: name_of(path),
            path: path.display().to_string(),
            size: total,
            is_dir: true,
            is_symlink: false,
            category: categorize(path, true),
            item_count: count,
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
        leaf(path, size, false, categorize(path, false))
    }
}

/// Collapse a scanned tree for display. Within each directory, keep the largest
/// `max_children` entries that are at least `min_size`, and fold everything else
/// into a single synthetic "N smaller items" node (with an empty path, so it is
/// not actionable). On-disk totals and item counts are preserved exactly. This
/// bounds the node count so the IPC payload and the treemap stay fast.
pub fn prune(node: &mut Node, min_size: u64, max_children: usize) {
    if node.children.is_empty() {
        return;
    }
    node.children.sort_by(|a, b| b.size.cmp(&a.size));
    let mut kept: Vec<Node> = Vec::new();
    let mut dropped_size = 0u64;
    let mut dropped_count = 0u64;
    for (i, child) in std::mem::take(&mut node.children).into_iter().enumerate() {
        if i < max_children && child.size >= min_size {
            kept.push(child);
        } else {
            dropped_size += child.size;
            dropped_count += child.item_count;
        }
    }
    for child in kept.iter_mut() {
        prune(child, min_size, max_children);
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
            children: vec![],
        });
        kept.sort_by(|a, b| b.size.cmp(&a.size));
    }
    node.children = kept;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::fs::File;
    use std::io::Write;
    use std::path::PathBuf;

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
            children: vec![],
        }
    }

    #[test]
    fn prune_caps_children_and_preserves_total() {
        let kids: Vec<Node> = (1..=10)
            .map(|i| synthetic_leaf(&format!("f{i}"), &format!("/f{i}"), i * 100))
            .collect();
        let total: u64 = kids.iter().map(|c| c.size).sum();
        let mut root = Node {
            name: "root".into(),
            path: "/".into(),
            size: total,
            is_dir: true,
            is_symlink: false,
            category: Category::Other,
            item_count: 10,
            children: kids,
        };

        prune(&mut root, 1, 3);

        assert_eq!(root.children.len(), 4); // 3 kept + 1 aggregate
        let new_total: u64 = root.children.iter().map(|c| c.size).sum();
        assert_eq!(new_total, total, "prune must preserve the total");
        let agg = root.children.iter().find(|c| c.path.is_empty()).unwrap();
        assert_eq!(agg.item_count, 7);
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
    fn prune_folds_sub_threshold_entries() {
        let mut root = Node {
            name: "root".into(),
            path: "/".into(),
            size: 1005,
            is_dir: true,
            is_symlink: false,
            category: Category::Other,
            item_count: 2,
            children: vec![
                synthetic_leaf("big", "/big", 1000),
                synthetic_leaf("tiny", "/tiny", 5),
            ],
        };

        prune(&mut root, 100, 80);

        assert!(root.children.iter().any(|c| c.name == "big"));
        let agg = root.children.iter().find(|c| c.path.is_empty()).unwrap();
        assert_eq!(agg.size, 5);
    }
}
