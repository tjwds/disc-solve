//! Duplicate-file detection over a scanned tree.
//!
//! Strategy: files can only be identical if they have the same size, so we
//! bucket candidates by on-disk size first (free — the scan already measured
//! them) and only read the contents of files that share a size with another.
//! Those are BLAKE3-hashed; files with the same `(size, hash)` are duplicates.
//!
//! SAFETY: like the scanner, this never writes or deletes. It does, however,
//! read file *contents* (the scanner only `lstat`s), which it opens read-only.
//! Symlinks, directories, and the synthetic "N smaller items" aggregates are
//! skipped. Hard links to one inode are collapsed to a single member, so they
//! are never reported as reclaimable duplicates.
//!
//! BLAKE3 is cryptographic, so a hash match means the files are identical — we
//! never group distinct files together (which would drive a bogus delete
//! suggestion). The reverse error (missing a real duplicate) is the only one
//! possible here, and it is harmless.

use crate::scan::Node;
use rayon::prelude::*;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::sync::atomic::{AtomicU64, Ordering};

/// Ignore files smaller than this. The sub-megabyte long tail (config files,
/// tiny assets duplicated across node_modules, etc.) reclaims little and would
/// dominate hashing time.
pub const MIN_DUP_SIZE: u64 = 1 << 20; // 1 MiB

/// Live counters for the `dup-progress` event.
#[derive(Default)]
pub struct DupProgress {
    pub hashed: AtomicU64,
    pub total: AtomicU64,
    pub bytes: AtomicU64,
}

/// One set of byte-identical files. `size` is the on-disk size of each copy;
/// reclaiming all but one frees `reclaimable` bytes.
#[derive(Serialize, Clone, Debug)]
pub struct DupGroup {
    pub size: u64,
    pub paths: Vec<String>,
    pub reclaimable: u64,
}

/// The result of a duplicate scan, largest reclaim first.
#[derive(Serialize, Clone, Default, Debug)]
pub struct DupReport {
    pub groups: Vec<DupGroup>,
    pub reclaimable: u64,
    pub hashed: u64,
}

/// Bucket eligible files by on-disk size. Only reads the in-memory tree; the
/// caller holds it under a lock and releases it before the (slow) hashing.
pub fn collect(tree: &Node, min_size: u64) -> HashMap<u64, Vec<String>> {
    let mut by_size: HashMap<u64, Vec<String>> = HashMap::new();
    fn visit(n: &Node, min_size: u64, by_size: &mut HashMap<u64, Vec<String>>) {
        if n.children.is_empty() {
            if !n.is_dir && !n.is_symlink && !n.path.is_empty() && n.size >= min_size {
                by_size.entry(n.size).or_default().push(n.path.clone());
            }
        } else {
            for c in &n.children {
                visit(c, min_size, by_size);
            }
        }
    }
    visit(tree, min_size, &mut by_size);
    by_size
}

/// Open a file read-only and BLAKE3-hash its contents, returning `(inode, hash)`.
/// Bails (returns `None`) if the generation moved on mid-read, so a superseded
/// scan stops promptly instead of finishing a multi-gigabyte read.
fn hash_file(path: &str, gen: &AtomicU64, mine: u64, progress: &DupProgress) -> Option<(u64, [u8; 32])> {
    let mut file = File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() {
        return None;
    }
    let inode = meta.ino();
    let mut hasher = blake3::Hasher::new();
    let mut buf = [0u8; 1 << 16];
    loop {
        if gen.load(Ordering::Relaxed) != mine {
            return None; // a newer scan started
        }
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        progress.bytes.fetch_add(n as u64, Ordering::Relaxed);
    }
    progress.hashed.fetch_add(1, Ordering::Relaxed);
    Some((inode, *hasher.finalize().as_bytes()))
}

