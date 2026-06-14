import { describe, it, expect } from "vitest";
import { baseName, keeperOf, extrasOf, pruneDupReport } from "./dups";
import type { DupGroup, DupReport } from "./types";

const grp = (size: number, paths: string[]): DupGroup => ({ size, paths, reclaimable: size * (paths.length - 1) });

describe("baseName", () => {
  it("returns the final path segment", () => {
    expect(baseName("/Users/me/Movies/clip.mov")).toBe("clip.mov");
    expect(baseName("solo")).toBe("solo");
  });
});

describe("keeperOf / extrasOf", () => {
  it("keeps the shortest path; the rest are extras", () => {
    const g = grp(100, ["/a/b/c/x", "/a/x", "/a/b/x"]);
    expect(keeperOf(g)).toBe("/a/x");
    expect(extrasOf(g)).toEqual(["/a/b/c/x", "/a/b/x"]);
  });
  it("breaks ties lexicographically", () => {
    const g = grp(100, ["/zz/x", "/aa/x"]);
    expect(keeperOf(g)).toBe("/aa/x");
  });
});

describe("pruneDupReport", () => {
  const report: DupReport = {
    groups: [grp(1000, ["/x1", "/x2", "/x3"]), grp(500, ["/y1", "/y2"])],
    reclaimable: 1000 * 2 + 500,
    hashed: 5,
  };

  it("drops trashed copies and recomputes reclaimable", () => {
    const out = pruneDupReport(report, ["/x3"]);
    expect(out.groups[0].paths).toEqual(["/x1", "/x2"]);
    expect(out.groups[0].reclaimable).toBe(1000);
    expect(out.reclaimable).toBe(1000 + 500);
  });

  it("removes a group that falls below two copies", () => {
    const out = pruneDupReport(report, ["/y1"]);
    expect(out.groups.map((g) => g.size)).toEqual([1000]);
    expect(out.reclaimable).toBe(2000);
  });

  it("preserves the hashed count and does not mutate the input", () => {
    const before = JSON.stringify(report);
    expect(pruneDupReport(report, []).hashed).toBe(5);
    expect(JSON.stringify(report)).toBe(before);
  });
});
