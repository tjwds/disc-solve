// Shared types and helpers for the "Get organized" sort flow. Mirrors the
// serde types in src-tauri/src/sort.rs. The SVG preview generators here are
// demo-only — the real app shows the actual file via the asset protocol.

export type DestKind = "folder" | "photos";

export interface Destination {
  id: string;
  name: string;
  kind: DestKind;
  /** Absolute folder path for `folder` destinations; null for Apple Photos. */
  path: string | null;
}

export interface SortSettings {
  destinations: Destination[];
  /** Folders scanned for loose images (top level only). */
  sources: string[];
}

export interface ImageFile {
  path: string;
  name: string;
  size: number;
  mtime: number;
  ext: string;
  /** Display name of the source folder, e.g. "Desktop". */
  source: string;
  /** Demo-only preview data URL (the real app derives it via convertFileSrc). */
  previewUrl?: string;
  /** Demo-only pixel dimensions (the real app reads them from the loaded image). */
  dim?: string;
}

/** Image extensions the flow recognizes (mirrors the Rust `IMAGE_EXTS`). */
export const IMAGE_EXTS = [
  "jpg", "jpeg", "png", "heic", "heif", "gif", "webp", "tiff", "tif",
  "bmp", "raw", "cr2", "nef", "arw", "svg", "ico", "psd",
];

/** Whether a filename has a recognized image extension. */
export function isImageName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return IMAGE_EXTS.includes(name.slice(dot + 1).toLowerCase());
}

/** First-run defaults, relative to the home directory. Mirrors `Settings::defaults`
 *  (the Rust side additionally drops any of these folders that don't exist). */
export function defaultSettings(home: string): SortSettings {
  return {
    destinations: [
      { id: "pictures", name: "Pictures", kind: "folder", path: `${home}/Pictures` },
      { id: "apple-photos", name: "Apple Photos", kind: "photos", path: null },
    ],
    sources: [`${home}/Desktop`, `${home}/Downloads`],
  };
}

/** Short last-path-component label for a folder, e.g. "Photos" from a long path. */
export function leafName(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

/** A copy of `arr` with the item at `from` moved to index `to`. Out-of-range
 *  indices are clamped; a no-op move returns an equivalent copy. */
export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  const next = arr.slice();
  const f = Math.max(0, Math.min(next.length - 1, from));
  const t = Math.max(0, Math.min(next.length - 1, to));
  const [m] = next.splice(f, 1);
  next.splice(t, 0, m);
  return next;
}

// ---- demo image previews ------------------------------------------------------
// A tiny seeded PRNG drives deterministic, self-contained SVG "photos" so the
// browser demo looks like real content without bundling image files.

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type Gen = [number, number, string]; // [viewBox w, h, inner svg]

