/**
 * Tests for resolveSyncAction — the pure decision function that maps
 * raw sync.intervalMs config values to timer behaviour.
 *
 * This isolates the logic from the ExtensionAPI so we can assert that
 * setInterval isn't scheduled when intervalMs === -1 without needing
 * a full pi runtime mock.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveSyncAction, resolveInitialSyncAction, isChildProcess } from "../index";

describe("resolveSyncAction", () => {
  it("returns disabled for -1", () => {
    const result = resolveSyncAction(-1);
    assert.equal(result.disabled, true);
    assert.equal(result.intervalMs, undefined);
    assert.equal(result.fallback, undefined);
  });

  it("returns timer interval for positive values", () => {
    const result = resolveSyncAction(900_000);
    assert.equal(result.disabled, false);
    assert.equal(result.intervalMs, 900_000);
    assert.equal(result.fallback, undefined);
  });

  it("falls back to default for 0 with warning flag", () => {
    const result = resolveSyncAction(0);
    assert.equal(result.disabled, false);
    assert.ok(result.intervalMs && result.intervalMs > 0);
    assert.equal(result.fallback, true);
  });

  it("falls back to default for any negative value other than -1", () => {
    const result = resolveSyncAction(-2);
    assert.equal(result.disabled, false);
    assert.ok(result.intervalMs && result.intervalMs > 0);
    assert.equal(result.fallback, true);
  });

  it("returns silent default when undefined (no config) — no fallback warning", () => {
    const result = resolveSyncAction(undefined);
    assert.equal(result.disabled, false);
    assert.ok(result.intervalMs && result.intervalMs > 0);
    assert.equal(result.fallback, undefined); // absent config must not warn
  });
});

describe("resolveInitialSyncAction", () => {
  it("returns skip: true for -1", () => {
    const result = resolveInitialSyncAction(-1);
    assert.equal(result.skip, true);
    assert.equal(result.delayMs, undefined);
    assert.equal(result.fallback, undefined);
  });

  it("returns immediate (delayMs: 0) for 0", () => {
    const result = resolveInitialSyncAction(0);
    assert.equal(result.skip, false);
    assert.equal(result.delayMs, 0);
    assert.equal(result.fallback, undefined);
  });

  it("returns delay for positive values", () => {
    const result = resolveInitialSyncAction(30_000);
    assert.equal(result.skip, false);
    assert.equal(result.delayMs, 30_000);
    assert.equal(result.fallback, undefined);
  });

  it("falls back to default for any negative value other than -1", () => {
    const result = resolveInitialSyncAction(-2);
    assert.equal(result.skip, false);
    assert.equal(result.delayMs, 0);
    assert.equal(result.fallback, true);
  });

  it("returns silent default when undefined (no config) — no fallback warning", () => {
    const result = resolveInitialSyncAction(undefined);
    assert.equal(result.skip, false);
    assert.equal(result.delayMs, 0);
    assert.equal(result.fallback, undefined); // absent config must not warn
  });
});

describe("isChildProcess", () => {
  const origDepth = process.env.PI_SUBAGENT_DEPTH;
  const origStdinIsTty = process.stdin.isTTY;

  afterEach(() => {
    // Restore environment.
    if (origDepth === undefined) {
      delete process.env.PI_SUBAGENT_DEPTH;
    } else {
      process.env.PI_SUBAGENT_DEPTH = origDepth;
    }
    // Restore stdin.isTTY via Object.defineProperty (it's a getter).
    Object.defineProperty(process.stdin, "isTTY", {
      value: origStdinIsTty,
      writable: false,
      enumerable: true,
      configurable: true,
    });
  });

  it("returns true when PI_SUBAGENT_DEPTH > 0", () => {
    process.env.PI_SUBAGENT_DEPTH = "1";
    assert.equal(isChildProcess(), true);
  });

  it("returns true when PI_SUBAGENT_DEPTH is deeply nested", () => {
    process.env.PI_SUBAGENT_DEPTH = "3";
    assert.equal(isChildProcess(), true);
  });

  it("returns false when PI_SUBAGENT_DEPTH is 0 and stdin is TTY", () => {
    process.env.PI_SUBAGENT_DEPTH = "0";
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      writable: false,
      enumerable: true,
      configurable: true,
    });
    assert.equal(isChildProcess(), false);
  });

  it("returns true when stdin.isTTY is false (non-interactive)", () => {
    delete process.env.PI_SUBAGENT_DEPTH;
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      writable: false,
      enumerable: true,
      configurable: true,
    });
    assert.equal(isChildProcess(), true);
  });

  it("returns false when both signals are absent (normal interactive session)", () => {
    delete process.env.PI_SUBAGENT_DEPTH;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      writable: false,
      enumerable: true,
      configurable: true,
    });
    assert.equal(isChildProcess(), false);
  });
});
