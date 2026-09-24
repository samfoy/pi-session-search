/**
 * FtsSessionIndex write-path integrity: one row per session id when two
 * indexers share a DB (pi-conductor starts child sessions together).
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { FtsSessionIndex } from "../fts-index";
import { writeSession } from "./helpers/fake-pi";

const ROOT = join(import.meta.dirname, "__tmp_fts_index__");
const SESSIONS_DIR = join(ROOT, "sessions", "--tmp-proj--");
const INDEX_DIR = join(ROOT, "index");

/** Points at the temp tree only, never the real ~/.pi sessions. */
function openIndex(): FtsSessionIndex {
  return new FtsSessionIndex(INDEX_DIR, [], [], join(ROOT, "sessions"), join(ROOT, "archive"));
}

function writeSessions(n: number): void {
  for (let i = 0; i < n; i++) writeSession(SESSIONS_DIR, `s${i}`, `topic ${i}`);
}

/** Row count per id, read straight from the DB file. */
function rowsPerId(): Map<string, number> {
  const db = new DatabaseSync(join(INDEX_DIR, "sessions-fts.db"));
  try {
    const rows = db.prepare("SELECT id, COUNT(*) AS n FROM sessions GROUP BY id").all() as any[];
    return new Map(rows.map((r) => [String(r.id), Number(r.n)]));
  } finally {
    db.close();
  }
}

describe("FtsSessionIndex write integrity", () => {
  beforeEach(() => rmSync(ROOT, { recursive: true, force: true }));
  afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

  it("two syncs racing on one DB leave one row per id", async () => {
    writeSessions(3);
    const a = openIndex();
    const b = openIndex();
    await a.load();
    await b.load();
    try {
      // b runs its whole sync after a has read the index but before a inserts:
      // how two pi processes that start together interleave.
      let bSync: Promise<unknown> | undefined;
      await a.sync((msg) => {
        if (msg.startsWith("Indexing")) bSync ??= b.sync();
      });
      assert.ok(bSync, "b ran inside a's sync");
      await bSync;
      assert.deepEqual([...rowsPerId()], [["s0", 1], ["s1", 1], ["s2", 1]]);
    } finally {
      a.close();
      b.close();
    }
  });

  it("load() drops duplicate rows, keeping the newest", async () => {
    writeSessions(3);
    const seed = openIndex();
    await seed.load();
    await seed.sync();
    seed.close();

    // Duplicates as an older release left them, each inserted after the
    // original: an older copy of s0, a newer copy of s1, an exact copy of s2.
    const db = new DatabaseSync(join(INDEX_DIR, "sessions-fts.db"));
    const copy = db.prepare(
      `INSERT INTO sessions
       SELECT id, file, archived, startedAt, projectSlug, cwd, mtimeMs + ?, sizeBytes, json,
              ?, name, content
       FROM sessions WHERE id = ?`,
    );
    copy.run(-1000, "older copy", "s0");
    copy.run(1000, "newer copy", "s1");
    db.prepare("INSERT INTO sessions SELECT * FROM sessions WHERE id = ?").run("s2");
    db.close();
    assert.deepEqual([...rowsPerId()], [["s0", 2], ["s1", 2], ["s2", 2]]);

    const idx = openIndex();
    await idx.load();
    try {
      assert.deepEqual([...rowsPerId()], [["s0", 1], ["s1", 1], ["s2", 1]]);
      assert.notEqual(idx.get("s0")?.summary, "older copy");
      assert.equal(idx.get("s1")?.summary, "newer copy");
    } finally {
      idx.close();
    }
  });
});