/// Hash every file in a multi-file size bucket and group byte-identical ones.
/// `gen`/`mine` gate cancellation: if `gen` no longer equals `mine`, the run is
/// abandoned and an empty report returned.
pub fn find(
    by_size: HashMap<u64, Vec<String>>,
    gen: &AtomicU64,
    mine: u64,
    progress: &DupProgress,
) -> DupReport {
    // Candidates are files that share their size with at least one other.
    let candidates: Vec<(String, u64)> = by_size
        .into_iter()
        .filter(|(_, paths)| paths.len() >= 2)
        .flat_map(|(size, paths)| paths.into_iter().map(move |p| (p, size)))
        .collect();
    progress.total.store(candidates.len() as u64, Ordering::Relaxed);

    let hashed: Vec<(String, u64, u64, [u8; 32])> = candidates
        .par_iter()
        .filter_map(|(path, size)| {
            hash_file(path, gen, mine, progress).map(|(inode, hash)| (path.clone(), *size, inode, hash))
        })
        .collect();

    if gen.load(Ordering::Relaxed) != mine {
        return DupReport::default(); // superseded
    }

    // Group by (size, content hash); within a group collapse hard links by inode.
    let mut by_key: HashMap<(u64, [u8; 32]), Vec<(String, u64)>> = HashMap::new();
    for (path, size, inode, hash) in hashed {
        by_key.entry((size, hash)).or_default().push((path, inode));
    }

    let mut groups: Vec<DupGroup> = Vec::new();
    let mut reclaimable = 0u64;
    for ((size, _hash), mut members) in by_key {
        let mut seen_inodes = HashSet::new();
        members.retain(|(_, inode)| seen_inodes.insert(*inode));
        if members.len() < 2 {
            continue;
        }
        let mut paths: Vec<String> = members.into_iter().map(|(p, _)| p).collect();
        paths.sort();
        let reclaim = size * (paths.len() as u64 - 1);
        reclaimable += reclaim;
        groups.push(DupGroup { size, paths, reclaimable: reclaim });
    }
    groups.sort_by(|a, b| b.reclaimable.cmp(&a.reclaimable).then(b.size.cmp(&a.size)));

    DupReport {
        groups,
        reclaimable,
        hashed: progress.hashed.load(Ordering::Relaxed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::category::Category;
    use std::fs;
    use std::io::Write;
    use std::path::Path;

    fn write(path: &Path, bytes: &[u8]) {
        let mut f = File::create(path).unwrap();
        f.write_all(bytes).unwrap();
        f.sync_all().unwrap();
    }

    fn leaf(path: &str, size: u64) -> Node {
        Node {
            name: path.rsplit('/').next().unwrap_or(path).into(),
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

    fn dir(path: &str, children: Vec<Node>) -> Node {
        Node {
            name: path.rsplit('/').next().unwrap_or(path).into(),
            path: path.into(),
            size: children.iter().map(|c| c.size).sum(),
            is_dir: true,
            is_symlink: false,
            category: Category::Other,
            item_count: children.iter().map(|c| c.item_count).sum(),
            mtime: 0,
            children,
        }
    }

    #[test]
    fn collect_buckets_by_size_skipping_small_dirs_and_aggregates() {
        let mut agg = leaf("", 5_000_000);
        agg.path = String::new(); // synthetic aggregate
        let tree = dir(
            "/r",
            vec![
                leaf("/r/a", 2_000_000),
                leaf("/r/b", 2_000_000),
                leaf("/r/c", 9_000_000),
                leaf("/r/tiny", 10), // below min
                dir("/r/sub", vec![leaf("/r/sub/d", 2_000_000)]),
                agg,
            ],
        );
        let by_size = collect(&tree, MIN_DUP_SIZE);
        assert_eq!(by_size[&2_000_000].len(), 3); // a, b, sub/d
        assert_eq!(by_size[&9_000_000].len(), 1);
        assert!(!by_size.contains_key(&10)); // tiny filtered out
    }

    #[test]
    fn find_groups_identical_files_and_ignores_unique_and_distinct() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dup = vec![b'x'; 1_500_000];
        let other = {
            let mut v = vec![b'x'; 1_500_000];
            *v.last_mut().unwrap() = b'y'; // same size, different content
            v
        };
        write(&root.join("a.bin"), &dup);
        write(&root.join("b.bin"), &dup);
        write(&root.join("c.bin"), &other);
        write(&root.join("solo.bin"), &vec![b'z'; 2_500_000]);

        let pa = root.join("a.bin").display().to_string();
        let pb = root.join("b.bin").display().to_string();
        let pc = root.join("c.bin").display().to_string();
        let solo = root.join("solo.bin").display().to_string();
        let mut by_size: HashMap<u64, Vec<String>> = HashMap::new();
        by_size.insert(1_500_000, vec![pa.clone(), pb.clone(), pc.clone()]);
        by_size.insert(2_500_000, vec![solo]); // unique size, never hashed

        let gen = AtomicU64::new(1);
        let report = find(by_size, &gen, 1, &DupProgress::default());

        assert_eq!(report.groups.len(), 1, "only a.bin/b.bin are identical");
        let g = &report.groups[0];
        assert_eq!(g.paths, vec![pa, pb]);
        assert_eq!(g.size, 1_500_000);
        assert_eq!(g.reclaimable, 1_500_000);
        assert_eq!(report.reclaimable, 1_500_000);
        assert_eq!(report.hashed, 3); // a, b, c (solo skipped)
    }

    #[test]
    fn find_collapses_hard_links_to_one_member() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let data = vec![b'k'; 1_200_000];
        write(&root.join("orig.bin"), &data);
        fs::hard_link(root.join("orig.bin"), root.join("link.bin")).unwrap();
        write(&root.join("copy.bin"), &data); // a genuine separate copy

        let p = |n: &str| root.join(n).display().to_string();
        let mut by_size: HashMap<u64, Vec<String>> = HashMap::new();
        by_size.insert(1_200_000, vec![p("orig.bin"), p("link.bin"), p("copy.bin")]);

        let gen = AtomicU64::new(7);
        let report = find(by_size, &gen, 7, &DupProgress::default());

        assert_eq!(report.groups.len(), 1);
        // orig and link share an inode -> one member; copy is the second.
        assert_eq!(report.groups[0].paths.len(), 2);
        assert_eq!(report.groups[0].reclaimable, 1_200_000);
    }

    #[test]
    fn find_bails_when_generation_moves_on() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let data = vec![b'q'; 1_100_000];
        write(&root.join("a.bin"), &data);
        write(&root.join("b.bin"), &data);
        let p = |n: &str| root.join(n).display().to_string();
        let mut by_size: HashMap<u64, Vec<String>> = HashMap::new();
        by_size.insert(1_100_000, vec![p("a.bin"), p("b.bin")]);

        let gen = AtomicU64::new(2);
        let report = find(by_size, &gen, 1, &DupProgress::default()); // mine != gen
        assert!(report.groups.is_empty(), "a superseded run reports nothing");
    }
}
