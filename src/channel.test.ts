import { afterEach, describe, expect, it, vi } from "vitest";
import { Channel } from "./channel";
import type { DebugMessage } from "./types";

type TestContract = {
  "test:ping": { value: number };
  "test:pong": { value: string };
};

const STORM_CONFIG = { maxMessages: 100, windowMs: 1000 };
const noop = () => {};

function makeChannel(onEmit = noop as (msg: DebugMessage) => void) {
  return new Channel<TestContract>("test", "", STORM_CONFIG, onEmit);
}

describe("Channel — delivery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delivers the correct payload and meta to a matching handler", async () => {
    const ch = makeChannel();
    const received: unknown[] = [];
    ch.on("test:ping", async (payload, { message }) => {
      received.push(payload);
      received.push(message.action);
    });
    await ch.emit("test:ping", { value: 42 });
    expect(received).toEqual([{ value: 42 }, "test:ping"]);
  });

  it("does not deliver to handlers registered for a different action", async () => {
    const ch = makeChannel();
    const cb = vi.fn().mockResolvedValue(undefined);
    ch.on("test:pong", cb);
    await ch.emit("test:ping", { value: 1 });
    expect(cb).not.toHaveBeenCalled();
  });

  it("delivers to multiple handlers on the same action", async () => {
    const ch = makeChannel();
    const cb1 = vi.fn().mockResolvedValue(undefined);
    const cb2 = vi.fn().mockResolvedValue(undefined);
    ch.on("test:ping", cb1);
    ch.on("test:ping", cb2);
    await ch.emit("test:ping", { value: 7 });
    expect(cb1).toHaveBeenCalledOnce();
    expect(cb2).toHaveBeenCalledOnce();
  });

  it("unsubscribe function stops delivery", async () => {
    const ch = makeChannel();
    const cb = vi.fn().mockResolvedValue(undefined);
    const unsub = ch.on("test:ping", cb);
    unsub();
    await ch.emit("test:ping", { value: 1 });
    expect(cb).not.toHaveBeenCalled();
  });

  it("resolves after all handlers have settled", async () => {
    const ch = makeChannel();
    const order: string[] = [];
    ch.on("test:ping", async () => {
      await Promise.resolve();
      order.push("first");
    });
    ch.on("test:ping", async () => {
      await Promise.resolve();
      order.push("second");
    });
    await ch.emit("test:ping", { value: 0 });
    expect(order).toHaveLength(2);
  });

  it("uses allSettled — a rejecting handler does not prevent others from running", async () => {
    const ch = makeChannel();
    const ran: boolean[] = [];
    ch.on("test:ping", async () => {
      throw new Error("boom");
    });
    ch.on("test:ping", async () => {
      ran.push(true);
    });
    const results = await ch.emit("test:ping", { value: 0 });
    expect(ran).toEqual([true]);
    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("fulfilled");
  });

  it("returns SettledResult[] reflecting each handler outcome", async () => {
    const ch = makeChannel();
    ch.on("test:ping", async () => { /* ok */ });
    ch.on("test:ping", async () => { throw new Error("fail"); });
    const results = await ch.emit("test:ping", { value: 0 });
    expect(results).toHaveLength(2);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual(["fulfilled", "rejected"]);
  });

  it("returns [] when no handlers are registered", async () => {
    const ch = makeChannel();
    const results = await ch.emit("test:ping", { value: 1 });
    expect(results).toEqual([]);
  });

  it("abort signal on on() removes the handler when aborted", async () => {
    const ch = makeChannel();
    const cb = vi.fn().mockResolvedValue(undefined);
    const controller = new AbortController();
    ch.on("test:ping", cb, { signal: controller.signal });
    await ch.emit("test:ping", { value: 1 });
    controller.abort();
    await ch.emit("test:ping", { value: 2 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("abort signal already aborted on on() — handler is never registered", async () => {
    const ch = makeChannel();
    const cb = vi.fn().mockResolvedValue(undefined);
    const controller = new AbortController();
    controller.abort();
    ch.on("test:ping", cb, { signal: controller.signal });
    await ch.emit("test:ping", { value: 1 });
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("Channel — emit signal", () => {
  it("emit with already-aborted signal returns [] without calling any handler", async () => {
    const ch = makeChannel();
    const cb = vi.fn().mockResolvedValue(undefined);
    ch.on("test:ping", cb);
    const controller = new AbortController();
    controller.abort();
    const results = await ch.emit("test:ping", { value: 1 }, { signal: controller.signal });
    expect(results).toEqual([]);
    expect(cb).not.toHaveBeenCalled();
  });

  it("handler receives the signal from emit options", async () => {
    const ch = makeChannel();
    let receivedSignal: AbortSignal | undefined;
    ch.on("test:ping", async (_payload, _meta, signal) => {
      receivedSignal = signal;
    });
    const controller = new AbortController();
    await ch.emit("test:ping", { value: 1 }, { signal: controller.signal });
    expect(receivedSignal).toBe(controller.signal);
  });

  it("handler receives a non-aborted signal when no signal is provided in options", async () => {
    const ch = makeChannel();
    let receivedSignal: AbortSignal | undefined;
    ch.on("test:ping", async (_payload, _meta, signal) => {
      receivedSignal = signal;
    });
    await ch.emit("test:ping", { value: 1 });
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(false);
  });

  it("signal aborts mid-fan-out — unstarted handlers are skipped", async () => {
    const ch = makeChannel();
    const controller = new AbortController();
    const order: string[] = [];
    ch.on("test:ping", async () => {
      order.push("first");
      controller.abort();
    });
    ch.on("test:ping", async () => {
      order.push("second");
    });
    await ch.emit("test:ping", { value: 1 }, { signal: controller.signal });
    expect(order).toEqual(["first"]);
  });
});

describe("Channel — middleware", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs middleware in insertion order", async () => {
    const ch = makeChannel();
    const order: number[] = [];
    ch.use((_, next) => { order.push(1); next(); });
    ch.use((_, next) => { order.push(2); next(); });
    await ch.emit("test:ping", { value: 0 });
    expect(order).toEqual([1, 2]);
  });

  it("middleware that does not call next() prevents delivery", async () => {
    const ch = makeChannel();
    const cb = vi.fn().mockResolvedValue(undefined);
    ch.use((_msg, _next) => { /* deliberately does not call next */ });
    ch.on("test:ping", cb);
    await ch.emit("test:ping", { value: 1 });
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("Channel — guards", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies storm check — drops message from a flooding sender", async () => {
    const ch = new Channel<TestContract>(
      "test",
      "",
      { maxMessages: 2, windowMs: 1000 },
      noop,
    );
    const cb = vi.fn().mockResolvedValue(undefined);
    ch.on("test:ping", cb);
    await ch.emit("test:ping", { value: 1 }, { from: "spammer" });
    await ch.emit("test:ping", { value: 2 }, { from: "spammer" });
    await ch.emit("test:ping", { value: 3 }, { from: "spammer" }); // dropped
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("loop check — emitting a different action inside a handler should NOT trigger loop warning", async () => {
    // Regression: channel emits "ping", handler catches it and emits "pong"
    // propagating the coordination chain. This is a one-shot downstream hop,
    // NOT a loop. The loop guard must not flag it.
    const ch = makeChannel();
    const pongCb = vi.fn();
    ch.on("test:pong", async () => { pongCb(); });

    ch.on("test:ping", async (_, { message }) => {
      await ch.emit("test:pong", { value: "from-ping" }, { coordinationChain: message.coordinationChain });
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await ch.emit("test:ping", { value: 1 });

    expect(warn).not.toHaveBeenCalled();
    expect(pongCb).toHaveBeenCalledOnce();
  });

  it("loop check — A→B→A is detected as a loop and the second A is dropped", async () => {
    // "ping" handler emits "pong" (allowed). "pong" handler tries to re-emit
    // "ping" — this IS a loop and must be blocked.
    const ch = makeChannel();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const secondPingCb = vi.fn();

    ch.on("test:pong", async (_, { message }) => {
      await ch.emit("test:ping", { value: 99 }, { coordinationChain: message.coordinationChain });
    });

    ch.on("test:ping", async (_, { message }) => {
      secondPingCb();
      await ch.emit("test:pong", { value: "hop" }, { coordinationChain: message.coordinationChain });
    });

    await ch.emit("test:ping", { value: 1 });

    expect(secondPingCb).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[chbus]"));
  });

  it("applies loop check — drops message with own coordination ID in the chain", async () => {
    const ch = makeChannel();
    const cb = vi.fn().mockResolvedValue(undefined);
    ch.on("test:ping", cb);

    let capturedChain: string[] = [];
    ch.on("test:ping", async (_, { message }) => {
      capturedChain = message.coordinationChain;
    });
    await ch.emit("test:ping", { value: 1 });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await ch.emit("test:ping", { value: 2 }, { coordinationChain: capturedChain });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[chbus]"));
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("Channel — lifecycle", () => {
  it("destroy() stops delivery and warns on subsequent emit()", async () => {
    const ch = makeChannel();
    const cb = vi.fn().mockResolvedValue(undefined);
    ch.on("test:ping", cb);
    ch.destroy();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await ch.emit("test:ping", { value: 1 });

    expect(cb).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("Channel — debug wiretap", () => {
  it("emit() forwards to the debug wiretap", async () => {
    const onEmit = vi.fn();
    const ch = new Channel<TestContract>("test", "", STORM_CONFIG, onEmit);
    ch.on("test:ping", async () => {});
    await ch.emit("test:ping", { value: 1 });
    expect(onEmit).toHaveBeenCalledTimes(1);
  });

  it("debug message includes correct namespace and qualifiedChannel", async () => {
    const onEmit = vi.fn();
    const ch = new Channel<TestContract>("playback", "vms", STORM_CONFIG, onEmit);
    ch.on("test:ping", async () => {});
    await ch.emit("test:ping", { value: 1 });

    const msg: DebugMessage = onEmit.mock.calls[0][0];
    expect(msg.namespace).toBe("vms");
    expect(msg.channel).toBe("playback");
    expect(msg.qualifiedChannel).toBe("vms:playback");
  });

  it("debug message has empty namespace and unqualified qualifiedChannel when no namespace", async () => {
    const onEmit = vi.fn();
    const ch = new Channel<TestContract>("events", "", STORM_CONFIG, onEmit);
    ch.on("test:ping", async () => {});
    await ch.emit("test:ping", { value: 1 });

    const msg: DebugMessage = onEmit.mock.calls[0][0];
    expect(msg.namespace).toBe("");
    expect(msg.qualifiedChannel).toBe("events");
  });
});
