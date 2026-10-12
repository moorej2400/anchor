import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyReplay } from "./types";

describe("browser preview terminal replay", () => {
  beforeEach(() => vi.resetModules());

  it("restores sample output for saved live sessions on first load", async () => {
    const { mockInvoke } = await import("./mock");
    const replay = await mockInvoke<PtyReplay>("replay_output", { sessionId: "w-claude" });

    expect(replay.data).toContain("Claude Code");
    expect(replay.data).toContain("refactor auth middleware");
    expect(replay.throughSequence).toBe(0);
  });

  it("includes live output in replay at its matching sequence boundary", async () => {
    const { mockInvoke } = await import("./mock");
    await mockInvoke("write_pty", { sessionId: "w-claude", data: "synthetic input\r\n" });
    const replay = await mockInvoke<PtyReplay>("replay_output", { sessionId: "w-claude" });

    expect(replay.data).toContain("Claude Code");
    expect(replay.data).toContain("synthetic input\r\n");
    expect(replay.throughSequence).toBe(1);
    expect(await mockInvoke("get_scrollback", { sessionId: "w-claude" })).toBe(replay.data);
  });
});
