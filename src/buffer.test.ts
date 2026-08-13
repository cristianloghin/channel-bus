import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBuffer } from "./buffer";
import type { ChannelContract, Message } from "./types";

const CONFIG = { maxMessages: 3, maxAgeMs: 10_000 };

// Hand-built message — the buffer only reads action and timestamp.
function msg(action: string, timestamp = Date.now()): Message<ChannelContract> {
  return {
    id: `id-${action}-${timestamp}`,
    namespace: "",
    channel: "ch",
    action,
    payload: undefined,
    from: "test",
    coordinationChain: [],
    timestamp,
  };
}

function makeBuffer(config = CONFIG) {
  return new MessageBuffer<ChannelContract>("test-channel", config);
}

describe("MessageBuffer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts empty", () => {
    expect(makeBuffer().size).toBe(0);
  });

  it("every action starts closed", () => {
    const buffer = makeBuffer();
    expect(buffer.isOpen("anything")).toBe(false);
  });

  it("push appends and size reflects it", () => {
    const buffer = makeBuffer();
    buffer.push(msg("a"));
    buffer.push(msg("b"));
    expect(buffer.size).toBe(2);
  });

  describe("count bound", () => {
    it("evicts the oldest message beyond maxMessages", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const buffer = makeBuffer();
      buffer.push(msg("a"));
      buffer.push(msg("b"));
      buffer.push(msg("c"));
      buffer.push(msg("d"));

      expect(buffer.size).toBe(3);
      // The oldest ("a") is the one that went.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"a"'));
    });

    it("warns with [chbus] and the channel name on overflow", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const buffer = makeBuffer({ maxMessages: 1, maxAgeMs: 10_000 });
      buffer.push(msg("a"));
      buffer.push(msg("b"));

      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("[chbus]"));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("test-channel"),
      );
    });

    it("does not warn while within the bound", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const buffer = makeBuffer();
      buffer.push(msg("a"));
      buffer.push(msg("b"));
      buffer.push(msg("c"));
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("age bound", () => {
    it("evicts expired messages when a new one is pushed", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const buffer = makeBuffer();
      buffer.push(msg("stale", Date.now() - 20_000));
      buffer.push(msg("fresh"));

      expect(buffer.size).toBe(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"stale"'));
    });

    it("evicts expired messages on size reads", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const buffer = makeBuffer();
      buffer.push(msg("stale", Date.now() - 20_000));
      // No further push — the getter itself must evict.
      expect(buffer.size).toBe(0);
    });

    it("keeps fresh messages", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const buffer = makeBuffer();
      buffer.push(msg("a"));
      buffer.push(msg("b"));
      expect(buffer.size).toBe(2);
      expect(warn).not.toHaveBeenCalled();
    });

    it("evicts only the expired prefix, not fresh messages behind it", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const buffer = makeBuffer();
      buffer.push(msg("stale-1", Date.now() - 30_000));
      buffer.push(msg("stale-2", Date.now() - 20_000));
      buffer.push(msg("fresh-1"));
      buffer.push(msg("fresh-2"));

      expect(buffer.size).toBe(2);
    });
  });

  it("destroy() clears the queue", () => {
    const buffer = makeBuffer();
    buffer.push(msg("a"));
    buffer.push(msg("b"));
    buffer.destroy();
    expect(buffer.size).toBe(0);
  });

  it("destroy() does not throw on an empty buffer", () => {
    expect(() => makeBuffer().destroy()).not.toThrow();
  });
});
