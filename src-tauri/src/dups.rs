//! Duplicate-file detection, streamed concurrently with the disk scan.
//!
//! Files can only be identical if they have the same size, so the scan feeds
//! every file into a [`Pipeline`] which buckets by on-disk size. The moment a
//! size bucket gains a second member, those files become candidates and are
//! BLAKE3-hashed by a small pool of worker threads — so hashing overlaps the
//! walk instead of waiting for it to finish. Files with the same `(size, hash)`
//! are duplicates.
//!
//! SAFETY: like the scanner, this never writes or deletes. It does read file
//! *contents* (opened read-only) to hash them. BLAKE3 is cryptographic, so a
//! hash match means the files are identical — distinct files are never grouped
//! (which would drive a bogus delete suggestion). Hard links are excluded for
//! free: the scanner zeroes the size of every link after the first, so only one
//! path per inode ever clears `MIN_DUP_SIZE` and reaches the pipeline.

use crate::category;
use crate::scan::FileSink;
use crossbeam_channel::{unbounded, Sender};
use serde::Serialize;
use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

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

/// Open a file read-only and BLAKE3-hash its contents. Bails (returns `None`) if
/// the generation moves on mid-read, so a superseded scan stops promptly instead
/// of finishing a multi-gigabyte read.
fn hash_contents(path: &str, gen: &AtomicU64, mine: u64, progress: &DupProgress) -> Option<[u8; 32]> {
    let mut file = File::open(path).ok()?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = [0u8; 1 << 16];
    loop {
        if gen.load(Ordering::Relaxed) != mine {
            return None;
        }
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        progress.bytes.fetch_add(n as u64, Ordering::Relaxed);
    }
    progress.hashed.fetch_add(1, Ordering::Relaxed);
    Some(*hasher.finalize().as_bytes())
}

/// How many worker threads hash file contents. Kept modest so the concurrent
/// disk walk's metadata I/O stays responsive.
fn worker_count() -> usize {
    std::thread::available_parallelism()
        .map(|n| (n.get() / 2).clamp(2, 4))
        .unwrap_or(2)
}

/// What the scan feeds the pipeline: a per-size bucket is `Pending` until a
/// second file of that size arrives, at which point both (and every later one)
/// are hashed.
enum Bucket {
    Pending(String),
    Active,
}

/// The streaming duplicate-detection job for one scan. Created before the walk,
/// fed via [`Pipeline::sink`], and finalized by [`Pipeline::finish`] once the
/// walk has ended (which closes the input and drains the hashers).
pub struct Pipeline {
    coordinator: Mutex<Option<JoinHandle<()>>>,
    workers: Mutex<Vec<JoinHandle<()>>>,
    results: Arc<Mutex<Vec<(u64, [u8; 32], String)>>>,
    progress: Arc<DupProgress>,
}

/// The scan's view of the pipeline. Dropping it (when the walk ends) closes the
/// file stream, so the coordinator and workers wind down.
pub struct PipeSink {
    tx: Sender<(String, u64)>,
    min_size: u64,
}

impl FileSink for PipeSink {
    fn file(&self, path: &str, size: u64) {
        // Skip files already in the Trash: they're on their way out, so listing
        // them as reclaimable duplicates (or counting one against a live copy)
        // would be redundant. The size pre-filter runs first as it's cheaper.
        if size >= self.min_size && !category::in_trash(Path::new(path)) {
            let _ = self.tx.send((path.to_string(), size));
        }
    }
}

impl Pipeline {
    /// Spin up the coordinator and hash workers. `gen`/`mine` gate cancellation:
    /// if `gen` no longer equals `mine`, the workers stop hashing.
    pub fn start(
        gen: Arc<AtomicU64>,
        mine: u64,
        min_size: u64,
        progress: Arc<DupProgress>,
    ) -> (Arc<Pipeline>, PipeSink) {
        let (file_tx, file_rx) = unbounded::<(String, u64)>();
        let (hash_tx, hash_rx) = unbounded::<(String, u64)>();
        let results = Arc::new(Mutex::new(Vec::new()));

        let mut workers = Vec::new();
        for _ in 0..worker_count() {
            let rx = hash_rx.clone();
            let results = results.clone();
            let progress = progress.clone();
            let gen = gen.clone();
            workers.push(std::thread::spawn(move || {
                for (path, size) in rx.iter() {
                    if gen.load(Ordering::Relaxed) != mine {
                        continue; // superseded: drain without reading files
                    }
                    if let Some(hash) = hash_contents(&path, &gen, mine, &progress) {
                        results.lock().unwrap().push((size, hash, path));
                    }
                }
            }));
        }
        drop(hash_rx); // only the workers' clones remain

        let coord_progress = progress.clone();
        let coordinator = std::thread::spawn(move || {
            let mut by_size: HashMap<u64, Bucket> = HashMap::new();
            for (path, size) in file_rx.iter() {
                match by_size.entry(size) {
                    Entry::Vacant(e) => {
                        e.insert(Bucket::Pending(path));
                    }
                    Entry::Occupied(mut e) => {
                        if let Bucket::Pending(first) = std::mem::replace(e.get_mut(), Bucket::Active) {
                            coord_progress.total.fetch_add(2, Ordering::Relaxed);
                            let _ = hash_tx.send((first, size));
                            let _ = hash_tx.send((path, size));
                        } else {
                            coord_progress.total.fetch_add(1, Ordering::Relaxed);
                            let _ = hash_tx.send((path, size));
                        }
                    }
                }
            }
            // Input closed: no more candidates, let the workers finish.
            drop(hash_tx);
        });

        let pipeline = Arc::new(Pipeline {
            coordinator: Mutex::new(Some(coordinator)),
            workers: Mutex::new(workers),
            results,
            progress,
        });
        (pipeline, PipeSink { tx: file_tx, min_size })
    }

