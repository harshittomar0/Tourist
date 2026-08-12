import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args)
}));

const { createApiKeyClaudeCaller, createCliClaudeCaller, createClaudeCaller } = await import("../src/claude/client.js");

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  child.kill = vi.fn();
  return child;
}

describe("createCliClaudeCaller", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("spawns claude with the documented flag set, writes userContent to stdin, and returns structured_output as JSON text", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const caller = createCliClaudeCaller("claude-sonnet-5", "claude", 5_000);
    const promise = caller("a system prompt", "the user content");

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cliPath, args] = spawnMock.mock.calls[0];
    expect(cliPath).toBe("claude");
    expect(args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--model",
      "claude-sonnet-5",
      "--no-session-persistence",
      "--system-prompt",
      "a system prompt",
      "--json-schema",
      expect.any(String)
    ]);
    // The schema itself must be valid, parseable JSON.
    expect(() => JSON.parse(args[args.length - 1])).not.toThrow();

    expect(child.stdin.write).toHaveBeenCalledWith("the user content");
    expect(child.stdin.end).toHaveBeenCalled();

    child.stdout.emit("data", Buffer.from(JSON.stringify({ is_error: false, structured_output: { tech: [] } })));
    child.emit("close", 0);

    const result = await promise;
    expect(JSON.parse(result)).toEqual({ tech: [] });
  });

  it("uses the default model and cli path when not provided", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const caller = createCliClaudeCaller();
    const promise = caller("sys", "user");

    const [cliPath, args] = spawnMock.mock.calls[0];
    expect(cliPath).toBe("claude");
    expect(args).toContain("claude-sonnet-5");

    child.stdout.emit("data", Buffer.from(JSON.stringify({ is_error: false, structured_output: {} })));
    child.emit("close", 0);
    await promise;
  });

  it("rejects using `result` as the message when is_error is truthy", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = createCliClaudeCaller()("sys", "user");
    child.stdout.emit("data", Buffer.from(JSON.stringify({ is_error: true, result: "the model declined" })));
    child.emit("close", 0);

    await expect(promise).rejects.toThrow(/the model declined/);
  });

  it("rejects when structured_output is missing even though is_error is false", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = createCliClaudeCaller()("sys", "user");
    child.stdout.emit("data", Buffer.from(JSON.stringify({ is_error: false, result: "no schema match" })));
    child.emit("close", 0);

    await expect(promise).rejects.toThrow(/no schema match/);
  });

  it("rejects with stderr (falling back to stdout) on non-zero exit", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = createCliClaudeCaller()("sys", "user");
    child.stderr.emit("data", Buffer.from("permission denied"));
    child.emit("close", 1);

    await expect(promise).rejects.toThrow(/exited with code 1.*permission denied/s);
  });

  it("falls back to stdout when stderr is empty on non-zero exit", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = createCliClaudeCaller()("sys", "user");
    child.stdout.emit("data", Buffer.from("some stdout detail"));
    child.emit("close", 1);

    await expect(promise).rejects.toThrow(/some stdout detail/);
  });

  it("rejects with a clear error when the CLI binary is not found", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = createCliClaudeCaller(undefined, "nonexistent-claude-binary")("sys", "user");
    const enoent = Object.assign(new Error("spawn nonexistent-claude-binary ENOENT"), { code: "ENOENT" });
    child.emit("error", enoent);

    await expect(promise).rejects.toThrow(/claude CLI not found/i);
  });

  it("rejects when stdout is not valid JSON", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = createCliClaudeCaller()("sys", "user");
    child.stdout.emit("data", Buffer.from("not json at all"));
    child.emit("close", 0);

    await expect(promise).rejects.toThrow(/not valid JSON|Could not parse/i);
  });

  it("kills the process and rejects on timeout", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);

      const promise = createCliClaudeCaller(undefined, "claude", 1_000)("sys", "user");
      const assertion = expect(promise).rejects.toThrow(/timed out/i);

      await vi.advanceTimersByTimeAsync(1_001);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createClaudeCaller (backend dispatch)", () => {
  it("defaults to the cli backend", async () => {
    const child = makeFakeChild();
    spawnMock.mockReset();
    spawnMock.mockReturnValue(child);

    const caller = createClaudeCaller();
    const promise = caller("sys", "user");

    expect(spawnMock).toHaveBeenCalledTimes(1);
    child.stdout.emit("data", Buffer.from(JSON.stringify({ is_error: false, structured_output: {} })));
    child.emit("close", 0);
    await promise;
  });

  it("routes to the api-key backend and enforces the explicit-key requirement", () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => createClaudeCaller({ backend: "api-key" })).toThrow(/ANTHROPIC_API_KEY is not set/);
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
    }
  });
});

describe("createApiKeyClaudeCaller", () => {
  it("throws immediately when no API key is available", () => {
    expect(() => createApiKeyClaudeCaller(undefined, "claude-sonnet-5")).toThrow(/ANTHROPIC_API_KEY is not set/);
  });

  it("does not throw when an explicit key is provided", () => {
    expect(() => createApiKeyClaudeCaller("sk-test-key", "claude-sonnet-5")).not.toThrow();
  });
});
