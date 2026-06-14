import { describe, it, expect } from "vitest";
import { extOf, typeStats, buildColorMap, colorForNode, PALETTE } from "./filetypes";
import type { Node } from "./types";

let n = 0;
function leaf(name: string, size: number, path = "/p" + n++): Node {
  return { name, path, size, is_dir: false, is_symlink: false, category: "other", item_count: 1, mtime: 0, children: [] };
}
function dir(name: string, children: Node[]): Node {
  return { name, path: "/d" + n++, size: children.reduce((s, c) => s + c.size, 0), is_dir: true, is_symlink: false, category: "other", item_count: children.length, mtime: 0, children };
}

describe("extOf", () => {
  it("extracts a normal extension", () => {
    expect(extOf("clip.MOV")).toBe("mov");
    expect(extOf("a.b.tar")).toBe("tar");
  });
  it("returns empty for none, dotfiles, and odd extensions", () => {
    expect(extOf("Makefile")).toBe("");
    expect(extOf(".DS_Store")).toBe("");
    expect(extOf("weird.超long")).toBe("");
    expect(extOf("x.verylongext")).toBe("");
  });
});

describe("typeStats", () => {
  it("sums by extension, largest first, skipping aggregates", () => {
    const tree = dir("root", [
      leaf("a.mov", 5000),
      leaf("b.mov", 3000),
      leaf("c.jpg", 1000),
      { ...leaf("100 smaller items", 9999), path: "" }, // aggregate, ignored
    ]);
    const stats = typeStats(tree);
    expect(stats[0]).toEqual({ ext: "mov", bytes: 8000 });
    expect(stats[1]).toEqual({ ext: "jpg", bytes: 1000 });
    expect(stats.find((s) => s.bytes === 9999)).toBeUndefined();
  });
});

describe("buildColorMap + colorForNode", () => {
  it("assigns palette colors to the biggest types", () => {
    const stats = typeStats(dir("root", [leaf("a.mov", 5000), leaf("c.jpg", 1000)]));
    const { map, legend } = buildColorMap(stats);
    expect(map.get("mov")).toBe(PALETTE[0]);
    expect(map.get("jpg")).toBe(PALETTE[1]);
    expect(legend[0].ext).toBe("mov");
    expect(colorForNode(leaf("x.mov", 1), map)).toBe(PALETTE[0]);
  });
  it("returns null for aggregates and unknown types", () => {
    const { map } = buildColorMap([]);
    expect(colorForNode({ ...leaf("x", 1), path: "" }, map)).toBeNull();
    expect(colorForNode(leaf("mystery.zzz", 1), map)).toBeNull();
  });
});
