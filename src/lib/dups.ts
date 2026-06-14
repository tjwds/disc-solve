// Presentation logic for the duplicates view: which copy to suggest keeping,
// and keeping a report consistent after copies are trashed. Pure and tested.

import type { DupGroup, DupReport } from "./types";

/** The final segment of a path — a group's display title. */
export function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** The copy to suggest keeping: the shortest path (usually the least-nested
 *  "original"), ties broken lexicographically. A suggestion only — the user can
 *  trash any copy, including this one. */
export function keeperOf(group: DupGroup): string {
  return [...group.paths].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

/** The non-keeper copies of a group. */
export function extrasOf(group: DupGroup): string[] {
  const keep = keeperOf(group);
  return group.paths.filter((p) => p !== keep);
}

/** Remove trashed paths from a report, dropping any group left with fewer than
 *  two copies and recomputing the reclaimable totals. Pure. */
export function pruneDupReport(report: DupReport, trashed: Iterable<string>): DupReport {
  const gone = new Set(trashed);
  const groups: DupGroup[] = [];
  let reclaimable = 0;
  for (const g of report.groups) {
    const paths = g.paths.filter((p) => !gone.has(p));
    if (paths.length < 2) continue;
    const reclaim = g.size * (paths.length - 1);
    reclaimable += reclaim;
    groups.push({ size: g.size, paths, reclaimable: reclaim });
  }
  return { groups, reclaimable, hashed: report.hashed };
}
