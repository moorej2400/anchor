import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Badge } from "./Badge";
import { AttentionDot } from "./StatusDot";
import { Toggle } from "./Toggle";

describe("Badge", () => {
  it("renders the tool monogram", () => {
    render(<Badge tool="claude" />);
    expect(screen.getByText("cc")).toBeInTheDocument();
  });
});

describe("AttentionDot", () => {
  it("renders gray idle and blue ready states", () => {
    const { container, rerender } = render(<AttentionDot />);
    expect(container.querySelector(".a-dot")).toHaveAttribute("data-attention", "idle");
    rerender(<AttentionDot ready />);
    expect(container.querySelector(".a-dot")).toHaveAttribute("data-attention", "ready");
  });
});

describe("Toggle", () => {
  it("reflects state and fires onChange with the toggled value", () => {
    const onChange = vi.fn();
    render(<Toggle on={false} onChange={onChange} aria-label="demo" />);
    const sw = screen.getByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "false");
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
