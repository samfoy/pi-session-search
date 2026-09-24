/**
 * Issue #16: indexing no longer runs on the session_start path, so tools can
 * be called while the initial sync is still running. They must answer from
 * the saved index and say "index warming" until the sync finishes.
 *
 * Runs the index in-process (deterministic, no worker thread); the worker
 * path is covered by index-worker-smoke.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import extension, { _setIndexWorkerEnabled } from "../index";
import { FtsSessionIndex } from "../fts-index";
import { createFakeHost, untilWarm, writeSession } from "./helpers/fake-pi";

_setIndexWorkerEnabled(false);

const ROOT = join(import.meta.dirname, "__tmp_startup_warming__");

describe("startup indexing (in-process)", () => {
  it("answers 'index warming' before the saved index is loaded", async () => {
    const host = createFakeHost(ROOT, extension);
    try {
      const text = await host.tool("session_list", {});
      assert.match(text, /index warming/);
    } finally {
      host.cleanup();
    }
  });

  it("serves the saved index with a warming note until the initial sync finishes", async () => {
    // initialDelay holds the initial sync back so the warming window is deterministic.
    const host = createFakeHost(ROOT, extension, { sync: { interval: -1, initialDelay: 300 } });
    try {
      writeSession(host.sessionsDir, "warm-a", "alpha refactor of the parser");
      writeSession(host.sessionsDir, "warm-b", "beta lambda timeout");
      const seed = new FtsSessionIndex(host.indexDir, [], [], join(ROOT, "sessions"), join(ROOT, "archive"));
      await seed.load();
      await seed.sync();
      seed.close();
      // A session the saved index has not seen yet.
      writeSession(host.sessionsDir, "warm-c", "gamma alpha migration");

      await host.start();

      const listed = await host.tool("session_list", { limit: 50 });
      assert.match(listed, /index warming/);
      assert.match(listed, /2 sessions \(2 total indexed\)/);

      const found = await host.tool("session_search", { query: "alpha" });
      assert.match(found, /index warming/);
      assert.match(found, /ID: warm-a/);
      assert.doesNotMatch(found, /ID: warm-c/);

      const missing = await host.tool("session_read", { session: "warm-c" });
      assert.match(missing, /Session not found/);
      assert.match(missing, /index warming/);

      const warm = await untilWarm(host, 5000);
      assert.match(warm, /^3 sessions \(3 total indexed\)/);

      const after = await host.tool("session_search", { query: "alpha" });
      assert.doesNotMatch(after, /index warming/);
      assert.match(after, /ID: warm-a/);
      assert.match(after, /ID: warm-c/);

      // Primer still goes out, and with triggerTurn: false so a late primer
      // can't steer a turn that is already streaming.
      const primer = host.sent.find((s) => s.message.customType === "pi-session-search-primer");
      assert.ok(primer, "primer was sent");
      assert.deepEqual(primer.options, { triggerTurn: false });
    } finally {
      await host.shutdown();
      host.cleanup();
    }
  });
});
