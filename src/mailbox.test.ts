import { afterEach, describe, expect, it, vi } from "vitest";
import { createBus } from "./bus";
import { Channel } from "./channel";

// ── Helpers ───────────────────────────────────────────────────────────────────

type PlaybackContract = {
  tick: { frame: number };
  seek: { position: number };
  init: { src: string };
};

type CameraContract = {
  "camera-select": { id: string };
};

const STORM = { maxMessages: 100, windowMs: 1000 };
const noop = () => {};

function makeChannel<C extends Record<string, unknown>>(
  name = "ch",
): Channel<C> {
  return new Channel<C>(name, "", STORM, noop);
}

// Creates a deferred promise — resolve() to unblock an awaiting handler.
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Flush all pending microtasks and one macrotask turn.
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Mailbox — serial execution", () => {
  afterEach(() => { vi.restoreAllMocks() });

  it("processes messages one at a time — second waits for first to finish", async () => {
    const bus = createBus();
    const ch = makeChannel<PlaybackContract>("playback");
    const mailbox = bus.createMailbox({ ch });

    const d = deferred();
    const order: string[] = [];

    mailbox.on("ch", "tick", async ({ frame }) => {
      order.push(`start-${frame}`);
      if (frame === 1) await d.promise;
      order.push(`end-${frame}`);
    });

    void ch.emit("tick", { frame: 1 });
    void ch.emit("tick", { frame: 2 });

    await tick();
    // First handler is running, second is queued
    expect(order).toEqual(["start-1"]);

    d.resolve();
    await tick();
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);

    mailbox.destroy();
    bus.destroy();
  });

  it("processes messages across independent channels concurrently", async () => {
    const bus = createBus();
    const playback = makeChannel<PlaybackContract>("playback");
    const camera = makeChannel<CameraContract>("camera");
    const mailbox = bus.createMailbox({ playback, camera });

    const d = deferred();
    const order: string[] = [];

    mailbox.on("playback", "tick", async () => {
      order.push("tick-start");
      await d.promise;
      order.push("tick-end");
    });

    mailbox.on("camera", "camera-select", async () => {
      order.push("camera");
    });

    void playback.emit("tick", { frame: 1 });
    void camera.emit("camera-select", { id: "cam-1" });

    await tick();
    // camera handler should have run (its queue is independent of playback)
    expect(order).toContain("camera");
    expect(order).toContain("tick-start");
    expect(order).not.toContain("tick-end");

    d.resolve();
    mailbox.destroy();
    bus.destroy();
  });
});

describe("Mailbox — interrupt mode: replace", () => {
  it("aborts the running handler and runs the new arrival", async () => {
    const bus = createBus();
    const ch = makeChannel<PlaybackContract>("playback");
    const mailbox = bus.createMailbox(
      { ch },
      { ch: { tick: [{ interrupts: "tick", mode: "replace" }] } },
    );

    const d = deferred();
    let capturedSignal!: AbortSignal;
    const order: string[] = [];

    mailbox.on("ch", "tick", async ({ frame }, _meta, signal) => {
      capturedSignal = signal;
      order.push(`start-${frame}`);
      await d.promise;
      order.push(`end-${frame}`);
    });

    // Emit first tick — it starts running
    void ch.emit("tick", { frame: 1 });
    await tick();
    expect(order).toEqual(["start-1"]);

    // Emit second tick — replace rule fires
    void ch.emit("tick", { frame: 2 });
    await tick();

    // First handler's signal must be aborted
    expect(capturedSignal.aborted).toBe(true);

    // Unblock first handler so drain can proceed
    d.resolve();
    await tick();

    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);

    mailbox.destroy();
    bus.destroy();
  });

  it("clears all pending instances of the interrupted type", async () => {
    const bus = createBus();
    const ch = makeChannel<PlaybackContract>("playback");
    const mailbox = bus.createMailbox(
      { ch },
      { ch: { tick: [{ interrupts: "tick", mode: "replace" }] } },
    );

    const d = deferred();
    const ran: number[] = [];

    mailbox.on("ch", "tick", async ({ frame }) => {
      if (frame === 1) await d.promise;
      ran.push(frame);
    });

    // Emit tick 1 (starts running), then queue ticks 2 and 3 while 1 runs
    void ch.emit("tick", { frame: 1 });
    await tick(); // tick 1 is now running

    void ch.emit("tick", { frame: 2 }); // queued
    void ch.emit("tick", { frame: 3 }); // queued
    await tick();

    // Emit tick 4 — replace rule: aborts tick 1, clears ticks 2 & 3 from queue
    void ch.emit("tick", { frame: 4 });
    await tick();

    d.resolve();
    await tick();

    // Only tick 1 (ran before abort) and tick 4 (the replacement) should have run
    expect(ran).toEqual([1, 4]);

    mailbox.destroy();
    bus.destroy();
  });
});

