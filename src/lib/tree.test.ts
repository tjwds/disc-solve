import { describe, it, expect } from "vitest";
import { removePaths } from "./tree";
import type { Node } from "./types";

let n = 0;
function leaf(name: string, size: number, mtime = 0, path = "/p" + n++): Node {
  return { name, path, size, is_dir: false, is_symlink: false, category: "other", item_count: 1, mtime, children: [] };
}
function dir(name: string, children: Node[], path = "/d" + n++): Node {
  return {
    name,
    path,
    size: children.reduce((s, c) => s + c.size, 0),
    is_dir: true,
    is_symlink: false,
    category: "other",
    item_count: children.reduce((s, c) => s + c.item_count, 0),
    mtime: Math.max(0, ...children.map((c) => c.mtime)),
    children,
  };
}

describe("removePaths", () => {
  it("removes a leaf and recomputes ancestor size, count, and mtime", () => {
    const root = dir("r", [leaf("a", 100, 10, "/r/a"), leaf("b", 300, 50, "/r/b")], "/r");
    const out = removePaths(root, ["/r/b"]);
    expect(out.children.map((c) => c.path)).toEqual(["/r/a"]);
    expect(out.size).toBe(100);
    expect(out.item_count).toBe(1);
    expect(out.mtime).toBe(10); // newest surviving child
  });

  it("recomputes nested ancestors and removes multiple paths at once", () => {
    const sub = dir("sub", [leaf("c", 50, 5, "/r/sub/c"), leaf("d", 70, 7, "/r/sub/d")], "/r/sub");
    const root = dir("r", [leaf("a", 100, 10, "/r/a"), sub], "/r");
    const out = removePaths(root, ["/r/a", "/r/sub/c"]);
    expect(out.size).toBe(70);
    expect(out.item_count).toBe(1);
    const outSub = out.children.find((c) => c.path === "/r/sub")!;
    expect(outSub.size).toBe(70);
    expect(outSub.children.map((c) => c.path)).toEqual(["/r/sub/d"]);
  });

  it("does not mutate the input tree", () => {
    const root = dir("r", [leaf("a", 100, 0, "/r/a"), leaf("b", 200, 0, "/r/b")], "/r");
    const before = JSON.stringify(root);
    removePaths(root, ["/r/a"]);
    expect(JSON.stringify(root)).toBe(before);
  });

  it("keeps untouched subtrees by reference", () => {
    const keep = dir("keep", [leaf("x", 10, 0, "/r/keep/x")], "/r/keep");
    const root = dir("r", [keep, leaf("b", 200, 0, "/r/b")], "/r");
    const out = removePaths(root, ["/r/b"]);
    expect(out.children.find((c) => c.path === "/r/keep")).toBe(keep);
  });

  it("returns the same tree for empty, unknown, or aggregate-only paths", () => {
    const root = dir("r", [leaf("a", 100, 0, "/r/a")], "/r");
    expect(removePaths(root, [])).toBe(root);
    expect(removePaths(root, [""])).toBe(root);
    expect(removePaths(root, ["/nope"])).toBe(root);
  });

  it("never removes synthetic aggregate nodes (empty path)", () => {
    const agg: Node = { name: "5 smaller items", path: "", size: 30, is_dir: false, is_symlink: false, category: "other", item_count: 5, mtime: 0, children: [] };
    const root = dir("r", [leaf("a", 100, 0, "/r/a"), agg], "/r");
    const out = removePaths(root, ["/r/a"]);
    expect(out.children.some((c) => c.path === "" && c.item_count === 5)).toBe(true);
    expect(out.size).toBe(30);
    expect(out.item_count).toBe(5);
  });
});
