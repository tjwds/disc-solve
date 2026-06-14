// Derives the sidebar's reclaimable suggestions from a scan tree. Each suggestion
// carries an action so the UI can give a "view into it": drill the treemap into
// the relevant folder, or — for the Trash — open it in Finder. Nothing here ever
// deletes: the app never hard-deletes, and even trashing is the user's action.

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

/** Total on-disk size of every directory named exactly `name` (top-most match only). */
export function sumDirsNamed(root: Node, name: string): number {
  let total = 0;
  const visit = (n: Node) => {
    if (n.is_dir && n.name === name) {
      total += n.size;
      return;
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

/** The largest (top-most) directory named `name`, for navigating into. */
export function largestDirNamed(root: Node, name: string): Node | null {
  let best: Node | null = null;
  const visit = (n: Node) => {
    if (n.is_dir && n.name === name) {
      if (!best || n.size > best.size) best = n;
      return; // don't descend into a match
    }
    n.children.forEach(visit);
  };
  visit(root);
  return best;
}

/** The largest (top-most) directory of a given category, for navigating into. */
export function largestDirOfCategory(root: Node, category: Category): Node | null {
  let best: Node | null = null;
  const visit = (n: Node) => {
    if (n.is_dir && n.category === category) {
      if (!best || n.size > best.size) best = n;
      return;
    }
    n.children.forEach(visit);
  };
  visit(root);
  return best;
}

export interface Suggestion {
  key: string;
  title: string;
  subtitle: string;
  bytes: number;
  /** What clicking does: drill into `path`, or open the Trash in Finder. */
  action: "drill" | "openTrash";
  /** For "drill": the directory to navigate the treemap into. */
  path?: string;
}

/** Concrete reclaimable suggestions, largest first, omitting empty ones. */
export function reclaimable(root: Node): Suggestion[] {
  const out: Suggestion[] = [];

  const nodeModules = sumDirsNamed(root, "node_modules");
  if (nodeModules > 0) {
    out.push({
      key: "node_modules",
      title: "node_modules",
      subtitle: "Regenerable build dependencies",
      bytes: nodeModules,
      action: "drill",
      path: largestDirNamed(root, "node_modules")?.path,
    });
  }

  const derived = sumDirsNamed(root, "DerivedData");
  if (derived > 0) {
    out.push({
      key: "derived",
      title: "Xcode DerivedData",
      subtitle: "Rebuilds automatically",
      bytes: derived,
      action: "drill",
      path: largestDirNamed(root, "DerivedData")?.path,
    });
  }

  const caches = sumCategory(root, "cache");
  if (caches > 0) {
    out.push({
      key: "caches",
      title: "Caches",
      subtitle: "Safe to clear; apps rebuild them",
      bytes: caches,
      action: "drill",
      path: largestDirOfCategory(root, "cache")?.path,
    });
  }

  const trash = sumCategory(root, "trash");
  if (trash > 0) {
    out.push({
      key: "trash",
      title: "Empty Trash",
      subtitle: "Opens the Trash in Finder",
      bytes: trash,
      action: "openTrash",
    });
  }

  return out.sort((a, b) => b.bytes - a.bytes);
}
