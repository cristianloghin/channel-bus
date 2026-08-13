import { afterEach, describe, expect, it, vi } from "vitest";
import { Channel, claimAction, openActions, releaseClaims } from "./channel";
import type { DebugMessage } from "./types";

type TestContract = {
  "test:ping": { value: number };
  "test:pong": { value: string };
};

const STORM_CONFIG = { maxMessages: 100, windowMs: 1000 };
const noop = () => {};

function makeChannel(onEmit = noop as (msg: DebugMessage) => void) {
  return new Channel<TestContract>("test", "", null, STORM_CONFIG, onEmit);
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
      null,
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
    const ch = new Channel<TestContract>("test", "", null, STORM_CONFIG, onEmit);
    ch.on("test:ping", async () => {});
    await ch.emit("test:ping", { value: 1 });
    expect(onEmit).toHaveBeenCalledTimes(1);
  });

  it("debug message includes correct namespace and qualifiedChannel", async () => {
    const onEmit = vi.fn();
    const ch = new Channel<TestContract>("playback", "vms", null, STORM_CONFIG, onEmit);
    ch.on("test:ping", async () => {});
    await ch.emit("test:ping", { value: 1 });

    const msg: DebugMessage = onEmit.mock.calls[0][0];
    expect(msg.namespace).toBe("vms");
    expect(msg.channel).toBe("playback");
    expect(msg.qualifiedChannel).toBe("vms:playback");
  });

  it("debug message has empty namespace and unqualified qualifiedChannel when no namespace", async () => {
    const onEmit = vi.fn();
    const ch = new Channel<TestContract>("events", "", null, STORM_CONFIG, onEmit);
    ch.on("test:ping", async () => {});
    await ch.emit("test:ping", { value: 1 });

    const msg: DebugMessage = onEmit.mock.calls[0][0];
    expect(msg.namespace).toBe("");
    expect(msg.qualifiedChannel).toBe("events");
  });
});

describe("Channel — buffering", () => {
  const BUFFER_CONFIG = { maxMessages: 100, maxAgeMs: 10_000 };

  function makeBufferedChannel(onEmit = noop as (msg: DebugMessage) => void) {
    return new Channel<TestContract>(
      "test",
      "",
      BUFFER_CONFIG,
      STORM_CONFIG,
      onEmit,
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a closed action's emit resolves [] and does not call a subscribed handler", async () => {
    const ch = makeBufferedChannel();
    const cb = vi.fn().mockResolvedValue(undefined);
    ch.on("test:ping", cb);

    const results = await ch.emit("test:ping", { value: 1 });

    expect(results).toEqual([]);
    expect(cb).not.toHaveBeenCalled();
  });

  it("buffers even with no subscribers at all (no warning, no throw)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ch = makeBufferedChannel();
    const results = await ch.emit("test:ping", { value: 1 });
    expect(results).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("buffered emits still reach the debug wiretap", async () => {
    const onEmit = vi.fn();
    const ch = makeBufferedChannel(onEmit);
    await ch.emit("test:ping", { value: 1 });
    expect(onEmit).toHaveBeenCalledTimes(1);
  });

  it("a message dropped by middleware never reaches the buffer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ch = new Channel<TestContract>(
      "test",
      "",
      { maxMessages: 1, maxAgeMs: 10_000 },
      STORM_CONFIG,
      noop,
    );
    await ch.emit("test:ping", { value: 1 }); // fills the one-slot buffer

    ch.use(() => {}); // swallows every subsequent emit — never calls next()
    await ch.emit("test:ping", { value: 2 });

    // Had the dropped message reached the buffer, the one-slot bound would
    // have evicted the first message with an overflow warning.
    expect(warn).not.toHaveBeenCalled();
  });

  it("unbuffered channels deliver immediately (regression)", async () => {
    const ch = makeChannel();
    const cb = vi.fn().mockResolvedValue(undefined);
    ch.on("test:ping", cb);
    await ch.emit("test:ping", { value: 1 });
    expect(cb).toHaveBeenCalledOnce();
  });
});