function gLandscape(r: () => number, h: number): Gen {
  const h2 = (h + 30) % 360;
  const id = "lg" + Math.floor(r() * 1e6);
  return [400, 300,
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${h},75%,80%)"/><stop offset="0.55" stop-color="hsl(${(h + 12) % 360},62%,62%)"/><stop offset="1" stop-color="hsl(${h2},45%,46%)"/></linearGradient></defs>` +
    `<rect width="400" height="300" fill="url(#${id})"/>` +
    `<circle cx="${Math.round(60 + r() * 260)}" cy="${Math.round(52 + r() * 36)}" r="24" fill="rgba(255,255,255,.85)"/>` +
    `<path d="M0 208 Q100 170 200 200 T400 190 V300 H0Z" fill="hsl(${h2},42%,44%)" opacity="0.82"/>` +
    `<path d="M0 246 Q120 214 250 244 T400 240 V300 H0Z" fill="hsl(${h2},48%,32%)"/>`];
}
function gPortrait(r: () => number, h: number): Gen {
  const id = "pg" + Math.floor(r() * 1e6);
  return [300, 400,
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${h},48%,74%)"/><stop offset="1" stop-color="hsl(${(h + 28) % 360},42%,46%)"/></linearGradient></defs>` +
    `<rect width="300" height="400" fill="url(#${id})"/>` +
    `<g fill="rgba(255,255,255,.92)"><circle cx="150" cy="146" r="56"/><path d="M44 400c0-80 48-126 106-126s106 46 106 126Z"/></g>`];
}
function gScreenshot(r: () => number): Gen {
  let s = `<rect width="400" height="250" fill="#eef1f5"/><rect width="400" height="32" fill="#e2e6ec"/>` +
    `<circle cx="18" cy="16" r="5" fill="#ff5f57"/><circle cx="35" cy="16" r="5" fill="#febc2e"/><circle cx="52" cy="16" r="5" fill="#28c840"/>` +
    `<rect x="120" y="8" width="160" height="16" rx="8" fill="#fff"/><rect x="0" y="32" width="104" height="218" fill="#e7ebf1"/>`;
  for (let i = 0; i < 6; i++) s += `<rect x="16" y="${50 + i * 26}" width="${40 + Math.round(r() * 42)}" height="9" rx="4" fill="#c7cdd6"/>`;
  for (let j = 0; j < 7; j++) s += `<rect x="126" y="${54 + j * 22}" width="${150 + Math.round(r() * 118)}" height="10" rx="5" fill="#d4d9e1"/>`;
  return [400, 250, s + `<rect x="300" y="210" width="84" height="26" rx="7" fill="#2f6bf3"/>`];
}
function gDocument(r: () => number, h: number): Gen {
  let s = `<rect width="248" height="350" fill="#fff"/><rect width="248" height="58" fill="hsl(${h},34%,54%)"/>` +
    `<rect x="20" y="18" width="110" height="11" rx="5" fill="rgba(255,255,255,.9)"/><rect x="20" y="34" width="70" height="7" rx="3" fill="rgba(255,255,255,.6)"/>`;
  for (let i = 0; i < 8; i++) s += `<rect x="20" y="${82 + i * 22}" width="${120 + Math.round(r() * 88)}" height="8" rx="4" fill="#dfe3e9"/><rect x="200" y="${82 + i * 22}" width="28" height="8" rx="4" fill="#e9ecf1"/>`;
  return [248, 350, s + `<rect x="20" y="284" width="208" height="2" fill="#cfd5dd"/><rect x="20" y="298" width="60" height="11" rx="4" fill="#9aa1ad"/><rect x="150" y="296" width="78" height="14" rx="4" fill="hsl(${h},46%,50%)"/>`];
}
function gChart(r: () => number, h: number): Gen {
  let s = `<rect width="400" height="250" fill="#fff"/><rect x="34" y="20" width="150" height="11" rx="5" fill="#c7cdd6"/><path d="M50 210 H372 M50 210 V44" stroke="#dde1e8" stroke-width="2" fill="none"/>`;
  let x = 66;
  for (let i = 0; i < 6; i++) { const hh = 40 + Math.round(r() * 128); s += `<rect x="${x}" y="${210 - hh}" width="36" height="${hh}" rx="3" fill="hsl(${(h + i * 9) % 360},58%,58%)"/>`; x += 54; }
  return [400, 250, s];
}
function gQR(r: () => number): Gen {
  let s = `<rect width="300" height="300" fill="#fff"/>`;
  const f = (x: number, y: number) => `<rect x="${x}" y="${y}" width="64" height="64" rx="8" fill="#15171c"/><rect x="${x + 12}" y="${y + 12}" width="40" height="40" rx="4" fill="#fff"/><rect x="${x + 22}" y="${y + 22}" width="20" height="20" rx="2" fill="#15171c"/>`;
  s += f(24, 24) + f(212, 24) + f(24, 212);
  for (let gx = 0; gx < 14; gx++) for (let gy = 0; gy < 14; gy++) {
    if ((gx < 4 && gy < 4) || (gx > 9 && gy < 4) || (gx < 4 && gy > 9)) continue;
    if (r() > 0.55) s += `<rect x="${24 + gx * 18}" y="${24 + gy * 18}" width="14" height="14" rx="2" fill="#15171c"/>`;
  }
  return [300, 300, s];
}
function gWhiteboard(r: () => number): Gen {
  const c = "#33373f";
  let s = `<rect width="400" height="300" fill="#f6f5f0"/>` +
    `<rect x="40" y="48" width="120" height="72" rx="6" fill="none" stroke="${c}" stroke-width="3"/>` +
    `<rect x="240" y="70" width="120" height="72" rx="6" fill="none" stroke="#2f6bf3" stroke-width="3"/>` +
    `<path d="M160 86 H236" stroke="${c}" stroke-width="3" fill="none"/><path d="M228 79 l10 7 -10 7" fill="none" stroke="${c}" stroke-width="3"/>`;
  for (let i = 0; i < 3; i++) s += `<rect x="58" y="${64 + i * 16}" width="${50 + Math.round(r() * 40)}" height="5" rx="2" fill="${c}" opacity="0.65"/>`;
  return [400, 300, s + `<path d="M58 206 q60 -32 120 0 t140 -6" fill="none" stroke="#e0484d" stroke-width="3"/><circle cx="300" cy="216" r="22" fill="none" stroke="${c}" stroke-width="3"/>`];
}

