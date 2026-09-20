export interface FloatingRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface FloatingSize {
  width: number;
  height: number;
}

export interface ViewportBounds {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface FloatingPosition {
  top: number;
  left: number;
  placement: "above" | "below";
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

export function placeFloatingSurface(
  anchor: FloatingRect,
  surface: FloatingSize,
  viewport: ViewportBounds,
  margin = 8,
  gap = 5,
): FloatingPosition {
  const minLeft = viewport.left + margin;
  const maxRight = viewport.left + viewport.width - margin;
  const minTop = viewport.top + margin;
  const maxBottom = viewport.top + viewport.height - margin;
  const belowTop = anchor.bottom + gap;
  const aboveTop = anchor.top - gap - surface.height;
  const roomBelow = maxBottom - belowTop;
  const roomAbove = anchor.top - gap - minTop;
  const placement = roomBelow >= surface.height || roomBelow >= roomAbove ? "below" : "above";
  const preferredTop = placement === "below" ? belowTop : aboveTop;

  return {
    left: clamp(anchor.right - surface.width, minLeft, maxRight - surface.width),
    top: clamp(preferredTop, minTop, maxBottom - surface.height),
    placement,
  };
}
