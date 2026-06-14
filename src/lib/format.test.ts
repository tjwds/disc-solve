import { describe, it, expect } from "vitest";
import { fmtBytes, pctOf, fmtRelTime, isStale } from "./format";

describe("fmtBytes", () => {
  it("scales across units", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(2048)).toBe("2 KB");
    expect(fmtBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(fmtBytes(3 * 1024 ** 3)).toBe("3.0 GB");
    expect(fmtBytes(2 * 1024 ** 4)).toBe("2.0 TB");
  });

  it("guards against bad input", () => {
    expect(fmtBytes(-5)).toBe("0 B");
    expect(fmtBytes(NaN)).toBe("0 B");
  });
});

describe("pctOf", () => {
  it("computes percentages", () => {
    expect(pctOf(1, 4)).toBe("25.0%");
    expect(pctOf(0, 4)).toBe("0.0%");
  });

  it("handles a zero whole", () => {
    expect(pctOf(1, 0)).toBe("0%");
  });
});

const NOW = 1_700_000_000;
const D = 86400;

describe("fmtRelTime", () => {
  it("formats ages across scales", () => {
    expect(fmtRelTime(NOW - 30, NOW)).toBe("just now");
    expect(fmtRelTime(NOW - D, NOW)).toBe("Yesterday");
    expect(fmtRelTime(NOW - 3 * D, NOW)).toBe("3 days ago");
    expect(fmtRelTime(NOW - 90 * D, NOW)).toBe("3 months ago");
    expect(fmtRelTime(NOW - 400 * D, NOW)).toBe("1 year ago");
  });
  it("handles missing timestamps", () => {
    expect(fmtRelTime(0, NOW)).toBe("—");
  });
});

describe("isStale", () => {
  it("flags timestamps older than the threshold", () => {
    expect(isStale(NOW - 90 * D, 60, NOW)).toBe(true);
    expect(isStale(NOW - 10 * D, 60, NOW)).toBe(false);
    expect(isStale(0, 60, NOW)).toBe(false);
  });
});