describe("Mailbox — interrupt mode: abort", () => {
  it("aborts running handler, places arrival at front, keeps other pending items", async () => {
    const bus = createBus();
    const ch = makeChannel<PlaybackContract>("playback");
    const mailbox = bus.createMailbox(
      { ch },
      { ch: { seek: [{ interrupts: "tick", mode: "abort" }] } },
    );

    const d = deferred();
    let tickAborted = false;
    const order: string[] = [];

    mailbox.on("ch", "tick", async (_payload, _meta, signal) => {
      order.push("tick-start");
      await d.promise;
      tickAborted = signal.aborted;
      order.push("tick-end");
    });

    mailbox.on("ch", "seek", async ({ position }) => {
      order.push(`seek-${position}`);
    });

    mailbox.on("ch", "init", async ({ src }) => {
      order.push(`init-${src}`);
    });

    // Emit tick (starts running), queue init, then seek arrives
    void ch.emit("tick", { frame: 1 });
    await tick(); // tick running

    void ch.emit("init", { src: "video.mp4" }); // pending
    await tick();

    // seek arrives — aborts tick, places seek before init
    void ch.emit("seek", { position: 30 });
    await tick();

    d.resolve();
    await tick();

    expect(tickAborted).toBe(true);
    // seek must have run before init
    expect(order).toEqual(["tick-start", "tick-end", "seek-30", "init-video.mp4"]);

    mailbox.destroy();
    bus.destroy();
  });
});

describe("Mailbox — interrupt mode: drop-new", () => {
  it("discards the arriving message while the same type is running", async () => {
    const bus = createBus();
    const ch = makeChannel<PlaybackContract>("playback");
    const mailbox = bus.createMailbox(
      { ch },
      { ch: { init: [{ interrupts: "init", mode: "drop-new" }] } },
    );

    const d = deferred();
    const ran: string[] = [];

    mailbox.on("ch", "init", async ({ src }) => {
      ran.push(src);
      await d.promise;
    });

    void ch.emit("init", { src: "first.mp4" });
    await tick(); // running

    void ch.emit("init", { src: "second.mp4" }); // should be dropped
    await tick();

    expect(ran).toEqual(["first.mp4"]);

    d.resolve();
    await tick();
    // second was dropped — only first ran
    expect(ran).toEqual(["first.mp4"]);

    mailbox.destroy();
    bus.destroy();
  });

  it("allows the same type to run again after the in-flight handler finishes", async () => {
    const bus = createBus();
    const ch = makeChannel<PlaybackContract>("playback");
    const mailbox = bus.createMailbox(
      { ch },
      { ch: { init: [{ interrupts: "init", mode: "drop-new" }] } },
    );

    const ran: string[] = [];

    mailbox.on("ch", "init", async ({ src }) => {
      ran.push(src);
    });

    void ch.emit("init", { src: "first.mp4" });
    await tick();
    void ch.emit("init", { src: "second.mp4" });
    await tick();

    expect(ran).toEqual(["first.mp4", "second.mp4"]);

    mailbox.destroy();
    bus.destroy();
  });
});

describe("Mailbox — no rules", () => {
  it("acts as a plain serial FIFO queue when no rules are provided", async () => {
    const bus = createBus();
    const ch = makeChannel<PlaybackContract>("playback");
    const mailbox = bus.createMailbox({ ch });

    const d = deferred();
    const order: string[] = [];

    mailbox.on("ch", "tick", async ({ frame }) => {
      if (frame === 1) await d.promise;
      order.push(`tick-${frame}`);
    });

    void ch.emit("tick", { frame: 1 });
    await tick();
    void ch.emit("tick", { frame: 2 });
    void ch.emit("tick", { frame: 3 });

    d.resolve();
    await tick();

    expect(order).toEqual(["tick-1", "tick-2", "tick-3"]);

    mailbox.destroy();
    bus.destroy();
  });
});

