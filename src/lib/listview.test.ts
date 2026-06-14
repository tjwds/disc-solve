import { describe, it, expect } from "vitest";
import { sortItems, withoutAggregates, collectByName, resolveFilter, parentName, shortenPath } from "./listview";
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

describe("sortItems", () => {
  const items = [leaf("b", 300, 50), leaf("a", 100, 10), leaf("c", 200, 99)];
  it("sorts by size desc/asc without mutating input", () => {
    const desc = sortItems(items, "size", "desc");
    expect(desc.map((i) => i.size)).toEqual([300, 200, 100]);
    expect(sortItems(items, "size", "asc").map((i) => i.size)).toEqual([100, 200, 300]);
    expect(items.map((i) => i.name)).toEqual(["b", "a", "c"]); // untouched
  });
  it("sorts by name and mtime", () => {
    expect(sortItems(items, "name", "asc").map((i) => i.name)).toEqual(["a", "b", "c"]);
    expect(sortItems(items, "mtime", "desc").map((i) => i.mtime)).toEqual([99, 50, 10]);
  });
});

describe("withoutAggregates", () => {
  it("drops the synthetic empty-path aggregate rows, keeping real items", () => {
    const items = [leaf("a", 100), { ...leaf("12 smaller items", 999), path: "" }, leaf("b", 50)];
    expect(withoutAggregates(items).map((n) => n.name)).toEqual(["a", "b"]);
  });
});

describe("collectByName + resolveFilter", () => {
  const tree = dir("home", [
    dir("web-app", [dir("node_modules", [leaf("react.js", 2000)], "/home/web-app/node_modules")]),
    dir("api", [dir("node_modules", [leaf("x.js", 1000)], "/home/api/node_modules")]),
    dir("Library", [dir("Caches", [leaf("c1", 800)], "/home/Library/Caches")], "/home/Library"),
  ]);

  it("collects all node_modules folders", () => {
    expect(collectByName(tree, "node_modules").length).toBe(2);
  });
  it("resolves the node_modules filter with parent-name display", () => {
    const r = resolveFilter(tree, "node_modules");
    expect(r.label).toBe("node_modules");
    expect(r.items.length).toBe(2);
    expect(r.nameFromParent).toBe(true);
  });
  it("resolves caches to the cache folder's children", () => {
    // The Caches dir has category "other" here; build one categorized as cache:
    const t = dir("home", [dir("Caches", [leaf("Safari", 500), leaf("Chrome", 300)], "/home/Caches")]);
    (t.children[0] as Node).category = "cache";
    const r = resolveFilter(t, "caches");
    expect(r.items.map((i) => i.name).sort()).toEqual(["Chrome", "Safari"]);
  });
});

describe("display helpers", () => {
  it("derives the parent folder name", () => {
    expect(parentName("/Users/me/Developer/web-app/node_modules")).toBe("web-app");
    expect(parentName("/solo")).toBe("solo");
  });
  it("shortens the home path to ~", () => {
    expect(shortenPath("/Users/me/Developer/x", "/Users/me")).toBe("~/Developer/x");
    expect(shortenPath("/System/x", "/Users/me")).toBe("/System/x");
  });
});
