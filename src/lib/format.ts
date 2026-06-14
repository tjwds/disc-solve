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

const DAY = 86400;

/** Relative age of a unix-seconds timestamp, e.g. "2 days ago", "3 months ago". */
export function fmtRelTime(seconds: number, now: number = Date.now() / 1000): string {
  if (!seconds || seconds <= 0) return "—";
  const s = Math.max(0, now - seconds);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < DAY) return `${Math.floor(s / 3600)} hr ago`;
  const days = Math.floor(s / DAY);
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

/** True when a timestamp is older than `days` (default 60) — used to flag stale items. */
export function isStale(seconds: number, days = 60, now: number = Date.now() / 1000): boolean {
  if (!seconds || seconds <= 0) return false;
  return now - seconds > days * DAY;
}
