// List-view logic: sorting, the recommendation→filter resolvers, and display
// helpers. Pure and unit-tested. The UI lives in App.tsx.

import type { Node } from "./types";
import { largestDirNamed, largestDirOfCategory } from "./suggestions";

export type SortKey = "name" | "size" | "items" | "mtime";
export type SortDir = "asc" | "desc";

/** Stable sort of items by a column. Returns a new array. */
export function sortItems(items: Node[], key: SortKey, dir: SortDir): Node[] {
  const sign = dir === "asc" ? 1 : -1;
  const value = (a: Node, b: Node): number => {
    switch (key) {
      case "name":
        return a.name.localeCompare(b.name);
      case "size":
        return a.size - b.size;
      case "items":
        return a.item_count - b.item_count;
      case "mtime":
        return a.mtime - b.mtime;
      default:
        return 0;
    }
  };
  return [...items].sort((a, b) => sign * value(a, b));
}

/** Drop synthetic "N smaller items" aggregates (which carry an empty path).
 *  Aggregation is a tree-view device; the list view shows individual items. */
export function withoutAggregates(items: Node[]): Node[] {
  return items.filter((n) => n.path !== "");
}

/** All top-most directories named `name` across the tree (don't descend into a match). */
export function collectByName(root: Node, name: string): Node[] {
  const out: Node[] = [];
  const visit = (n: Node) => {
    if (n.is_dir && n.name === name) {
      out.push(n);
      return;
    }
    n.children.forEach(visit);
  };
  visit(root);
  return out;
}

export interface FilterResult {
  key: string;
  label: string;
  items: Node[];
  /** When true, show each row by its parent folder name (e.g. the project), not its own. */
  nameFromParent: boolean;
}

/** Resolve a recommendation's filter key to a concrete set of folders to list. */
export function resolveFilter(root: Node, key: string): FilterResult {
  switch (key) {
    case "node_modules":
      return { key, label: "node_modules", items: collectByName(root, "node_modules"), nameFromParent: true };
    case "derived":
      return { key, label: "Xcode DerivedData", items: largestDirNamed(root, "DerivedData")?.children ?? [], nameFromParent: false };
    case "caches":
      return { key, label: "Caches", items: largestDirOfCategory(root, "cache")?.children ?? [], nameFromParent: false };
    default:
      return { key, label: key, items: [], nameFromParent: false };
  }
}

/** The folder name containing `path` (the segment before the last). */
export function parentName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 2];
  return parts[parts.length - 1] ?? path;
}

/** Shorten an absolute path for display, using ~ for the home directory. */
export function shortenPath(path: string, home: string | null): string {
  if (home && path.startsWith(home)) return "~" + path.slice(home.length);
  return path;
}
