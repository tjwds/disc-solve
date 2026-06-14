// Derives the sidebar's "state of your system" numbers from a real scan tree:
// per-category totals (for the gauge/legend) and concrete reclaimable suggestions.
// Pure and unit-tested.

import type { Category, Node } from "./types";

export type CategoryTotals = Record<Category, number>;

const ZERO_TOTALS = (): CategoryTotals => ({
  dev: 0,
  video: 0,
  audio: 0,
  photo: 0,
  docs: 0,
  apps: 0,
  system: 0,
  cache: 0,
  archive: 0,
  trash: 0,
  other: 0,
});

/** Sum on-disk size by category across all leaf files. */
export function categoryTotals(root: Node): CategoryTotals {
  const totals = ZERO_TOTALS();
  const visit = (n: Node) => {
    if (n.children.length === 0) {
      totals[n.category] += n.size;
    } else {
      n.children.forEach(visit);
    }
  };
  visit(root);
  return totals;
}

/** Total on-disk size of every directory named exactly `name` (not nested within
 *  another match — we stop descending once we find one). */
export function sumDirsNamed(root: Node, name: string): number {
  let total = 0;
  const visit = (n: Node) => {
    if (n.is_dir && n.name === name) {
      total += n.size;
      return; // don't double-count nested matches
    }
    n.children.forEach(visit);
  };
  visit(root);
  return total;
}

/** Total on-disk size of all leaves in a given category. */
export function sumCategory(root: Node, category: Category): number {
  return categoryTotals(root)[category];
}

export interface Suggestion {
  key: string;
  title: string;
  subtitle: string;
  bytes: number;
}

/** Concrete reclaimable suggestions, largest first, omitting empty ones. */
export function reclaimable(root: Node): Suggestion[] {
  const out: Suggestion[] = [];

  const nodeModules = sumDirsNamed(root, "node_modules");
  if (nodeModules > 0) {
    out.push({ key: "node_modules", title: "node_modules", subtitle: "Regenerable build dependencies", bytes: nodeModules });
  }
  const derived = sumDirsNamed(root, "DerivedData");
  if (derived > 0) {
    out.push({ key: "derived", title: "Xcode DerivedData", subtitle: "Rebuilds automatically", bytes: derived });
  }
  const caches = sumCategory(root, "cache");
  if (caches > 0) {
    out.push({ key: "caches", title: "Caches", subtitle: "Safe to clear; apps rebuild them", bytes: caches });
  }
  const trash = sumCategory(root, "trash");
  if (trash > 0) {
    out.push({ key: "trash", title: "Empty Trash", subtitle: "Items already in the Trash", bytes: trash });
  }

  return out.sort((a, b) => b.bytes - a.bytes);
}
