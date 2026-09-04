/**
 * Reconstructs the first submitted terminal message from xterm's user-input
 * stream. PTY output never enters this parser.
 */
export class SubmittedPromptCapture {
  private buffers = new Map<string, string>();
  private completed = new Set<string>();
  private bracketedPaste = new Set<string>();

  observe(sessionId: string, data: string): string | null {
    if (this.completed.has(sessionId)) return null;
    let buffer = this.buffers.get(sessionId) ?? "";
    let paste = this.bracketedPaste.has(sessionId);

    for (let index = 0; index < data.length;) {
      if (data.startsWith("\x1b[200~", index)) {
        paste = true;
        index += 6;
        continue;
      }
      if (data.startsWith("\x1b[201~", index)) {
        paste = false;
        index += 6;
        continue;
      }
      const character = data[index] ?? "";
      if (character === "\x1b") {
        // Arrow/function-key CSI data edits the provider's line editor but is
        // not message text. Skip the complete escape sequence when present.
        const final = data.slice(index + 1).search(/[A-Za-z~]/);
        index = final < 0 ? data.length : index + final + 2;
        continue;
      }
      if (character === "\x03") {
        buffer = "";
        index += 1;
        continue;
      }
      if (character === "\x7f" || character === "\b") {
        buffer = Array.from(buffer).slice(0, -1).join("");
        index += 1;
        continue;
      }
      if (character === "\r" || character === "\n") {
        index += 1;
        if (paste) {
          if (!buffer.endsWith(" ")) buffer += " ";
          continue;
        }
        const submitted = buffer.trim().replace(/\s+/g, " ");
        buffer = "";
        this.buffers.set(sessionId, buffer);
        if (!submitted || submitted.startsWith("/")) continue;
        this.completed.add(sessionId);
        this.bracketedPaste.delete(sessionId);
        return submitted;
      }
      if (character === "\t" || character >= " ") {
        if (buffer.length < 16 * 1024) buffer += character;
      }
      index += 1;
    }

    this.buffers.set(sessionId, buffer);
    if (paste) this.bracketedPaste.add(sessionId);
    else this.bracketedPaste.delete(sessionId);
    return null;
  }

  forget(sessionId: string): void {
    this.buffers.delete(sessionId);
    this.completed.delete(sessionId);
    this.bracketedPaste.delete(sessionId);
  }
}
