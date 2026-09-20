import { describe, expect, it, vi } from "vitest";
import { OrderedPtyWriter } from "./ptyInput";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("OrderedPtyWriter", () => {
  it("keeps session bytes ordered and coalesces input behind an in-flight write", async () => {
    const first = deferred<void>();
    const nativeWrite = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    const writer = new OrderedPtyWriter(nativeWrite);

    const a = writer.write("session", "a");
    const b = writer.write("session", "b");
    const c = writer.write("session", "c");

    expect(nativeWrite).toHaveBeenCalledTimes(1);
    expect(nativeWrite).toHaveBeenCalledWith("session", "a");

    first.resolve();
    await a;
    await Promise.resolve();

    expect(nativeWrite).toHaveBeenCalledTimes(2);
    expect(nativeWrite).toHaveBeenLastCalledWith("session", "bc");
    await Promise.all([b, c]);
  });

  it("does not let a slow session block input for another session", async () => {
    const slow = deferred<void>();
    const nativeWrite = vi.fn((sessionId: string) =>
      sessionId === "slow" ? slow.promise : Promise.resolve()
    );
    const writer = new OrderedPtyWriter(nativeWrite);

    const slowWrite = writer.write("slow", "a");
    await writer.write("fast", "b");

    expect(nativeWrite).toHaveBeenCalledWith("slow", "a");
    expect(nativeWrite).toHaveBeenCalledWith("fast", "b");
    slow.resolve();
    await slowWrite;
  });

  it("continues with later input after one native write fails", async () => {
    const first = deferred<void>();
    const nativeWrite = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    const writer = new OrderedPtyWriter(nativeWrite);

    const failed = writer.write("session", "a");
    const recovered = writer.write("session", "b");
    first.reject(new Error("synthetic failure"));

    await expect(failed).rejects.toThrow("synthetic failure");
    await expect(recovered).resolves.toBeUndefined();
    expect(nativeWrite).toHaveBeenLastCalledWith("session", "b");
  });
});
