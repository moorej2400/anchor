import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon } from "./Icon";

describe("Icon", () => {
  it("renders the requested SVG without relying on a font glyph", () => {
    const { container } = render(<Icon name="settings" size={18} />);
    const svg = container.querySelector("svg");

    expect(svg).toHaveAttribute("viewBox", "0 0 24 24");
    expect(svg).toHaveAttribute("width", "18");
    expect(svg).toHaveClass("app-icon");
    expect(svg?.querySelectorAll("path, circle")).toHaveLength(2);
  });

  it("uses the same eyelet-and-arms anchor mark as the application chrome", () => {
    const { container } = render(<Icon name="anchor" />);

    expect(container.querySelector("circle")).toHaveAttribute("r", "2.5");
    expect(container.querySelector("path")).toHaveAttribute(
      "d",
      "M12 7.5V20M6 12h12M6 12c0 4 2.2 7 6 8M18 12c0 4-2.2 7-6 8",
    );
  });
});