export type DemoKind =
  | "landscape" | "portrait" | "screenshot" | "document" | "chart" | "qr" | "whiteboard";

const GENS: Record<DemoKind, (r: () => number, hue: number) => Gen> = {
  landscape: gLandscape, portrait: gPortrait, screenshot: (r) => gScreenshot(r),
  document: gDocument, chart: gChart, qr: (r) => gQR(r), whiteboard: (r) => gWhiteboard(r),
};

/** A self-contained SVG data URL standing in for a real image, in demo mode. */
export function previewDataUrl(kind: DemoKind, seed: number, hue: number): string {
  const [w, h, inner] = GENS[kind](rng(seed), hue);
  // Explicit width/height give the <img> an intrinsic size (×4 for a crisp
  // placeholder) so it lays out like a real raster photo, not a 0-sized SVG.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * 4}" height="${h * 4}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">${inner}</svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

interface DemoSpec {
  n: string; src: "Desktop" | "Downloads"; kind: DemoKind; dim: string; size: number; days: number; seed: number; hue: number;
}
const DEMO_SPECS: DemoSpec[] = [
  { n: "Screenshot 2026-06-15 at 2.31.07 PM.png", src: "Desktop", kind: "screenshot", dim: "2880 × 1800", size: 1_600_000, days: 0, seed: 101, hue: 0 },
  { n: "IMG_4821.HEIC", src: "Desktop", kind: "landscape", dim: "4032 × 3024", size: 3_800_000, days: 4, seed: 202, hue: 205 },
  { n: "design-review-v4.png", src: "Desktop", kind: "screenshot", dim: "1680 × 1050", size: 742_000, days: 5, seed: 303, hue: 0 },
  { n: "whiteboard-sync.jpg", src: "Desktop", kind: "whiteboard", dim: "3024 × 2268", size: 2_100_000, days: 6, seed: 404, hue: 0 },
  { n: "IMG_4822.HEIC", src: "Desktop", kind: "portrait", dim: "3024 × 4032", size: 3_100_000, days: 7, seed: 505, hue: 24 },
  { n: "amazon-receipt.png", src: "Downloads", kind: "document", dim: "1240 × 1754", size: 318_000, days: 8, seed: 606, hue: 150 },
  { n: "q2-revenue-chart.png", src: "Downloads", kind: "chart", dim: "1600 × 1000", size: 206_000, days: 9, seed: 707, hue: 210 },
  { n: "concert-ticket-qr.png", src: "Downloads", kind: "qr", dim: "1000 × 1000", size: 96_000, days: 10, seed: 808, hue: 0 },
  { n: "sunset-mendocino.heic", src: "Downloads", kind: "landscape", dim: "4032 × 3024", size: 4_200_000, days: 12, seed: 909, hue: 28 },
  { n: "headshot-final.jpg", src: "Downloads", kind: "portrait", dim: "2400 × 3000", size: 2_600_000, days: 15, seed: 121, hue: 200 },
  { n: "mountain-trip.heic", src: "Downloads", kind: "landscape", dim: "4032 × 3024", size: 3_900_000, days: 19, seed: 131, hue: 150 },
];

/** Demo image queue: the SVG specs above turned into ImageFile rows. */
export function demoImages(): ImageFile[] {
  const now = Math.floor(Date.now() / 1000);
  return DEMO_SPECS.map((d) => ({
    path: `/demo/${d.src}/${d.n}`,
    name: d.n,
    size: d.size,
    mtime: now - d.days * 86400,
    ext: (d.n.split(".").pop() || "").toLowerCase(),
    source: d.src,
    previewUrl: previewDataUrl(d.kind, d.seed, d.hue),
    dim: d.dim,
  }));
}
