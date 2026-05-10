/**
 * Tests for resolveSyncAction — the pure decision function that maps
 * raw sync.intervalMs config values to timer behaviour.
 *
 * This isolates the logic from the ExtensionAPI so we can assert that
 * setInterval isn't scheduled when intervalMs === -1 without needing
 * a full pi runtime mock.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSyncAction, resolveInitialSyncAction } from "../index";

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

  it("falls back to default when undefined (no config)", () => {
    const result = resolveSyncAction(undefined);
    assert.equal(result.disabled, false);
    assert.ok(result.intervalMs && result.intervalMs > 0);
    assert.equal(result.fallback, true);
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

  it("falls back to default when undefined (no config)", () => {
    const result = resolveInitialSyncAction(undefined);
    assert.equal(result.skip, false);
    assert.equal(result.delayMs, 0);
    assert.equal(result.fallback, true);
  });
});
