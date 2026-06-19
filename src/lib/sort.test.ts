import { describe, expect, it } from "vitest";
import { defaultSettings, demoImages, isImageName, leafName, moveItem, previewDataUrl } from "./sort";

describe("moveItem", () => {
  it("moves an item down and up without mutating the input", () => {
    const a = ["a", "b", "c", "d"];
    expect(moveItem(a, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(a, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(a).toEqual(["a", "b", "c", "d"]); // original untouched
  });
  it("clamps out-of-range indices", () => {
    expect(moveItem(["a", "b", "c"], 0, 99)).toEqual(["b", "c", "a"]);
  });
});

describe("isImageName", () => {
  it("recognizes image extensions, case-insensitively", () => {
    expect(isImageName("IMG_4821.HEIC")).toBe(true);
    expect(isImageName("shot.PNG")).toBe(true);
    expect(isImageName("a.jpeg")).toBe(true);
  });
  it("rejects non-images and oddities", () => {
    expect(isImageName("notes.pdf")).toBe(false);
    expect(isImageName("archive.zip")).toBe(false);
    expect(isImageName("noext")).toBe(false);
    expect(isImageName(".DS_Store")).toBe(false);
  });
});

describe("defaultSettings", () => {
  it("derives sources and destinations from home", () => {
    const s = defaultSettings("/Users/tester");
    expect(s.sources).toEqual(["/Users/tester/Desktop", "/Users/tester/Downloads"]);
    expect(s.destinations.some((d) => d.kind === "photos")).toBe(true);
    expect(s.destinations[0].path).toBe("/Users/tester/Pictures");
  });
});

describe("leafName", () => {
  it("returns the last path component", () => {
    expect(leafName("/Users/me/Desktop")).toBe("Desktop");
    expect(leafName("/Users/me/Documents/Photos/")).toBe("Photos");
  });
});

describe("previewDataUrl", () => {
  it("produces a deterministic SVG data URL", () => {
    const a = previewDataUrl("landscape", 202, 205);
    const b = previewDataUrl("landscape", 202, 205);
    expect(a.startsWith("data:image/svg+xml,")).toBe(true);
    expect(a).toBe(b); // same seed → same image
    expect(decodeURIComponent(a)).toContain("<svg");
  });
});

describe("demoImages", () => {
  it("returns image rows with previews from both sources", () => {
    const imgs = demoImages();
    expect(imgs.length).toBeGreaterThan(0);
    expect(imgs.every((i) => i.previewUrl?.startsWith("data:image/svg+xml,"))).toBe(true);
    expect(imgs.some((i) => i.source === "Desktop")).toBe(true);
    expect(imgs.some((i) => i.source === "Downloads")).toBe(true);
    expect(imgs.every((i) => i.path && i.name && i.size > 0)).toBe(true);
  });
});
