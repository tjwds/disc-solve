// Human-readable byte sizes and percentages. Pure functions, unit-tested.

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const TB = GB * 1024;

/** Format a byte count like Finder: "1.2 GB", "340 MB", "8 KB", "512 B". */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes >= TB) return (bytes / TB).toFixed(1) + " TB";
  if (bytes >= GB) return (bytes / GB).toFixed(1) + " GB";
  if (bytes >= MB) return (bytes / MB).toFixed(1) + " MB";
  if (bytes >= KB) return Math.round(bytes / KB) + " KB";
  return Math.round(bytes) + " B";
}

/** Percentage of `whole` represented by `part`, e.g. "12.5%". */
export function pctOf(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return ((part / whole) * 100).toFixed(1) + "%";
}
