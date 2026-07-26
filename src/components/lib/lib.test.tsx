import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Badge } from "./Badge";
import { StatusDot } from "./StatusDot";
import { Toggle } from "./Toggle";

describe("Badge", () => {
  it("renders the tool monogram", () => {
    render(<Badge tool="claude" />);
    expect(screen.getByText("cc")).toBeInTheDocument();
  });
});

describe("StatusDot", () => {
  it("renders a dot for running/waiting but nothing for stopped", () => {
    const { container: running } = render(<StatusDot status="running" />);
    expect(running.querySelector(".a-dot")).not.toBeNull();

    const { container: stopped } = render(<StatusDot status="stopped" />);
    expect(stopped.querySelector(".a-dot")).toBeNull();
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
