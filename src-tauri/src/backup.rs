//! Minimal Time Machine insight via `tmutil`. Read-only: it only ever *reports*
//! state (snapshot count, last backup). It never creates or deletes snapshots.

use serde::Serialize;
use std::process::Command;

#[derive(Serialize, Clone, Debug, Default)]
pub struct TimeMachineStatus {
    /// Number of local APFS snapshots on the boot volume (consume "purgeable" space).
    pub local_snapshots: usize,
    /// Newest backup path reported by `tmutil latestbackup`, if any.
    pub latest_backup: Option<String>,
}

/// Count snapshot lines from `tmutil listlocalsnapshots /` output. Snapshot lines
/// look like `com.apple.TimeMachine.2024-01-02-030405.local`.
pub fn parse_snapshot_count(output: &str) -> usize {
    output
        .lines()
        .filter(|l| l.trim().starts_with("com.apple.TimeMachine."))
        .count()
}

/// Query Time Machine state. Best-effort: any failure yields defaults rather than
/// an error, since this is informational only.
pub fn time_machine_status() -> TimeMachineStatus {
    let local_snapshots = Command::new("tmutil")
        .args(["listlocalsnapshots", "/"])
        .output()
        .ok()
        .map(|o| parse_snapshot_count(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or(0);

    let latest_backup = Command::new("tmutil")
        .arg("latestbackup")
        .output()
        .ok()
        .and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        });

    TimeMachineStatus {
        local_snapshots,
        latest_backup,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_snapshot_lines_only() {
        let out = "Snapshots for disk /:\n\
                   com.apple.TimeMachine.2024-01-01-010101.local\n\
                   com.apple.TimeMachine.2024-01-02-020202.local\n";
        assert_eq!(parse_snapshot_count(out), 2);
    }

    #[test]
    fn empty_output_is_zero() {
        assert_eq!(parse_snapshot_count(""), 0);
        assert_eq!(parse_snapshot_count("No snapshots for disk /\n"), 0);
    }
}
