import { describe, expect, it } from "vitest";
import { SubmittedPromptCapture } from "./titleInput";

describe("SubmittedPromptCapture", () => {
  it("captures typed text only when Enter submits it", () => {
    const capture = new SubmittedPromptCapture();

    expect(capture.observe("session", "Fix the sessin\x7fon identity")).toBeNull();
    expect(capture.observe("session", "\r")).toBe("Fix the session identity");
    expect(capture.observe("session", "ignored later\r")).toBeNull();
  });

  it("keeps bracketed multiline paste as one submitted message", () => {
    const capture = new SubmittedPromptCapture();

    expect(capture.observe("session", "\x1b[200~First line\nsecond line\x1b[201~")).toBeNull();
    expect(capture.observe("session", "\r")).toBe("First line second line");
  });

  it("skips slash commands and captures the next real message", () => {
    const capture = new SubmittedPromptCapture();

    expect(capture.observe("session", "/model\r")).toBeNull();
    expect(capture.observe("session", "Explain this failure\r")).toBe("Explain this failure");
  });
});