    /// The live progress counters (for the `dup-progress` poller).
    pub fn progress(&self) -> Arc<DupProgress> {
        self.progress.clone()
    }

    /// Wait for the streamed hashing to finish and assemble the report. Call once
    /// the scan walk has ended (its sink dropped), so the input stream is closed.
    pub fn finish(&self) -> DupReport {
        if let Some(h) = self.coordinator.lock().unwrap().take() {
            let _ = h.join();
        }
        for h in self.workers.lock().unwrap().drain(..) {
            let _ = h.join();
        }

        let results = std::mem::take(&mut *self.results.lock().unwrap());
        let mut by_key: HashMap<(u64, [u8; 32]), Vec<String>> = HashMap::new();
        for (size, hash, path) in results {
            by_key.entry((size, hash)).or_default().push(path);
        }

        let mut groups: Vec<DupGroup> = Vec::new();
        let mut reclaimable = 0u64;
        for ((size, _hash), mut paths) in by_key {
            if paths.len() < 2 {
                continue;
            }
            paths.sort();
            let reclaim = size * (paths.len() as u64 - 1);
            reclaimable += reclaim;
            groups.push(DupGroup { size, paths, reclaimable: reclaim });
        }
        groups.sort_by(|a, b| b.reclaimable.cmp(&a.reclaimable).then(b.size.cmp(&a.size)));

        DupReport {
            groups,
            reclaimable,
            hashed: self.progress.hashed.load(Ordering::Relaxed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::Path;

    fn write(path: &Path, bytes: &[u8]) {
        let mut f = File::create(path).unwrap();
        f.write_all(bytes).unwrap();
        f.sync_all().unwrap();
    }

    /// Push files through the pipeline the way the scan would, then finish.
    fn run(files: &[(String, u64)], gen: u64, mine: u64) -> DupReport {
        let generation = Arc::new(AtomicU64::new(gen));
        let progress = Arc::new(DupProgress::default());
        let (pipeline, sink) = Pipeline::start(generation, mine, 1, progress); // min_size 1 for tiny test files
        for (path, size) in files {
            sink.file(path, *size);
        }
        drop(sink); // close the stream
        pipeline.finish()
    }

    #[test]
    fn groups_identical_files_streamed_through() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dup = vec![b'x'; 4000];
        let mut other = vec![b'x'; 4000];
        *other.last_mut().unwrap() = b'y'; // same size, different content
        write(&root.join("a.bin"), &dup);
        write(&root.join("b.bin"), &dup);
        write(&root.join("c.bin"), &other);
        write(&root.join("solo.bin"), &vec![b'z'; 9000]);

        let p = |n: &str| root.join(n).display().to_string();
        let report = run(
            &[
                (p("a.bin"), 4000),
                (p("b.bin"), 4000),
                (p("c.bin"), 4000),
                (p("solo.bin"), 9000), // unique size, never hashed
            ],
            1,
            1,
        );

        assert_eq!(report.groups.len(), 1, "only a.bin/b.bin are identical");
        let g = &report.groups[0];
        assert_eq!(g.paths, vec![p("a.bin"), p("b.bin")]);
        assert_eq!(g.size, 4000);
        assert_eq!(g.reclaimable, 4000);
        assert_eq!(report.reclaimable, 4000);
        assert_eq!(report.hashed, 3); // a, b, c (solo skipped by the size pre-filter)
    }

    #[test]
    fn three_copies_reclaim_two() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let data = vec![b'k'; 5000];
        for n in ["x.bin", "y.bin", "z.bin"] {
            write(&root.join(n), &data);
        }
        let p = |n: &str| root.join(n).display().to_string();
        let report = run(&[(p("x.bin"), 5000), (p("y.bin"), 5000), (p("z.bin"), 5000)], 1, 1);

        assert_eq!(report.groups.len(), 1);
        assert_eq!(report.groups[0].paths.len(), 3);
        assert_eq!(report.groups[0].reclaimable, 10000); // size * (3 - 1)
    }

    #[test]
    fn trash_copies_are_excluded() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let trash = root.join(".Trash");
        std::fs::create_dir(&trash).unwrap();
        let data = vec![b'd'; 4000];
        write(&root.join("a.bin"), &data);
        write(&root.join("b.bin"), &data);
        write(&trash.join("c.bin"), &data); // identical, but already in the Trash

        let a = root.join("a.bin").display().to_string();
        let b = root.join("b.bin").display().to_string();
        let c = trash.join("c.bin").display().to_string();
        let report = run(&[(a.clone(), 4000), (b.clone(), 4000), (c, 4000)], 1, 1);

        // Only the two live copies group; the Trash copy never enters the pipeline.
        assert_eq!(report.groups.len(), 1);
        assert_eq!(report.groups[0].paths, vec![a, b]);
        assert_eq!(report.groups[0].reclaimable, 4000); // one live extra, not two
        assert_eq!(report.hashed, 2, "the Trash file is filtered before hashing");
    }

    #[test]
    fn bails_when_generation_moves_on() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let data = vec![b'q'; 3000];
        write(&root.join("a.bin"), &data);
        write(&root.join("b.bin"), &data);
        let p = |n: &str| root.join(n).display().to_string();
        // gen (2) != mine (1): workers must not hash.
        let report = run(&[(p("a.bin"), 3000), (p("b.bin"), 3000)], 2, 1);
        assert!(report.groups.is_empty(), "a superseded run reports nothing");
    }
}
