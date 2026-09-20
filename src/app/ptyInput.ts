interface PendingWrite {
  data: string;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface SessionWriteQueue {
  inFlight: boolean;
  pending: PendingWrite[];
}

/**
 * Keeps PTY input ordered per session while coalescing input that arrives
 * behind one native IPC write. Different sessions never block each other.
 */
export class OrderedPtyWriter {
  private queues = new Map<string, SessionWriteQueue>();

  constructor(
    private writePty: (sessionId: string, data: string) => Promise<void>,
  ) {}

  write(sessionId: string, data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(sessionId) ?? { inFlight: false, pending: [] };
      queue.pending.push({ data, resolve, reject });
      this.queues.set(sessionId, queue);
      this.pump(sessionId, queue);
    });
  }

  private pump(sessionId: string, queue: SessionWriteQueue): void {
    if (queue.inFlight || queue.pending.length === 0) return;

    // One in-flight call is the ordering barrier. Input accumulated behind it
    // can share the next IPC round trip without changing byte order.
    const batch = queue.pending.splice(0);
    const data = batch.map((write) => write.data).join("");
    queue.inFlight = true;

    let write: Promise<void>;
    try {
      write = this.writePty(sessionId, data);
    } catch (error) {
      write = Promise.reject(error);
    }
    void write.then(
      () => batch.forEach((item) => item.resolve()),
      (error) => batch.forEach((item) => item.reject(error)),
    ).finally(() => {
      queue.inFlight = false;
      if (queue.pending.length > 0) {
        this.pump(sessionId, queue);
      } else if (this.queues.get(sessionId) === queue) {
        this.queues.delete(sessionId);
      }
    });
  }
}
