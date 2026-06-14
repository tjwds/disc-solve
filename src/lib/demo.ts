// A representative mock scan tree, used when the app runs outside Tauri (a plain
// browser) so the UI can be previewed without Full Disk Access. Not used in the
// real app, where data comes from the Rust scanner.

import type { Node } from "./types";

let uid = 0;
const GB = 1024 ** 3;
const MB = 1024 ** 2;

function file(name: string, size: number): Node {
  return { name, path: `/demo/${name}#${uid++}`, size, is_dir: false, is_symlink: false, category: "other", item_count: 1, children: [] };
}
function agg(count: number, size: number): Node {
  return { name: `${count} smaller items`, path: "", size, is_dir: false, is_symlink: false, category: "other", item_count: count, children: [] };
}
function dir(name: string, children: Node[]): Node {
  return {
    name,
    path: `/demo/${name}#${uid++}`,
    size: children.reduce((s, c) => s + c.size, 0),
    is_dir: true,
    is_symlink: false,
    category: "other",
    item_count: children.reduce((s, c) => s + c.item_count, 0),
    children,
  };
}

function manyFiles(prefix: string, ext: string, count: number, total: number): Node[] {
  const out: Node[] = [];
  for (let i = 0; i < count; i++) {
    // deterministic, descending sizes
    const w = 1 / (i + 1);
    out.push(file(`${prefix}-${i + 1}.${ext}`, Math.round((total * w) / 2)));
  }
  return out;
}

export function makeDemoTree(): Node {
  return dir("Macintosh HD", [
    dir("Users/me", [
      dir("Developer", [
        dir("node_modules", [...manyFiles("pkg", "js", 40, 18 * GB), agg(9000, 9 * GB)]),
        dir("DerivedData", [...manyFiles("build", "o", 20, 9 * GB), agg(3000, 3 * GB)]),
        ...manyFiles("src", "ts", 12, 1.4 * GB),
        ...manyFiles("mod", "rs", 8, 700 * MB),
      ]),
      dir("Movies", [
        file("interview.mov", 4.2 * GB),
        file("demo-take.mov", 2.6 * GB),
        file("export-final.mp4", 1.9 * GB),
        file("b-roll.mov", 1.3 * GB),
        file("webinar.mp4", 900 * MB),
        agg(140, 1.1 * GB),
      ]),
      dir("Pictures", [
        dir("Photos Library", [...manyFiles("IMG", "heic", 30, 14 * GB), ...manyFiles("edit", "jpg", 18, 4 * GB), agg(6200, 8 * GB)]),
      ]),
      dir("Music", [...manyFiles("track", "flac", 16, 9 * GB), ...manyFiles("demo", "mp3", 20, 3 * GB)]),
      dir("Documents", [...manyFiles("report", "pdf", 14, 3.4 * GB), ...manyFiles("sheet", "xlsx", 10, 800 * MB), file("thesis.docx", 240 * MB)]),
      dir("Downloads", [file("Xcode.dmg", 7.8 * GB), file("dataset.zip", 3.1 * GB), file("installer.pkg", 1.2 * GB), ...manyFiles("img", "png", 16, 900 * MB), agg(210, 1.4 * GB)]),
      dir("Library", [dir("Caches", [...manyFiles("cache", "db", 18, 5 * GB), agg(4200, 2.6 * GB)])]),
    ]),
    dir("System", [...manyFiles("framework", "dylib", 24, 22 * GB), agg(40000, 30 * GB)]),
    dir("Applications", [file("Xcode.app", 12.4 * GB), file("Figma.app", 1.4 * GB), file("Photoshop.app", 3.8 * GB), ...manyFiles("app", "app", 16, 9 * GB)]),
    agg(20000, 6 * GB),
  ]);
}
