/**
 * FtsSessionIndex write-path integrity: one row per session id when two
 * indexers share a DB (pi-conductor starts child sessions together), and a
 * failed sync must not leave a transaction open for the next one.
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

function openDb(): DatabaseSync {
  return new DatabaseSync(join(INDEX_DIR, "sessions-fts.db"));
}

/** Row count per id, read straight from the DB file. */
function rowsPerId(): Map<string, number> {
  const db = openDb();
  try {
    const rows = db.prepare("SELECT id, COUNT(*) AS n FROM sessions GROUP BY id").all() as any[];
    return new Map(rows.map((r) => [String(r.id), Number(r.n)]));
  } finally {
    db.close();
  }
}

/** Index s0..s2, then duplicate each row as releases before 1.6.0 could. */
async function seedDuplicates(userVersion: number): Promise<void> {
  writeSessions(3);
  const seed = openIndex();
  await seed.load();
  await seed.sync();
  seed.close();

  // Each copy is inserted after the original: an older copy of s0, a newer
  // copy of s1, an exact copy of s2.
  const db = openDb();
  const copy = db.prepare(
    `INSERT INTO sessions
     SELECT id, file, archived, startedAt, projectSlug, cwd, mtimeMs + ?, sizeBytes, json,
            ?, name, content
     FROM sessions WHERE id = ?`,
  );
  copy.run(-1000, "older copy", "s0");
  copy.run(1000, "newer copy", "s1");
  db.prepare("INSERT INTO sessions SELECT * FROM sessions WHERE id = ?").run("s2");
  db.exec(`PRAGMA user_version = ${userVersion}`);
  db.close();
  assert.deepEqual([...rowsPerId()], [["s0", 2], ["s1", 2], ["s2", 2]]);
}

const ONE_ROW_EACH = [["s0", 1], ["s1", 1], ["s2", 1]];

function userVersion(): number {
  const db = openDb();
  try {
    return Number((db.prepare("PRAGMA user_version").get() as any).user_version);
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

  it("load() drops duplicate rows a pre-1.6.0 DB holds, keeping the newest", async () => {
    // Releases before 1.6.0 never set user_version.
    await seedDuplicates(0);

    const idx = openIndex();
    await idx.load();
    try {
      assert.deepEqual([...rowsPerId()], ONE_ROW_EACH);
      assert.equal(userVersion(), 1, "marked healed");
      assert.notEqual(idx.get("s0")?.summary, "older copy");
      assert.equal(idx.get("s1")?.summary, "newer copy");
    } finally {
      idx.close();
    }
  });

  it("load() scans for old duplicates only until one scan has run", async () => {
    // user_version 1: a 1.6.0 open already healed this DB, so the rows below
    // stand in for a later race, which sync() handles.
    await seedDuplicates(1);

    const idx = openIndex();
    await idx.load();
    idx.close();
    assert.deepEqual([...rowsPerId()], [["s0", 2], ["s1", 2], ["s2", 2]]);
  });

  it("load() succeeds while another connection holds the write lock", async () => {
    await seedDuplicates(0);
    const holder = openDb();
    holder.exec("BEGIN IMMEDIATE");
    const idx = openIndex();
    try {
      const t = performance.now();
      await idx.load();
      assert.ok(performance.now() - t < 2500, "load() skips the heal instead of waiting for the lock");
      assert.equal(idx.size(), 6, "duplicates wait for a sync");
      assert.equal(userVersion(), 0, "the next open tries again");
      holder.exec("ROLLBACK");

      writeSession(SESSIONS_DIR, "s3", "topic 3");
      assert.equal((await idx.sync()).added, 1);
      assert.deepEqual([...rowsPerId()], [...ONE_ROW_EACH, ["s3", 1]]);
      assert.equal(idx.get("s1")?.summary, "newer copy");
    } finally {
      if (holder.isTransaction) holder.exec("ROLLBACK");
      holder.close();
      idx.close();
    }
  });

  it("a failure mid-chunk rolls back, and the next sync succeeds", async () => {
    writeSessions(30);
    const idx = openIndex();
    await idx.load();
    try {
      // "Indexed 25/30..." is reported inside the chunk's open transaction.
      await assert.rejects(
        idx.sync((msg) => {
          if (msg.startsWith("Indexed ")) throw new Error("injected mid-chunk failure");
        }),
        /injected mid-chunk failure/,
      );

      await idx.sync();
      assert.equal(idx.size(), 30);
      assert.ok([...rowsPerId().values()].every((n) => n === 1), "one row per id");
    } finally {
      idx.close();
    }
  });
});
