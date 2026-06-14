import { describe, it, expect } from "vitest";
import { fmtBytes, pctOf } from "./format";

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
