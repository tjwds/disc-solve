// Pure tree edits applied after the user trashes items, so the size tree is
// updated in memory instead of re-scanning the whole disk. Ancestor on-disk
// size, item count, and mtime are recomputed to match the scanner's semantics
// (a directory aggregates its children).

import type { Node } from "./types";

/**
 * Return a new tree with every node whose `path` is in `paths` removed, with
 * each affected ancestor's `size`, `item_count`, and `mtime` recomputed from
 * its surviving children. Empty paths (the synthetic "N smaller items"
 * aggregates) and paths not present in the tree are ignored.
 *
 * Pure: the input tree is never mutated, and untouched subtrees keep their
 * object identity (so React can skip re-rendering them).
 */
export function removePaths(root: Node, paths: Iterable<string>): Node {
  const remove = new Set<string>();
  for (const p of paths) if (p) remove.add(p);
  if (remove.size === 0) return root;

  const rebuild = (node: Node): Node | null => {
    if (node.path && remove.has(node.path)) return null;
    if (node.children.length === 0) return node;

    let changed = false;
    const kids: Node[] = [];
    for (const child of node.children) {
      const next = rebuild(child);
      if (next === null) {
        changed = true;
        continue;
      }
      if (next !== child) changed = true;
      kids.push(next);
    }
    if (!changed) return node;

    return {
      ...node,
      children: kids,
      size: kids.reduce((s, c) => s + c.size, 0),
      item_count: kids.reduce((s, c) => s + c.item_count, 0),
      mtime: kids.length ? Math.max(...kids.map((c) => c.mtime)) : node.mtime,
    };
  };

  return rebuild(root) ?? root;
}
