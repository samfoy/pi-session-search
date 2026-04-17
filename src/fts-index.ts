import { DatabaseSync } from "node:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ParsedSession } from "./parser";
import { discoverSessionFiles, parseSession, readSessionId } from "./parser";
import type { SearchResult, ListFilters } from "./session-index";

/**
 * SQLite FTS5-backed session index. API-compatible with SessionIndex.
 * Requires no embedder — uses BM25 keyword search.
 */
export class FtsSessionIndex {
  private db!: DatabaseSync;
  private dbPath: string;
  private indexDir: string;
  private extraSessionDirs: string[];
  private extraArchiveDirs: string[];

  constructor(
    indexDir: string,
    extraSessionDirs: string[] = [],
    extraArchiveDirs: string[] = [],
  ) {
    this.indexDir = indexDir;
    this.extraSessionDirs = extraSessionDirs;
    this.extraArchiveDirs = extraArchiveDirs;
    mkdirSync(indexDir, { recursive: true });
    this.dbPath = join(indexDir, "sessions-fts.db");
  }

  async load(): Promise<void> {
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions USING fts5(
        id UNINDEXED,
        file UNINDEXED,
        archived UNINDEXED,
        startedAt UNINDEXED,
        projectSlug UNINDEXED,
        cwd UNINDEXED,
        mtimeMs UNINDEXED,
        json UNINDEXED,
        summary UNINDEXED,
        name,
        content,
        tokenize='porter unicode61'
      );
    `);
  }

  save(): void { /* auto-persisted */ }

  size(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as any;
    return Number(row?.n ?? 0);
  }

  async sync(
    onProgress?: (msg: string) => void,
  ): Promise<{ added: number; updated: number; removed: number; moved: number }> {
    const discovered = discoverSessionFiles(this.extraSessionDirs, this.extraArchiveDirs);

    let added = 0, updated = 0, removed = 0, moved = 0;

    // Build idToFile map from disk (preferring newer mtime on dupes)
    const idToFile = new Map<string, { file: string; archived: boolean; mtimeMs: number }>();
    for (const { file, archived } of discovered) {
      let mtimeMs: number;
      try { mtimeMs = statSync(file).mtimeMs; } catch { continue; }
      const id = readSessionId(file);
      if (!id) continue;
      const existing = idToFile.get(id);
      if (!existing || mtimeMs > existing.mtimeMs) {
        idToFile.set(id, { file, archived, mtimeMs });
      }
    }

    // Current index state
    const currentRows = this.db
      .prepare("SELECT id, file, mtimeMs FROM sessions")
      .all() as any[];
    const currentIds = new Set(currentRows.map((r) => String(r.id)));
    const currentById = new Map<string, { file: string; mtimeMs: number }>();
    for (const r of currentRows) {
      currentById.set(String(r.id), { file: String(r.file), mtimeMs: Number(r.mtimeMs) });
    }

    // Remove sessions no longer present
    const delStmt = this.db.prepare("DELETE FROM sessions WHERE id = ?");
    for (const id of currentIds) {
      if (!idToFile.has(id)) {
        delStmt.run(id);
        removed++;
      }
    }

    // Figure out what needs (re-)ingestion
    const toIngest: { id: string; file: string; archived: boolean; mtimeMs: number }[] = [];
    const movedUpdates: { id: string; file: string; archived: boolean; mtimeMs: number }[] = [];
    for (const [id, disc] of idToFile.entries()) {
      const cur = currentById.get(id);
      if (!cur) {
        toIngest.push({ id, ...disc });
      } else if (cur.mtimeMs < disc.mtimeMs) {
        toIngest.push({ id, ...disc });
      } else if (cur.file !== disc.file) {
        movedUpdates.push({ id, ...disc });
      }
    }

    // Apply moves (metadata-only) without reparse
    const moveStmt = this.db.prepare(
      "UPDATE sessions SET file = ?, archived = ?, mtimeMs = ? WHERE id = ?",
    );
    for (const m of movedUpdates) {
      moveStmt.run(m.file, m.archived ? 1 : 0, m.mtimeMs, m.id);
      moved++;
    }

    if (toIngest.length > 0) onProgress?.(`Indexing ${toIngest.length} sessions...`);

    const insertStmt = this.db.prepare(`
      INSERT INTO sessions (id, file, archived, startedAt, projectSlug, cwd, mtimeMs, json, summary, name, content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const replaceDel = this.db.prepare("DELETE FROM sessions WHERE id = ?");

    let done = 0;
    for (const item of toIngest) {
      const session = parseSession(item.file, item.archived);
      if (!session || session.userMessageCount === 0) { done++; continue; }
      const content = buildContent(session);
      const summary = buildSummary(session);
      const isUpdate = currentIds.has(item.id);
      if (isUpdate) replaceDel.run(item.id);
      insertStmt.run(
        session.id,
        session.file,
        session.archived ? 1 : 0,
        session.startedAt,
        session.projectSlug,
        session.cwd,
        item.mtimeMs,
        JSON.stringify(session),
        summary,
        session.name ?? "",
        content,
      );
      if (isUpdate) updated++; else added++;
      done++;
      if (done % 25 === 0) onProgress?.(`Indexed ${done}/${toIngest.length}...`);
    }

    return { added, updated, removed, moved };
  }

  async rebuild(onProgress?: (msg: string) => void): Promise<void> {
    this.db.exec("DELETE FROM sessions");
    await this.sync(onProgress);
  }

  async search(query: string, limit = 10, _signal?: AbortSignal): Promise<SearchResult[]> {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    const rows = this.db
      .prepare(
        "SELECT json, summary, bm25(sessions) AS score FROM sessions WHERE sessions MATCH ? ORDER BY score LIMIT ?",
      )
      .all(fts, limit) as any[];
    return rows.map((r) => {
      const session = JSON.parse(String(r.json)) as ParsedSession;
      // Normalize BM25 (lower is better) into a 0..1-ish relevance score for display
      const raw = Number(r.score);
      const score = 1 / (1 + Math.abs(raw));
      return { session, summary: String(r.summary ?? ""), score };
    });
  }

  list(filters?: ListFilters): ParsedSession[] {
    const clauses: string[] = [];
    const args: any[] = [];
    if (filters?.project) {
      clauses.push("(lower(projectSlug) LIKE ? OR lower(cwd) LIKE ?)");
      const p = `%${filters.project.toLowerCase()}%`;
      args.push(p, p);
    }
    if (filters?.after) { clauses.push("startedAt >= ?"); args.push(filters.after); }
    if (filters?.before) { clauses.push("startedAt <= ?"); args.push(filters.before); }
    if (filters?.archived !== undefined) {
      clauses.push("archived = ?");
      args.push(filters.archived ? 1 : 0);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filters?.limit ?? 1000;
    const sql = `SELECT json FROM sessions ${where} ORDER BY startedAt DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, limit) as any[];
    return rows.map((r) => JSON.parse(String(r.json)) as ParsedSession);
  }

  get(fileOrId: string): { session: ParsedSession; summary: string } | undefined {
    const row = this.db
      .prepare("SELECT json, summary FROM sessions WHERE id = ? OR file = ? LIMIT 1")
      .get(fileOrId, fileOrId) as any;
    if (!row) return undefined;
    return {
      session: JSON.parse(String(row.json)) as ParsedSession,
      summary: String(row.summary ?? ""),
    };
  }

  getAll(): { session: ParsedSession; summary: string }[] {
    const rows = this.db.prepare("SELECT json, summary FROM sessions").all() as any[];
    return rows.map((r) => ({
      session: JSON.parse(String(r.json)) as ParsedSession,
      summary: String(r.summary ?? ""),
    }));
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

export function buildContent(s: ParsedSession): string {
  const parts: string[] = [];
  if (s.name) parts.push(s.name);
  parts.push(s.userMessages.join("\n"));
  if (s.compactionSummaries?.length) parts.push(s.compactionSummaries.join("\n"));
  if (s.branchSummaries?.length) parts.push(s.branchSummaries.join("\n"));
  if (s.filesModified?.length) parts.push(s.filesModified.join(" "));
  return parts.join("\n\n");
}

function buildSummary(s: ParsedSession): string {
  const name = s.name || truncate(s.firstUserMessage, 80);
  const date = s.startedAt.split("T")[0];
  const lines = [
    `**${name}** (${date})`,
    `Project: ${s.projectSlug} | CWD: ${s.cwd}`,
    `Messages: ${s.userMessageCount} user, ${s.assistantMessageCount} assistant`,
  ];
  if (s.toolCalls?.length) {
    lines.push(`Tools: ${s.toolCalls.slice(0, 5).map((t) => `${t.name}(${t.count})`).join(", ")}`);
  }
  if (s.filesModified?.length) {
    lines.push(`Modified: ${s.filesModified.slice(0, 10).join(", ")}`);
  }
  if (s.archived) lines.push("(archived)");
  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

/**
 * Turn a user query into a safe FTS5 MATCH expression.
 * Strips FTS syntax characters and ORs the remaining terms.
 */
export function toFtsQuery(q: string): string {
  const terms = q
    .replace(/[\"^*():{}\[\]]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`);
  return terms.join(" OR ");
}
