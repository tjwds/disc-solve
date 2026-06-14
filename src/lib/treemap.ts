// Squarified treemap layout. Ported from the agreed mockup and typed against the
// real scan tree. Pure: given a node and a rectangle, it returns positioned tiles.
// Groups (directories that are subdivided) are emitted before their descendants;
// `labeled` marks the immediate children of the current view (one level of labels).

import type { Node } from "./types";

export interface Tile {
  node: Node;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  group: boolean;
  labeled: boolean;
}

const MAX_DEPTH = 7;
const MIN_RECURSE = 11;

function worst(areas: number[], side: number): number {
  let sum = 0;
  let max = 0;
  let min = Infinity;
  for (const a of areas) {
    sum += a;
    if (a > max) max = a;
    if (a < min) min = a;
  }
  const s2 = sum * sum;
  const w2 = side * side;
  return Math.max((w2 * max) / s2, s2 / (w2 * min));
}

export function squarify(root: Node, width: number, height: number): Tile[] {
  const out: Tile[] = [];
  if (width > 0 && height > 0) layout(root, 0, 0, width, height, 0, out);
  return out;
}

function layout(
  node: Node,
  x: number,
  y: number,
  w: number,
  h: number,
  depth: number,
  out: Tile[],
): void {
  const kids = node.children;
  if (!kids || kids.length === 0 || node.size <= 0) return;
  const scale = (w * h) / node.size;
  const items = kids
    .map((k) => ({ node: k, area: k.size * scale }))
    .filter((it) => it.area > 0.2)
    .sort((a, b) => b.area - a.area);

  let i = 0;
  while (i < items.length) {
    const side = Math.min(w, h);
    const rowAreas = [items[i].area];
    let j = i + 1;
    while (j < items.length) {
      if (worst(rowAreas.concat(items[j].area), side) <= worst(rowAreas, side)) {
        rowAreas.push(items[j].area);
        j++;
      } else break;
    }
    const rowItems = items.slice(i, j);
    const rowSum = rowAreas.reduce((a, b) => a + b, 0);
    if (w >= h) {
      const colW = rowSum / h;
      let cy = y;
      for (const it of rowItems) {
        const ch = it.area / colW;
        place(it.node, x, cy, colW, ch, depth, out);
        cy += ch;
      }
      x += colW;
      w -= colW;
    } else {
      const rowH = rowSum / w;
      let cx = x;
      for (const it of rowItems) {
        const cw = it.area / rowH;
        place(it.node, cx, y, cw, rowH, depth, out);
        cx += cw;
      }
      y += rowH;
      h -= rowH;
    }
    i = j;
  }
}

function place(
  node: Node,
  x: number,
  y: number,
  w: number,
  h: number,
  depth: number,
  out: Tile[],
): void {
  const isGroup = node.children && node.children.length > 0;
  if (isGroup && depth < MAX_DEPTH && Math.min(w, h) > MIN_RECURSE) {
    const labeled = depth === 0 && w > 60 && h > 26;
    const pad = depth <= 1 ? 1.5 : 1;
    out.push({ node, x, y, w, h, depth, group: true, labeled });
    layout(node, x + pad, y + pad, Math.max(0, w - 2 * pad), Math.max(0, h - 2 * pad), depth + 1, out);
  } else {
    out.push({ node, x, y, w, h, depth, group: false, labeled: false });
  }
}
