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

  describe("claims and drain", () => {
    const mailboxA = {};
    const mailboxB = {};

    it("a first claim succeeds", () => {
      const buffer = makeBuffer();
      expect(() => buffer.claim("a", mailboxA)).not.toThrow();
    });

    it("claiming an action held by another mailbox throws", () => {
      const buffer = makeBuffer();
      buffer.claim("a", mailboxA);
      expect(() => buffer.claim("a", mailboxB)).toThrow(
        /already claimed by another mailbox/,
      );
    });

    it("re-claiming by the same claimant is a no-op", () => {
      const buffer = makeBuffer();
      buffer.claim("a", mailboxA);
      expect(() => buffer.claim("a", mailboxA)).not.toThrow();
    });

    it("open() returns only the claimant's actions, in emit order", () => {
      const buffer = makeBuffer();
      const a1 = msg("a");
      const b1 = msg("b");
      const a2 = msg("a");
      buffer.push(a1);
      buffer.push(b1);
      buffer.push(a2);
      buffer.claim("a", mailboxA);

      const drained = buffer.open(mailboxA);

      expect(drained.map((m) => m.id)).toEqual([a1.id, a2.id]);
      expect(buffer.size).toBe(1); // b1 stays
    });

    it("open() marks the claimed actions open, others stay closed", () => {
      const buffer = makeBuffer();
      buffer.claim("a", mailboxA);
      buffer.open(mailboxA);
      expect(buffer.isOpen("a")).toBe(true);
      expect(buffer.isOpen("b")).toBe(false);
    });

    it("open() with nothing buffered returns []", () => {
      const buffer = makeBuffer();
      buffer.claim("a", mailboxA);
      expect(buffer.open(mailboxA)).toEqual([]);
    });

    it("a second open() by the same claimant returns []", () => {
      const buffer = makeBuffer();
      buffer.push(msg("a"));
      buffer.claim("a", mailboxA);
      buffer.open(mailboxA);
      expect(buffer.open(mailboxA)).toEqual([]);
    });

    it("open() evicts expired messages before draining", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const buffer = makeBuffer();
      buffer.push(msg("a", Date.now() - 20_000));
      const fresh = msg("a");
      buffer.push(fresh);
      buffer.claim("a", mailboxA);

      const drained = buffer.open(mailboxA);
      expect(drained.map((m) => m.id)).toEqual([fresh.id]);
    });

    it("release() frees unopened claims", () => {
      const buffer = makeBuffer();
      buffer.claim("a", mailboxA);
      buffer.release(mailboxA);
      expect(() => buffer.claim("a", mailboxB)).not.toThrow();
    });

    it("release() frees opened claims too — the gate stays open", () => {
      const buffer = makeBuffer();
      buffer.claim("a", mailboxA);
      buffer.open(mailboxA);
      buffer.release(mailboxA);

      // A successor can take over the action…
      expect(() => buffer.claim("a", mailboxB)).not.toThrow();
      // …and the gate never re-arms: the action is still open.
      expect(buffer.isOpen("a")).toBe(true);
    });

    it("destroy() clears claims", () => {
      const buffer = makeBuffer();
      buffer.claim("a", mailboxA);
      buffer.destroy();
      expect(() => buffer.claim("a", mailboxB)).not.toThrow();
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
