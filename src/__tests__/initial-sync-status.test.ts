/**
 * Regression: the initial sync's onProgress message ("Indexing N sessions..."
 * / "Indexed i/N...") used to linger in the footer's extension-status line
 * whenever the sync finished with no changes, because only the changed path
 * cleared the "session-search" status key.
 *
 * A header-only session file reproduces this: it is ingested (so onProgress
 * fires) but parseSession reports zero user messages, so the sync result has
 * no added/updated counts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import extension, { _setIndexWorkerEnabled } from "../index";
import { createFakeHost, untilWarm } from "./helpers/fake-pi";

_setIndexWorkerEnabled(false);

const ROOT = join(import.meta.dirname, "__tmp_initial_sync_status__");

describe("initial sync status", () => {
  it("clears the session-search status when the sync finishes with no changes", async () => {
    const host = createFakeHost(ROOT, extension, { sync: { interval: -1 } });
    try {
      const headerOnly = join(host.sessionsDir, "empty-1.jsonl");
      writeFileSync(
        headerOnly,
        JSON.stringify({ type: "session", version: 1, id: "empty-1", timestamp: "2026-01-15T10:00:00Z", cwd: "/tmp/proj" }) + "\n",
        "utf8",
      );

      await host.start();
      await untilWarm(host, 5000);

      const seen = host.statuses.filter((s) => s.key === "session-search");
      assert.ok(seen.some((s) => /Indexing/.test(s.text)), "expected an onProgress status to have been set");
      assert.equal(host.status("session-search"), "", "status must be cleared when the sync reports no changes");
    } finally {
      host.cleanup();
    }
  });

  it("keeps a transient status when the sync reports changes", async () => {
    const host = createFakeHost(ROOT, extension, { sync: { interval: -1 } });
    try {
      const lines = [
        JSON.stringify({ type: "session", version: 1, id: "real-1", timestamp: "2026-01-15T10:00:00Z", cwd: "/tmp/proj" }),
        JSON.stringify({
          type: "message",
          id: "m1",
          parentId: null,
          timestamp: "2026-01-15T10:00:01Z",
          message: { role: "user", content: [{ type: "text", text: "a real question" }] },
        }),
      ];
      writeFileSync(join(host.sessionsDir, "real-1.jsonl"), lines.join("\n"), "utf8");

      await host.start();
      await untilWarm(host, 5000);

      const seen = host.statuses.filter((s) => s.key === "session-search");
      assert.ok(seen.some((s) => /Sessions: \+1/.test(s.text)), "expected the changes summary status");
    } finally {
      host.cleanup();
    }
  });
});
