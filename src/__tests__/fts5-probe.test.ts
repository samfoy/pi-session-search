import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertFts5Available, _resetFts5ProbeCache } from "../fts5-probe";

describe("assertFts5Available", () => {
  it("returns without throwing on a Node runtime with FTS5 (this CI env)", () => {
    _resetFts5ProbeCache();
    // On Node 24+ (what this project targets for tests) FTS5 is compiled in.
    // The probe should succeed silently.
    assert.doesNotThrow(() => assertFts5Available());
  });

  it("caches the positive result (second call is a fast no-op)", () => {
    _resetFts5ProbeCache();
    assertFts5Available();
    // No way to directly observe the cache without monkey-patching DatabaseSync,
    // but calling again must not throw and must stay cheap.
    assert.doesNotThrow(() => assertFts5Available());
  });
});
