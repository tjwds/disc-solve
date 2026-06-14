import { describe, it, expect } from "vitest";
import { squarify } from "./treemap";
import type { Node } from "./types";

function leaf(name: string, size: number): Node {
  return { name, path: "/" + name, size, is_dir: false, is_symlink: false, category: "other", item_count: 1, mtime: 0, children: [] };
}
function dir(name: string, children: Node[]): Node {
  const size = children.reduce((s, c) => s + c.size, 0);
  return { name, path: "/" + name, size, is_dir: true, is_symlink: false, category: "other", item_count: children.length, mtime: 0, children };
}

describe("squarify", () => {
  it("fills the rectangle (leaf areas ~ total area)", () => {
    const root = dir("root", [leaf("a", 400_000), leaf("b", 300_000), leaf("c", 200_000), leaf("d", 100_000)]);
    const tiles = squarify(root, 200, 200).filter((t) => !t.group);
    const area = tiles.reduce((s, t) => s + t.w * t.h, 0);
    expect(area).toBeCloseTo(200 * 200, 0);
  });

  it("sizes tiles proportionally", () => {
    const root = dir("root", [leaf("big", 300_000), leaf("small", 100_000)]);
    const tiles = squarify(root, 100, 100).filter((t) => !t.group);
    const big = tiles.find((t) => t.node.name === "big")!;
    const small = tiles.find((t) => t.node.name === "small")!;
    const ratio = (big.w * big.h) / (small.w * small.h);
    expect(ratio).toBeGreaterThan(2.7);
    expect(ratio).toBeLessThan(3.3);
  });

  it("emits one leaf tile per leaf and labels only the top level", () => {
    const root = dir("root", [
      dir("Developer", [leaf("x", 200_000), leaf("y", 100_000)]),
      leaf("Movies", 300_000),
    ]);
    const tiles = squarify(root, 300, 300);
    const leaves = tiles.filter((t) => !t.group);
    // Leaves: x, y, Movies => 3
    expect(leaves.length).toBe(3);
    // Only depth-0 groups are labeled (Developer); grandchildren never are.
    const labeled = tiles.filter((t) => t.labeled);
    expect(labeled.every((t) => t.depth === 0)).toBe(true);
    expect(labeled.some((t) => t.node.name === "Developer")).toBe(true);
  });

  it("returns nothing for a zero-area canvas", () => {
    const root = dir("root", [leaf("a", 100)]);
    expect(squarify(root, 0, 0)).toEqual([]);
  });
});
