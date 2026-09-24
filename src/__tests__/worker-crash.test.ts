/**
 * A worker that dies during the initial sync: the user gets one notification,
 * and the tools say the index is unavailable and how to restart it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import extension, { _setIndexWorkerEnabled } from "../index";
import { createFakeHost } from "./helpers/fake-pi";

const ROOT = join(import.meta.dirname, "__tmp_worker_crash__");

/** Answers load and the primer's list, then exits when asked to sync. */
const CRASHING_WORKER = `
import { parentPort } from "node:worker_threads";
parentPort.on("message", (req) => {
  if (req.op === "sync") process.exit(3);
  parentPort.postMessage({ id: req.id, type: "result", value: req.op === "list" ? [] : 0 });
});
`;

describe("index worker crash", () => {
  it("notifies once, and the tools point at /reload", { timeout: 10_000 }, async () => {
    const host = createFakeHost(ROOT, extension);
    const workerFile = join(ROOT, "crashing-worker.mjs");
    writeFileSync(workerFile, CRASHING_WORKER);
    _setIndexWorkerEnabled(true, workerFile);
    try {
      await host.start();
      let text = "";
      for (const deadline = Date.now() + 5000; Date.now() < deadline; ) {
        text = await host.tool("session_list", {});
        if (/unavailable/.test(text)) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(
        text,
        "Session index unavailable: index worker exited with code 3. Run /reload to restart indexing.",
      );
      assert.deepEqual(
        host.notes.filter((n) => /exited|fail/i.test(n)),
        ["session-search: index worker exited with code 3. Run /reload to restart indexing."],
      );
    } finally {
      _setIndexWorkerEnabled(true);
      await host.shutdown();
      host.cleanup();
    }
  });
});