describe("Mailbox — signal threading", () => {
  it("handler always receives a signal even with no rules", async () => {
    const bus = createBus();
    const ch = makeChannel<PlaybackContract>("playback");
    const mailbox = bus.createMailbox({ ch });

    let receivedSignal: AbortSignal | undefined;
    mailbox.on("ch", "tick", async (_payload, _meta, signal) => {
      receivedSignal = signal;
    });

    await ch.emit("tick", { frame: 1 });
    await tick();

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(false);

    mailbox.destroy();
    bus.destroy();
  });

  it("emitter signal propagates through the mailbox to the handler", async () => {
    const bus = createBus();
    const ch = makeChannel<PlaybackContract>("playback");
    const mailbox = bus.createMailbox({ ch });

    let receivedSignal: AbortSignal | undefined;
    mailbox.on("ch", "tick", async (_payload, _meta, signal) => {
      receivedSignal = signal;
    });

    const controller = new AbortController();
    await ch.emit("tick", { frame: 1 }, { signal: controller.signal });
    await tick();

    // The combined signal is not the same object, but aborting the emitter's
    // controller must also abort the combined signal.
    expect(receivedSignal).toBeDefined();
    controller.abort();
    expect(receivedSignal!.aborted).toBe(true);

    mailbox.destroy();
    bus.destroy();
  });

  it("destroy() aborts the in-flight handler's signal", async () => {
    const bus = createBus();
    const ch = makeChannel<PlaybackContract>("playback");
    const mailbox = bus.createMailbox({ ch });

    const d = deferred();
    let capturedSignal!: AbortSignal;

    mailbox.on("ch", "tick", async (_payload, _meta, signal) => {
      capturedSignal = signal;
      await d.promise;
    });

    void ch.emit("tick", { frame: 1 });
    await tick();

    expect(capturedSignal.aborted).toBe(false);
    mailbox.destroy();
    expect(capturedSignal.aborted).toBe(true);

    d.resolve();
    bus.destroy();
  });
});

describe("Mailbox — constraints", () => {
  it("throws when registering a second handler for the same action on the same channel", () => {
    const bus = createBus();
    const ch = makeChannel<PlaybackContract>("playback");
    const mailbox = bus.createMailbox({ ch });

    mailbox.on("ch", "tick", async () => {});
    expect(() => {
      mailbox.on("ch", "tick", async () => {});
    }).toThrow("[chbus] Mailbox already has a handler");

    mailbox.destroy();
    bus.destroy();
  });

  it("destroy() unsubscribes all channels — no further messages are delivered", async () => {
    const bus = createBus();
    const ch = makeChannel<PlaybackContract>("playback");
    const mailbox = bus.createMailbox({ ch });

    const cb = vi.fn();
    mailbox.on("ch", "tick", async () => {
      cb();
    });

    mailbox.destroy();

    await ch.emit("tick", { frame: 1 });
    await tick();

    expect(cb).not.toHaveBeenCalled();
    bus.destroy();
  });
});

describe("Mailbox — type inference", () => {
  it("infers payload types from the channel contract", async () => {
    const bus = createBus();
    const playback = makeChannel<PlaybackContract>("playback");
    const camera = makeChannel<CameraContract>("camera");
    const mailbox = bus.createMailbox({ playback, camera });

    // TypeScript will enforce that payload types match the contract.
    // These assignments verify the types compile and carry correct values.
    let seekPosition: number | undefined;
    let cameraId: string | undefined;

    mailbox.on("playback", "seek", async ({ position }) => {
      seekPosition = position;
    });

    mailbox.on("camera", "camera-select", async ({ id }) => {
      cameraId = id;
    });

    await playback.emit("seek", { position: 42 });
    await camera.emit("camera-select", { id: "cam-7" });
    await tick();

    expect(seekPosition).toBe(42);
    expect(cameraId).toBe("cam-7");

    mailbox.destroy();
    bus.destroy();
  });

  it("createMailbox lives on Bus", () => {
    const bus = createBus();
    expect(typeof bus.createMailbox).toBe("function");
    bus.destroy();
  });
});
