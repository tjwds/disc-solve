import { describe, it, expect } from "vitest";
import { categoryTotals, sumDirsNamed, sumCategory, reclaimable } from "./suggestions";
import type { Category, Node } from "./types";

let counter = 0;
function leaf(name: string, size: number, category: Category): Node {
  return { name, path: "/p" + counter++, size, is_dir: false, is_symlink: false, category, item_count: 1, children: [] };
}
function dir(name: string, category: Category, children: Node[]): Node {
  return {
    name,
    path: "/d" + counter++,
    size: children.reduce((s, c) => s + c.size, 0),
    is_dir: true,
    is_symlink: false,
    category,
    item_count: children.length,
    children,
  };
}

function sampleTree(): Node {
  return dir("home", "other", [
    dir("proj", "dev", [
      dir("node_modules", "dev", [leaf("react.js", 2000, "dev"), leaf("vite.js", 1000, "dev")]),
      leaf("main.ts", 500, "dev"),
    ]),
    dir("Library", "cache", [dir("Caches", "cache", [leaf("c1", 800, "cache"), leaf("c2", 200, "cache")])]),
    dir(".Trash", "trash", [leaf("old.mov", 4000, "trash")]),
    leaf("movie.mov", 6000, "video"),
  ]);
}

describe("category + dir sums", () => {
  it("totals by category across leaves", () => {
    const t = categoryTotals(sampleTree());
    expect(t.dev).toBe(3500); // 2000 + 1000 + 500
    expect(t.cache).toBe(1000);
    expect(t.trash).toBe(4000);
    expect(t.video).toBe(6000);
  });

  it("sums directories by name", () => {
    expect(sumDirsNamed(sampleTree(), "node_modules")).toBe(3000);
  });

  it("sums a category", () => {
    expect(sumCategory(sampleTree(), "cache")).toBe(1000);
  });
});

describe("reclaimable", () => {
  it("surfaces node_modules, caches and trash, largest first", () => {
    const s = reclaimable(sampleTree());
    const keys = s.map((x) => x.key);
    expect(keys).toContain("node_modules");
    expect(keys).toContain("caches");
    expect(keys).toContain("trash");
    // sorted descending by bytes
    for (let i = 1; i < s.length; i++) expect(s[i - 1].bytes).toBeGreaterThanOrEqual(s[i].bytes);
  });

  it("attaches a drill target to folder suggestions and openTrash to the Trash", () => {
    const s = reclaimable(sampleTree());
    const nm = s.find((x) => x.key === "node_modules")!;
    expect(nm.action).toBe("drill");
    expect(nm.path).toBeTruthy();

    const trash = s.find((x) => x.key === "trash")!;
    expect(trash.action).toBe("openTrash");
    expect(trash.path).toBeUndefined();
  });

  it("omits empty categories", () => {
    const empty = dir("home", "other", [leaf("doc.pdf", 100, "docs")]);
    expect(reclaimable(empty)).toEqual([]);
  });
});
