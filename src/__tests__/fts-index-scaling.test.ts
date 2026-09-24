/**
 * First-sync cost must grow linearly with the session count. A DELETE by id
 * before every insert (id is UNINDEXED, so each DELETE scans the table) made
 * it quadratic: 3,000 sessions took 53 s instead of 1 s.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { FtsSessionIndex } from "../fts-index";
import { writeSession } from "./helpers/fake-pi";

const ROOT = join(import.meta.dirname, "__tmp_fts_scaling__");
const N = 600;
/** ~1.6 KB per message, so each indexed row fills about one SQLite page. */
const PADDING = " lorem ipsum dolor sit amet".repeat(60);

function writeCorpus(count: number): string {
  const root = join(ROOT, `sessions-${count}`);
  for (let i = 0; i < count; i++) writeSession(join(root, "--tmp-proj--"), `s${i}`, `topic ${i}${PADDING}`);
  return root;
}

async function firstSyncMs(sessionsRoot: string, count: number): Promise<number> {
  const indexDir = join(ROOT, "index");
  rmSync(indexDir, { recursive: true, force: true });
  const idx = new FtsSessionIndex(indexDir, [], [], sessionsRoot, join(ROOT, "archive"));
  await idx.load();
  try {
    const t = performance.now();
    const { added } = await idx.sync();
    const ms = performance.now() - t;
    assert.equal(added, count);
    return ms;
  } finally {
    idx.close();
  }
}

describe("FtsSessionIndex first-sync scaling", () => {
  after(() => rmSync(ROOT, { recursive: true, force: true }));

  it("indexing 2N sessions takes under 3x as long as N", { timeout: 120_000 }, async () => {
    rmSync(ROOT, { recursive: true, force: true });
    const small = writeCorpus(N);
    const large = writeCorpus(2 * N);
    // Best of three, interleaved, so one load spike can't decide the ratio.
    let smallMs = Infinity;
    let largeMs = Infinity;
    for (let run = 0; run < 3; run++) {
      smallMs = Math.min(smallMs, await firstSyncMs(small, N));
      largeMs = Math.min(largeMs, await firstSyncMs(large, 2 * N));
    }
    const ratio = largeMs / smallMs;
    assert.ok(
      ratio < 3,
      `${N} sessions: ${smallMs.toFixed(0)} ms, ${2 * N}: ${largeMs.toFixed(0)} ms (ratio ${ratio.toFixed(2)}, linear is ~2)`,
    );
  });
});