describe("Channel — claim/open/drain", () => {
  const BUFFER_CONFIG = { maxMessages: 100, maxAgeMs: 10_000 };

  function makeBufferedChannel(onEmit = noop as (msg: DebugMessage) => void) {
    return new Channel<TestContract>(
      "test",
      "",
      BUFFER_CONFIG,
      STORM_CONFIG,
      onEmit,
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drains a claimed action to subscribers in emit order, marked deferred", async () => {
    const ch = makeBufferedChannel();
    const mailbox = {};
    const cb = vi.fn().mockResolvedValue(undefined);
    ch.on("test:ping", cb);

    await ch.emit("test:ping", { value: 1 });
    await ch.emit("test:ping", { value: 2 });
    expect(cb).not.toHaveBeenCalled();

    ch[claimAction]("test:ping", mailbox);
    ch[openActions](mailbox);
    await Promise.resolve();

    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[0][0]).toEqual({ value: 1 });
    expect(cb.mock.calls[1][0]).toEqual({ value: 2 });
    expect(cb.mock.calls[0][1].message.deferred).toBe(true);
    expect(cb.mock.calls[1][1].message.deferred).toBe(true);
  });

  it("preserves cross-action emit order within one claimant's drain", async () => {
    const ch = makeBufferedChannel();
    const mailbox = {};
    const order: string[] = [];
    ch.on("test:ping", async (p) => {
      order.push(`ping:${p.value}`);
    });
    ch.on("test:pong", async (p) => {
      order.push(`pong:${p.value}`);
    });

    await ch.emit("test:ping", { value: 1 });
    await ch.emit("test:pong", { value: "x" });
    await ch.emit("test:ping", { value: 2 });

    ch[claimAction]("test:ping", mailbox);
    ch[claimAction]("test:pong", mailbox);
    ch[openActions](mailbox);
    await Promise.resolve();

    expect(order).toEqual(["ping:1", "pong:x", "ping:2"]);
  });

  it("drained deliveries preserve the original message identity", async () => {
    const emitted: DebugMessage[] = [];
    const ch = makeBufferedChannel((msg) => emitted.push(msg));
    const mailbox = {};
    const cb = vi.fn().mockResolvedValue(undefined);
    ch.on("test:ping", cb);

    await ch.emit("test:ping", { value: 7 }, { from: "host" });

    ch[claimAction]("test:ping", mailbox);
    ch[openActions](mailbox);
    await Promise.resolve();

    const delivered = cb.mock.calls[0][1].message;
    expect(delivered.id).toBe(emitted[0].messageId);
    expect(delivered.from).toBe("host");
    expect(delivered.timestamp).toBe(emitted[0].timestamp);
    expect(delivered.coordinationChain).toEqual(emitted[0].coordinationChain);
  });

  it("unclaimed actions stay buffered until their own claimant opens", async () => {
    const ch = makeBufferedChannel();
    const playback = {};
    const seek = {};
    const pingCb = vi.fn().mockResolvedValue(undefined);
    const pongCb = vi.fn().mockResolvedValue(undefined);
    ch.on("test:ping", pingCb);
    ch.on("test:pong", pongCb);

    await ch.emit("test:ping", { value: 1 });
    await ch.emit("test:pong", { value: "x" });

    ch[claimAction]("test:ping", playback);
    ch[openActions](playback);
    await Promise.resolve();

    expect(pingCb).toHaveBeenCalledOnce();
    expect(pongCb).not.toHaveBeenCalled();

    // The second subsystem arrives later and collects its own backlog.
    ch[claimAction]("test:pong", seek);
    ch[openActions](seek);
    await Promise.resolve();

    expect(pongCb).toHaveBeenCalledOnce();
  });

  it("live emissions pass through once the action is open", async () => {
    const ch = makeBufferedChannel();
    const mailbox = {};
    const cb = vi.fn().mockResolvedValue(undefined);
    ch.on("test:ping", cb);

    ch[claimAction]("test:ping", mailbox);
    ch[openActions](mailbox);

    const results = await ch.emit("test:ping", { value: 3 });

    expect(results).toHaveLength(1);
    expect(cb).toHaveBeenCalledOnce();
    expect(cb.mock.calls[0][1].message.deferred).toBeUndefined();
  });

  it("the drain does not re-emit debug events", async () => {
    const onEmit = vi.fn();
    const ch = makeBufferedChannel(onEmit);
    const mailbox = {};
    ch.on("test:ping", async () => {});

    await ch.emit("test:ping", { value: 1 });
    await ch.emit("test:ping", { value: 2 });
    expect(onEmit).toHaveBeenCalledTimes(2);

    ch[claimAction]("test:ping", mailbox);
    ch[openActions](mailbox);
    await Promise.resolve();

    expect(onEmit).toHaveBeenCalledTimes(2);
  });

  it("a claim conflict surfaces through the channel", () => {
    const ch = makeBufferedChannel();
    ch[claimAction]("test:ping", {});
    expect(() => ch[claimAction]("test:ping", {})).toThrow(
      /already claimed by another mailbox/,
    );
  });

  it("releaseClaims frees an unopened claim", () => {
    const ch = makeBufferedChannel();
    const first = {};
    ch[claimAction]("test:ping", first);
    ch[releaseClaims](first);
    expect(() => ch[claimAction]("test:ping", {})).not.toThrow();
  });

  it("openActions after destroy() is a no-op", async () => {
    const ch = makeBufferedChannel();
    const mailbox = {};
    const cb = vi.fn().mockResolvedValue(undefined);
    ch.on("test:ping", cb);
    await ch.emit("test:ping", { value: 1 });
    ch[claimAction]("test:ping", mailbox);

    ch.destroy();
    expect(() => ch[openActions](mailbox)).not.toThrow();
    await Promise.resolve();
    expect(cb).not.toHaveBeenCalled();
  });

  it("claim, open, and release are no-ops on unbuffered channels", () => {
    const ch = makeChannel();
    const mailbox = {};
    expect(() => {
      ch[claimAction]("test:ping", mailbox);
      ch[openActions](mailbox);
      ch[releaseClaims](mailbox);
    }).not.toThrow();
  });
});
