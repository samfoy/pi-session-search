/**
 * Issue #16 smoke test against the real worker thread (dist/index-worker.js,
 * rebuilt by `pretest`). A large session file makes the initial sync
 * expensive; the main thread must stay responsive while it runs, and the
 * tools must say "index warming" until it finishes, then return every session.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import extension from "../index";
import { createFakeHost, untilWarm, writeSession } from "./helpers/fake-pi";

const ROOT = join(import.meta.dirname, "__tmp_worker_smoke__");
const SESSIONS = 150;

/**
 * ~20 MB of dense tool-call turns. One file parses in one synchronous step
 * (~200 ms here), so running the index on the main thread stalls it well past
 * the limit below; on the worker the main thread stays near 10 ms.
 */
function bigSessionLines(): string[] {
  const content = Array.from({ length: 1000 }, (_, j) => ({
    type: "toolCall",
    name: `tool${j % 7}`,
    id: `c${j}`,
    arguments: { n: j },
  }));
  return Array.from({ length: 300 }, (_, i) =>
    JSON.stringify({
      type: "message",
      id: `a${i}`,
      parentId: null,
      timestamp: "2026-01-15T10:01:00Z",
      message: { role: "assistant", content },
    }),
  );
}

describe("startup indexing (worker thread)", () => {
  it("keeps the main thread responsive while the initial sync runs", { timeout: 30_000 }, async () => {
    const host = createFakeHost(ROOT, extension);
    const maxStallLimitMs = 100;
    let maxStall = 0;
    let last = performance.now();
    const ticker = setInterval(() => {
      const now = performance.now();
      maxStall = Math.max(maxStall, now - last);
      last = now;
    }, 5);
    try {
      writeSession(host.sessionsDir, "smoke-big", "needle-big giant session", bigSessionLines());
      for (let i = 0; i < SESSIONS; i++) {
        writeSession(host.sessionsDir, `smoke-${i}`, `needle-${i} session ${i}`);
      }

      last = performance.now();
      maxStall = 0;
      await host.start();

      const early = await host.tool("session_list", { limit: 1 });
      assert.match(early, /index warming/);

      const warm = await untilWarm(host, 20_000);
      assert.match(warm, new RegExp(`\\(${SESSIONS + 1} total indexed\\)`));
      const big = await host.tool("session_search", { query: "needle-big" });
      assert.match(big, /ID: smoke-big/);
      assert.doesNotMatch(big, /index warming/);

      assert.ok(
        maxStall < maxStallLimitMs,
        `main thread stalled ${maxStall.toFixed(0)}ms during startup indexing (limit ${maxStallLimitMs}ms)`,
      );
      assert.deepEqual(host.notes.filter((n) => /fail|error|exited/i.test(n)), []);
    } finally {
      clearInterval(ticker);
      await host.shutdown();
      host.cleanup();
    }
  });
});
