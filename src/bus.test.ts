import { afterEach, describe, expect, it, vi } from "vitest";
import { createBus } from "./bus";
import type { DebugMessage } from "./types";

type PlaybackContract = {
  "playback:started": { cameraId: string };
  "playback:stopped": { cameraId: string };
};

type UIContract = {
  "ui:update": { label: string };
};

describe("Bus", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the same channel instance on repeated calls with the same name", () => {
    const bus = createBus();
    const ch1 = bus.channel<PlaybackContract>("playback");
    const ch2 = bus.channel<PlaybackContract>("playback");
    expect(ch1).toBe(ch2);
    bus.destroy();
  });

  it('bus.channel("debug") throws', () => {
    const bus = createBus();
    expect(() => bus.channel("debug")).toThrow("[chbus]");
    bus.destroy();
  });

  it("bus.namespace() returns a NamespacedBus with the correct namespace", () => {
    const bus = createBus();
    const ns = bus.namespace("vms");
    expect(ns.namespace).toBe("vms");
    bus.destroy();
  });

  it("two NamespacedBus instances with the same namespace return the same underlying channel", () => {
    const bus = createBus();
    const ns1 = bus.namespace("vms");
    const ns2 = bus.namespace("vms");
    const ch1 = ns1.channel<PlaybackContract>("playback");
    const ch2 = ns2.channel<PlaybackContract>("playback");
    expect(ch1).toBe(ch2);
    bus.destroy();
  });

  it("two NamespacedBus instances with different namespaces return different channels for the same name", () => {
    const bus = createBus();
    const ns1 = bus.namespace("vms");
    const ns2 = bus.namespace("analytics");
    const ch1 = ns1.channel<PlaybackContract>("events");
    const ch2 = ns2.channel<PlaybackContract>("events");
    expect(ch1).not.toBe(ch2);
    bus.destroy();
  });

  it("bus.onDebug() receives a DebugMessage when a channel emits", () => {
    const bus = createBus();
    const messages: DebugMessage[] = [];
    bus.onDebug((msg) => messages.push(msg));

    const ch = bus.channel<PlaybackContract>("playback");
    ch.on("playback:started", async () => {});
    ch.emit("playback:started", { cameraId: "cam-1" }, { from: "svc" });

    expect(messages).toHaveLength(1);
    bus.destroy();
  });

  it("DebugMessage contains correct namespace, channel, qualifiedChannel, action, payload, from", () => {
    const bus = createBus();
    const messages: DebugMessage[] = [];
    bus.onDebug((msg) => messages.push(msg));

    const ns = bus.namespace("vms");
    const ch = ns.channel<PlaybackContract>("playback");
    ch.on("playback:started", async () => {});
    ch.emit("playback:started", { cameraId: "cam-2" }, { from: "playerCore" });

    const msg = messages[0];
    expect(msg.namespace).toBe("vms");
    expect(msg.channel).toBe("playback");
    expect(msg.qualifiedChannel).toBe("vms:playback");
    expect(msg.action).toBe("playback:started");
    expect(msg.payload).toEqual({ cameraId: "cam-2" });
    expect(msg.from).toBe("playerCore");
    bus.destroy();
  });

  it("bus.destroy() destroys all channels", () => {
    const bus = createBus();
    const ch = bus.channel<PlaybackContract>("playback");
    const cb = vi.fn();
    ch.on("playback:started", cb);
    bus.destroy();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ch.emit("playback:started", { cameraId: "x" });
    expect(cb).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  describe("namespaced bus lifecycle", () => {
    it("destroy() destroys every channel in its namespace only", async () => {
      const bus = createBus();
      const vms = bus.namespace("vms");
      const analytics = bus.namespace("analytics");
      const playback = vms.channel<PlaybackContract>("playback");
      const ui = vms.channel<UIContract>("ui");
      const analyticsUi = analytics.channel<UIContract>("ui");
      const rootUi = bus.channel<UIContract>("ui");
      const playbackCb = vi.fn();
      const uiCb = vi.fn();
      const analyticsCb = vi.fn();
      const rootCb = vi.fn();

      playback.on("playback:started", playbackCb);
      ui.on("ui:update", uiCb);
      analyticsUi.on("ui:update", analyticsCb);
      rootUi.on("ui:update", rootCb);

      vms.destroy();

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await playback.emit("playback:started", { cameraId: "cam-1" });
      await ui.emit("ui:update", { label: "vms" });
      await analyticsUi.emit("ui:update", { label: "analytics" });
      await rootUi.emit("ui:update", { label: "root" });

      expect(playbackCb).not.toHaveBeenCalled();
      expect(uiCb).not.toHaveBeenCalled();
      expect(analyticsCb).toHaveBeenCalledOnce();
      expect(rootCb).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledTimes(2);
      bus.destroy();
    });

    it("destroy() applies across proxies sharing a namespace", async () => {
      const bus = createBus();
      const first = bus.namespace("vms");
      const second = bus.namespace("vms");
      const channel = first.channel<UIContract>("ui");
      const cb = vi.fn();
      channel.on("ui:update", cb);

      second.destroy();

      vi.spyOn(console, "warn").mockImplementation(() => {});
      await channel.emit("ui:update", { label: "after destroy" });
      expect(cb).not.toHaveBeenCalled();
      bus.destroy();
    });

    it("creates a fresh channel after its namespace is destroyed", () => {
      const bus = createBus();
      const first = bus.namespace("vms");
      const original = first.channel<UIContract>("ui");

      first.destroy();

      const recreated = bus.namespace("vms").channel<UIContract>("ui");
      expect(recreated).not.toBe(original);
      bus.destroy();
    });

    it("a recreated namespace does not resurrect buffered messages", async () => {
      const bus = createBus();
      const ns = bus.namespace("vms");
      const ch = ns.channel<PlaybackContract>("commands", { buffer: true });
      void ch.emit("playback:started", { cameraId: "cam-1" }); // buffered — no handler yet

      ns.destroy();

      const recreated = bus
        .namespace("vms")
        .channel<PlaybackContract>("commands", { buffer: true });
      const mailbox = bus.createMailbox({ commands: recreated });
      const cb = vi.fn().mockResolvedValue(undefined);
      mailbox.on("commands", "playback:started", cb);
      mailbox.open();
      await new Promise((r) => setTimeout(r, 0));

      expect(cb).not.toHaveBeenCalled();
      mailbox.destroy();
      bus.destroy();
    });

    it("destroy() is idempotent", () => {
      const bus = createBus();
      const ns = bus.namespace("vms");
      ns.channel<UIContract>("ui");

      expect(() => {
        ns.destroy();
        ns.destroy();
      }).not.toThrow();
      bus.destroy();
    });
  });

  it("channels from different namespaces are isolated", () => {
    const bus = createBus();
    const ns1 = bus.namespace("vms");
    const ns2 = bus.namespace("analytics");

    const cb1 = vi.fn();
    const cb2 = vi.fn();

    ns1.channel<UIContract>("ui").on("ui:update", cb1);
    ns2.channel<UIContract>("ui").on("ui:update", cb2);

    ns1.channel<UIContract>("ui").emit("ui:update", { label: "hello" });

    expect(cb1).toHaveBeenCalledOnce();
    expect(cb2).not.toHaveBeenCalled();
    bus.destroy();
  });

  describe("config conflict on existing channels", () => {
    it("optionless access to an existing channel succeeds", () => {
      const bus = createBus();
      const ch1 = bus.channel<UIContract>("ui", {
        storm: { maxMessages: 1000 },
      });
      const ch2 = bus.channel<UIContract>("ui");
      expect(ch2).toBe(ch1);
      bus.destroy();
    });

    it("re-access with options resolving to the same config succeeds", () => {
      const bus = createBus();
      const ch1 = bus.channel<UIContract>("ui", {
        storm: { maxMessages: 1000 },
      });
      const ch2 = bus.channel<UIContract>("ui", {
        storm: { maxMessages: 1000 },
      });
      expect(ch2).toBe(ch1);
      bus.destroy();
    });

    it("partial options resolving to the bus default succeed", () => {
      const bus = createBus();
      const ch1 = bus.channel<UIContract>("ui");
      // Bus default is maxMessages: 100 — this resolves to the existing config.
      const ch2 = bus.channel<UIContract>("ui", {
        storm: { maxMessages: 100 },
      });
      expect(ch2).toBe(ch1);
      bus.destroy();
    });

    it("access with a conflicting maxMessages throws", () => {
      const bus = createBus();
      bus.channel<UIContract>("ui");
      expect(() =>
        bus.channel<UIContract>("ui", { storm: { maxMessages: 1000 } }),
      ).toThrow(/already exists with storm config/);
      bus.destroy();
    });

    it("access with a conflicting windowMs throws", () => {
      const bus = createBus();
      bus.channel<UIContract>("ui", { storm: { windowMs: 500 } });
      expect(() =>
        bus.channel<UIContract>("ui", { storm: { windowMs: 2000 } }),
      ).toThrow(/already exists with storm config/);
      bus.destroy();
    });

    it("the error message includes both configs", () => {
      const bus = createBus();
      bus.channel<UIContract>("ui");
      expect(() =>
        bus.channel<UIContract>("ui", { storm: { maxMessages: 1000 } }),
      ).toThrow(/"maxMessages":100.*"maxMessages":1000/);
      bus.destroy();
    });

    it("namespaced channels throw on conflicting config too", () => {
      const bus = createBus();
      const ns = bus.namespace("vms");
      ns.channel<UIContract>("ui");
      expect(() =>
        ns.channel<UIContract>("ui", { storm: { maxMessages: 1000 } }),
      ).toThrow(/channel "vms:ui" already exists/);
      bus.destroy();
    });

    it("respects a non-default bus-level storm config when comparing", () => {
      const bus = createBus({ storm: { maxMessages: 1000 } });
      bus.channel<UIContract>("ui");
      // Resolves to { maxMessages: 1000, windowMs: 1000 } — same as existing.
      const ch = bus.channel<UIContract>("ui", {
        storm: { maxMessages: 1000 },
      });
      expect(ch).toBeDefined();
      bus.destroy();
    });

    it("optionless access to an existing buffered channel succeeds", () => {
      const bus = createBus();
      const ch1 = bus.channel<UIContract>("ui", { buffer: true });
      const ch2 = bus.channel<UIContract>("ui");
      expect(ch2).toBe(ch1);
      bus.destroy();
    });

    it("re-access with buffer: true on a buffered channel succeeds", () => {
      const bus = createBus();
      const ch1 = bus.channel<UIContract>("ui", { buffer: true });
      const ch2 = bus.channel<UIContract>("ui", { buffer: true });
      expect(ch2).toBe(ch1);
      bus.destroy();
    });

    it("buffer options resolving to the defaults succeed against buffer: true", () => {
      const bus = createBus();
      const ch1 = bus.channel<UIContract>("ui", { buffer: true });
      const ch2 = bus.channel<UIContract>("ui", {
        buffer: { maxMessages: 100, maxAgeMs: 10_000 },
      });
      expect(ch2).toBe(ch1);
      bus.destroy();
    });

    it("access requesting buffering on an unbuffered channel throws", () => {
      const bus = createBus();
      bus.channel<UIContract>("ui");
      expect(() => bus.channel<UIContract>("ui", { buffer: true })).toThrow(
        /already exists with buffer config/,
      );
      bus.destroy();
    });

    it("access with conflicting buffer bounds throws", () => {
      const bus = createBus();
      bus.channel<UIContract>("ui", { buffer: { maxMessages: 5 } });
      expect(() =>
        bus.channel<UIContract>("ui", { buffer: { maxMessages: 10 } }),
      ).toThrow(/already exists with buffer config/);
      bus.destroy();
    });

    it("the buffer error message includes both configs", () => {
      const bus = createBus();
      bus.channel<UIContract>("ui");
      expect(() => bus.channel<UIContract>("ui", { buffer: true })).toThrow(
        /null.*"maxMessages":100/,
      );
      bus.destroy();
    });

    it("namespaced channels throw on conflicting buffer config too", () => {
      const bus = createBus();
      const ns = bus.namespace("vms");
      ns.channel<UIContract>("ui");
      expect(() => ns.channel<UIContract>("ui", { buffer: true })).toThrow(
        /channel "vms:ui" already exists/,
      );
      bus.destroy();
    });
  });

  describe("buffer option resolution", () => {
    it("buffer: true resolves to the default bounds", () => {
      const bus = createBus();
      const ch = bus.channel<UIContract>("ui", { buffer: true });
      expect(ch.bufferConfig).toEqual({ maxMessages: 100, maxAgeMs: 10_000 });
      bus.destroy();
    });

    it("partial buffer options merge over the defaults", () => {
      const bus = createBus();
      const ch = bus.channel<UIContract>("ui", {
        buffer: { maxMessages: 5 },
      });
      expect(ch.bufferConfig).toEqual({ maxMessages: 5, maxAgeMs: 10_000 });
      bus.destroy();
    });

    it("a channel created without the buffer option is unbuffered", () => {
      const bus = createBus();
      const ch = bus.channel<UIContract>("ui");
      expect(ch.bufferConfig).toBeNull();
      bus.destroy();
    });
  });

  it("root Bus channel and namespaced channel with same name are independent", () => {
    const bus = createBus();
    const ns = bus.namespace("vms");

    const rootCb = vi.fn();
    const nsCb = vi.fn();

    bus.channel<PlaybackContract>("playback").on("playback:started", rootCb);
    ns.channel<PlaybackContract>("playback").on("playback:started", nsCb);

    bus
      .channel<PlaybackContract>("playback")
      .emit("playback:started", { cameraId: "x" });

    expect(rootCb).toHaveBeenCalledOnce();
    expect(nsCb).not.toHaveBeenCalled();
    bus.destroy();
  });
});
