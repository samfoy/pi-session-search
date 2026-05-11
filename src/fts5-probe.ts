import { DatabaseSync } from "node:sqlite";

/**
 * Check whether the SQLite build that ships with this Node runtime has
 * FTS5 compiled in. Node 24+ does; Node 22's bundled SQLite does not.
 *
 * Without this check, `CREATE VIRTUAL TABLE ... USING fts5(...)` throws
 * deep inside `load()`, leaves a DB file with no tables, and every
 * subsequent query surfaces the cryptic "no such table: sessions"
 * instead of the real cause. See samfoy/pi-total-recall#4.
 *
 * Throws an Error with an actionable message when FTS5 is unavailable.
 * The probe runs at most once per process.
 */

let cached: boolean | null = null;

export function assertFts5Available(): void {
  if (cached === true) return;
  if (cached === false) throw new Error(fts5ErrorMessage());

  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE _fts5_probe USING fts5(x)");
    cached = true;
  } catch {
    cached = false;
    throw new Error(fts5ErrorMessage());
  } finally {
    try { db.close(); } catch { /* noop */ }
  }
}

function fts5ErrorMessage(): string {
  return (
    "SQLite FTS5 is not available in this Node runtime. " +
    "pi-session-search requires Node 24+ (where node:sqlite ships with FTS5 compiled in). " +
    `Current: Node ${process.versions.node}. Upgrade Node and restart pi.`
  );
}

/** Test-only: reset the memoized probe result. */
export function _resetFts5ProbeCache(): void {
  cached = null;
}
