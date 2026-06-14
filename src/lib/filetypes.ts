// Colors the treemap by file extension. The set of types is discovered from the
// scan; the largest types (by on-disk size) get distinct, stable palette colors,
// the long tail falls back to a neutral. Pure and unit-tested.

import type { Node } from "./types";

/** Lowercased extension without the dot, or "" for none / dotfiles / odd names. */
export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return ""; // no dot, or leading-dot like ".DS_Store"
  const ext = name.slice(dot + 1).toLowerCase();
  if (ext.length === 0 || ext.length > 8 || !/^[a-z0-9]+$/.test(ext)) return "";
  return ext;
}

export interface TypeStat {
  ext: string;
  bytes: number;
}

/** Total on-disk size per extension across all real leaves (skips synthetic
 *  aggregate nodes, which have an empty path). Largest first. */
export function typeStats(root: Node): TypeStat[] {
  const totals = new Map<string, number>();
  const visit = (n: Node) => {
    if (n.children.length === 0) {
      if (n.path === "") return; // skip "N smaller items" aggregate
      const e = extOf(n.name);
      const key = e || "(none)";
      totals.set(key, (totals.get(key) ?? 0) + n.size);
    } else {
      n.children.forEach(visit);
    }
  };
  visit(root);
  return [...totals.entries()]
    .map(([ext, bytes]) => ({ ext, bytes }))
    .sort((a, b) => b.bytes - a.bytes);
}

// 16 distinct, theme-friendly hues. Assigned largest-type-first.
export const PALETTE = [
  "#5b8def", "#f0a35e", "#59a14f", "#e8716d", "#b07aa1", "#3fb0a4",
  "#edc948", "#ff9da7", "#9c755f", "#76b7b2", "#c189d6", "#d8b65c",
  "#8cd17d", "#6f9bd8", "#e6a13c", "#b6992d",
];

export interface LegendEntry {
  ext: string;
  bytes: number;
  color: string;
}

/** Map the top types to palette colors. Returns the lookup plus a legend. */
export function buildColorMap(stats: TypeStat[]): { map: Map<string, string>; legend: LegendEntry[] } {
  const map = new Map<string, string>();
  const legend: LegendEntry[] = [];
  stats.slice(0, PALETTE.length).forEach((s, i) => {
    map.set(s.ext, PALETTE[i]);
    legend.push({ ext: s.ext, bytes: s.bytes, color: PALETTE[i] });
  });
  return { map, legend };
}

/** The fill color for a leaf node, or null to use the neutral CSS fallback. */
export function colorForNode(node: Node, map: Map<string, string>): string | null {
  if (node.path === "") return null; // aggregate → CSS .agg
  const key = extOf(node.name) || "(none)";
  return map.get(key) ?? null; // unknown / dir → CSS .neutral
}
