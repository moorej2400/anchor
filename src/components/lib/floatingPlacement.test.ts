import { describe, expect, it } from "vitest";
import { placeFloatingSurface } from "./floatingPlacement";

const viewport = { top: 0, left: 0, width: 800, height: 600 };

describe("placeFloatingSurface", () => {
  it("keeps a right-aligned menu inside both horizontal window edges", () => {
    expect(placeFloatingSurface(
      { top: 40, right: 70, bottom: 60, left: 50 },
      { width: 236, height: 200 },
      viewport,
    ).left).toBe(8);

    expect(placeFloatingSurface(
      { top: 40, right: 900, bottom: 60, left: 880 },
      { width: 236, height: 200 },
      viewport,
    ).left).toBe(556);
  });

  it("opens above its anchor when the lower edge has less room", () => {
    expect(placeFloatingSurface(
      { top: 550, right: 760, bottom: 570, left: 740 },
      { width: 220, height: 180 },
      viewport,
    )).toEqual({ top: 365, left: 540, placement: "above" });
  });

  it("clamps oversized surfaces to offset viewport bounds", () => {
    expect(placeFloatingSurface(
      { top: 120, right: 150, bottom: 140, left: 130 },
      { width: 500, height: 500 },
      { top: 50, left: 25, width: 320, height: 260 },
    )).toEqual({ top: 58, left: 33, placement: "below" });
  });
});
