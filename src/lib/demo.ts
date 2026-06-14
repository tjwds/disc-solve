// A representative mock scan tree, used when the app runs outside Tauri (a plain
// browser) so the UI can be previewed without Full Disk Access. Not used in the
// real app, where data comes from the Rust scanner.

import type { Category, Node } from "./types";

let uid = 0;
const GB = 1024 ** 3;
const MB = 1024 ** 2;
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function file(name: string, size: number, daysAgo = 4): Node {
  return { name, path: `/demo/${name}#${uid++}`, size, is_dir: false, is_symlink: false, category: "other", item_count: 1, mtime: NOW - daysAgo * DAY, children: [] };
}
function agg(count: number, size: number): Node {
  return { name: `${count} smaller items`, path: "", size, is_dir: false, is_symlink: false, category: "other", item_count: count, mtime: NOW - 30 * DAY, children: [] };
}
function dir(name: string, children: Node[], daysAgo?: number, path?: string): Node {
  const mtime = daysAgo != null ? NOW - daysAgo * DAY : Math.max(0, ...children.map((c) => c.mtime));
  return {
    name,
    path: path ?? `/demo/${name}#${uid++}`,
    size: children.reduce((s, c) => s + c.size, 0),
    is_dir: true,
    is_symlink: false,
    category: "other",
    item_count: children.reduce((s, c) => s + c.item_count, 0),
    mtime,
    children,
  };
}
function withCat(n: Node, c: Category): Node {
  n.category = c;
  return n;
}

/** `count` files summing to ~`total`, descending in size. */
function manyFiles(prefix: string, ext: string, count: number, total: number, daysAgo = 4): Node[] {
  const weights: number[] = [];
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const w = 1 / (i + 1);
    weights.push(w);
    sum += w;
  }
  return weights.map((w, i) => file(`${prefix}-${i + 1}.${ext}`, Math.round((total * w) / sum), daysAgo));
}

/** A project folder containing a node_modules and some source. */
function project(name: string, gb: number, daysAgo: number): Node {
  return dir(
    name,
    [
      dir("node_modules", manyFiles("pkg", "js", 30, gb * GB, daysAgo), daysAgo, `/demo/Developer/${name}/node_modules`),
      ...manyFiles("src", "ts", 8, 0.4 * gb * GB, daysAgo),
    ],
    daysAgo,
    `/demo/Developer/${name}`,
  );
}

export function makeDemoTree(): Node {
  return dir("Macintosh HD", [
    dir("Users/me", [
      dir("Developer", [
        project("web-app", 8.2, 2),
        project("api-server", 6.7, 5),
        project("design-system", 5.1, 22),
        project("data-pipeline", 4.2, 70),
        project("analytics", 3.1, 120),
        project("legacy-dashboard", 2.3, 270),
        dir("DerivedData", [...manyFiles("build", "o", 20, 9 * GB, 3), agg(3000, 3 * GB)], 3),
      ]),
      dir("Movies", [file("interview.mov", 4.2 * GB, 8), file("demo.mov", 2.6 * GB, 30), file("export.mp4", 1.9 * GB, 90), agg(140, 1.1 * GB)]),
      dir("Pictures", [dir("Photos Library", [...manyFiles("IMG", "heic", 40, 14 * GB, 12), agg(6200, 8 * GB)])]),
      dir("Music", [...manyFiles("track", "flac", 16, 9 * GB, 40)]),
      dir("Documents", [...manyFiles("report", "pdf", 14, 3.4 * GB, 18)]),
      dir("Downloads", [file("Xcode.dmg", 7.8 * GB, 14), file("dataset.zip", 3.1 * GB, 200), ...manyFiles("img", "png", 16, 900 * MB, 6), agg(210, 1.4 * GB)]),
      dir("Library", [withCat(dir("Caches", [...manyFiles("cache", "db", 18, 5 * GB, 1), agg(4200, 2.6 * GB)]), "cache")]),
    ]),
    dir("System", [...manyFiles("framework", "dylib", 24, 22 * GB, 60), agg(40000, 30 * GB)]),
    dir("Applications", [file("Xcode.app", 12.4 * GB, 3), file("Figma.app", 1.4 * GB, 1), file("Photoshop.app", 3.8 * GB, 20), ...manyFiles("app", "app", 16, 9 * GB, 30)]),
    agg(20000, 6 * GB),
  ]);
}
