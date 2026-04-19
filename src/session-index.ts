import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ParsedSession } from "./parser";
import { discoverSessionFiles, parseSession, readSessionId } from "./parser";
import type { Embedder } from "./embedder";
import { buildContent, toFtsQuery } from "./fts-index";

// ─── FTS side-car (for hybrid search) ────────────────────────────────

class FtsSide {
  private db: DatabaseSync;
  constructor(indexDir: string) {
    this.db = new DatabaseSync(join(indexDir, "hybrid-fts.db"));
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS s USING fts5(id UNINDEXED, name, content, tokenize='porter unicode61')",
    );
  }
  upsert(id: string, name: string, content: string) {
    this.db.exec("BEGIN");
    this.db.prepare("DELETE FROM s WHERE id = ?").run(id);
    this.db.prepare("INSERT INTO s (id, name, content) VALUES (?, ?, ?)").run(id, name, content);
    this.db.exec("COMMIT");
  }
  delete(id: string) { this.db.prepare("DELETE FROM s WHERE id = ?").run(id); }
  clear() { this.db.exec("DELETE FROM s"); }
  close() { this.db.close(); }
  count(): number {
    return (this.db.prepare("SELECT count(*) as c FROM s").get() as any).c;
  }
  /** Returns id→rank map (rank starts at 1, best first). */
  searchRanks(q: string, limit: number): Map<string, number> {
    const fts = toFtsQuery(q);
    const out = new Map<string, number>();
    if (!fts) return out;
    const rows = this.db
      .prepare("SELECT id FROM s WHERE s MATCH ? ORDER BY bm25(s) LIMIT ?")
      .all(fts, limit) as any[];
    rows.forEach((r, i) => out.set(String(r.id), i + 1));
    return out;
  }
}

// ─── Types ───────────────────────────────────────────────────────────

interface IndexedSession {
  /** Parsed session metadata (heavy text fields stripped after embedding) */
  session: ParsedSession;
  /** Generated summary for display + search */
  summary: string;
  /** Embedding vector of the summary + key content (base64 Float32Array) */
  embedding: number[] | string;
  /** File mtime when last indexed */
  mtimeMs: number;
  /** File size in bytes when last indexed */
  sizeBytes?: number;
}

interface IndexData {
  version: number;
  /** Keyed by session UUID — stable across file moves */
  sessions: Record<string, IndexedSession>;
}

const INDEX_VERSION = 3;

// ─── Embedding serialization ─────────────────────────────────────────

/** Encode a float array as base64 Float32Array — ~3x smaller than JSON. */
function encodeEmbedding(vec: number[]): string {
  const buf = Buffer.from(new Float32Array(vec).buffer);
  return buf.toString("base64");
}

/** Decode a base64 Float32Array back to number[]. Also handles legacy JSON arrays. */
function decodeEmbedding(stored: number[] | string): number[] {
  if (Array.isArray(stored)) return stored; // legacy format
  const buf = Buffer.from(stored, "base64");
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

/**
 * Strip heavy text fields from ParsedSession before persisting.
 * These are only needed during embedding generation, not at search/list time.
 * Saves ~17MB across 2000 sessions.
 */
function stripHeavyFields(session: ParsedSession): ParsedSession {
  return {
    ...session,
    userMessages: [],
    assistantText: "",
    firstUserMessage: session.firstUserMessage.slice(0, 200),
    compactionSummaries: session.compactionSummaries.map(s => s.slice(0, 300)),
    branchSummaries: session.branchSummaries.map(s => s.slice(0, 200)),
  };
}

// ─── Session Index ───────────────────────────────────────────────────

export class SessionIndex {
  private data: IndexData = { version: INDEX_VERSION, sessions: {} };
  private indexPath: string;
  private fts: FtsSide;

  constructor(
    private embedder: Embedder,
    private indexDir: string,
    private extraSessionDirs: string[] = [],
    private extraArchiveDirs: string[] = [],
  ) {
    mkdirSync(indexDir, { recursive: true });
    this.indexPath = join(indexDir, "session-index.json");
    this.fts = new FtsSide(indexDir);
  }

  /** Load existing index from disk. */
  async load(): Promise<void> {
    if (!existsSync(this.indexPath)) return;
    try {
      const raw = readFileSync(this.indexPath, "utf8");
      const parsed = JSON.parse(raw) as IndexData;
      if (parsed.version === INDEX_VERSION) {
        this.data = parsed;
      } else if (parsed.version === 2) {
        // Migrate v2 → v3: encode embeddings as base64, strip heavy fields
        for (const entry of Object.values(parsed.sessions)) {
          if (Array.isArray(entry.embedding)) {
            entry.embedding = encodeEmbedding(entry.embedding);
          }
          entry.session = stripHeavyFields(entry.session);
        }
        parsed.version = INDEX_VERSION;
        this.data = parsed;
        this.save(); // persist the migration
      }
      // v1 index (keyed by file path) is incompatible — rebuild from scratch
    } catch {
      this.data = { version: INDEX_VERSION, sessions: {} };
    }

    // Populate FTS side-car if it's empty but the JSON index has sessions
    const sessionCount = Object.keys(this.data.sessions).length;
    if (sessionCount > 0 && this.fts.count() === 0) {
      this.populateFtsFromIndex();
    }
  }

  /**
   * Populate the FTS side-car from existing index data.
   * Used when the JSON index is loaded but the FTS DB is empty (e.g. first
   * run after upgrade, or if the .db file was deleted).
   */
  private populateFtsFromIndex(): void {
    for (const [id, entry] of Object.entries(this.data.sessions)) {
      const s = entry.session;
      // Reconstruct FTS content from the stripped session metadata
      const parts: string[] = [];
      if (s.name) parts.push(s.name);
      if (s.firstUserMessage) parts.push(s.firstUserMessage);
      if (s.compactionSummaries?.length) parts.push(s.compactionSummaries.join("\n"));
      if (s.branchSummaries?.length) parts.push(s.branchSummaries.join("\n"));
      if (s.filesModified?.length) parts.push(s.filesModified.join(" "));
      const content = parts.join("\n\n");
      this.fts.upsert(id, s.name ?? "", content);
    }
  }

  /** Save index to disk. */
  save(): void {
    writeFileSync(this.indexPath, JSON.stringify(this.data), "utf8");
  }

  /** Number of indexed sessions. */
  size(): number {
    return Object.keys(this.data.sessions).length;
  }

  /**
   * Sync: discover sessions, parse new/changed ones, handle moves, remove
   * sessions whose files no longer exist anywhere.
   */
  async sync(
    onProgress?: (msg: string) => void
  ): Promise<{ added: number; updated: number; removed: number; moved: number }> {
    const discovered = discoverSessionFiles(
      this.extraSessionDirs,
      this.extraArchiveDirs,
    );

    let added = 0;
    let updated = 0;
    let removed = 0;
    let moved = 0;

    // ── Phase 1: Build a map of discovered files → session ID ────────
    // We need session IDs to correlate with the index. For files already
    // in the index we can match by scanning existing entries. For unknown
    // files we do a quick header-only read.
    const fileToId = new Map<string, string>();
    const idToFile = new Map<string, { file: string; archived: boolean; mtimeMs: number; sizeBytes: number }>();

    // Build a reverse lookup: sessionId → current indexed file path
    const indexedIdToFile = new Map<string, string>();
    for (const [id, entry] of Object.entries(this.data.sessions)) {
      indexedIdToFile.set(id, entry.session.file);
    }

    for (const { file, archived } of discovered) {
      let mtimeMs: number;
      let sizeBytes: number;
      try {
        const st = statSync(file);
        mtimeMs = st.mtimeMs;
        sizeBytes = st.size;
      } catch {
        continue; // can't stat — skip
      }

      // Try to match by checking if any indexed entry already has this file
      let sessionId: string | null = null;
      for (const [id, entry] of Object.entries(this.data.sessions)) {
        if (entry.session.file === file) {
          sessionId = id;
          break;
        }
      }

      // Not found in index by path — quick-read the header for the UUID
      if (!sessionId) {
        sessionId = readSessionId(file);
      }

      if (!sessionId) continue; // unparseable file

      fileToId.set(file, sessionId);

      // If multiple files claim the same session ID, prefer the newer one
      const existing = idToFile.get(sessionId);
      if (!existing || mtimeMs > existing.mtimeMs) {
        idToFile.set(sessionId, { file, archived, mtimeMs, sizeBytes });
      }
    }

    // ── Phase 2: Remove indexed sessions that no longer exist on disk ─
    const discoveredIds = new Set(idToFile.keys());
    for (const id of Object.keys(this.data.sessions)) {
      if (!discoveredIds.has(id)) {
        delete this.data.sessions[id];
        this.fts.delete(id);
        removed++;
      }
    }

    // ── Phase 3: Detect moves, new, and changed sessions ─────────────
    const toEmbed: { id: string; file: string; archived: boolean; mtimeMs: number; sizeBytes: number }[] = [];

    for (const [id, disc] of idToFile.entries()) {
      const existing = this.data.sessions[id];

      if (existing) {
        // Session already indexed
        const pathChanged = existing.session.file !== disc.file;
        const sizeChanged = (existing.sizeBytes ?? 0) !== disc.sizeBytes;

        if (pathChanged && !sizeChanged) {
          // ── Moved (e.g. sessions/ → sessions-archive/) ──
          // Update file path + archived flag, keep embedding
          existing.session.file = disc.file;
          existing.session.archived = disc.archived;
          existing.mtimeMs = disc.mtimeMs;
          existing.sizeBytes = disc.sizeBytes;
          existing.summary = buildSummary(existing.session);
          moved++;
        } else if (sizeChanged) {
          // ── Content changed (file size differs) ──
          // Need full re-parse + re-embed
          toEmbed.push({ id, ...disc });
        }
        // else: unchanged (same size, same path) — skip
      } else {
        // ── Brand new session ──
        toEmbed.push({ id, ...disc });
      }
    }

    if (toEmbed.length === 0) {
      if (moved > 0 || removed > 0) this.save();
      return { added, updated, removed, moved };
    }

    onProgress?.(`Indexing ${toEmbed.length} sessions...`);

    // ── Phase 4: Parse + embed in batches ────────────────────────────
    const BATCH_SIZE = 20;
    for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
      const batch = toEmbed.slice(i, i + BATCH_SIZE);
      const parsed: { item: (typeof toEmbed)[0]; session: ParsedSession }[] = [];

      for (const item of batch) {
        const session = parseSession(item.file, item.archived);
        if (session && session.userMessageCount > 0) {
          parsed.push({ item, session });
        }
      }

      if (parsed.length === 0) continue;

      const texts = parsed.map(({ session }) => buildEmbeddingText(session));

      try {
        const embeddings = await this.embedder.embedBatch(texts);

        for (let j = 0; j < parsed.length; j++) {
          const { item, session } = parsed[j];
          const embedding = embeddings[j];
          if (!embedding) continue; // failed to embed

          const isUpdate = !!this.data.sessions[item.id];

          this.data.sessions[item.id] = {
            session: stripHeavyFields(session),
            summary: buildSummary(session),
            embedding: encodeEmbedding(embedding),
            mtimeMs: item.mtimeMs,
            sizeBytes: item.sizeBytes,
          };
          this.fts.upsert(item.id, session.name ?? "", buildContent(session));

          if (isUpdate) updated++;
          else added++;
        }
      } catch (err: any) {
        onProgress?.(`Embedding batch failed: ${err.message}`);
      }

      onProgress?.(
        `Indexed ${Math.min(i + BATCH_SIZE, toEmbed.length)}/${toEmbed.length}...`
      );
    }

    this.save();
    return { added, updated, removed, moved };
  }

  /** Full rebuild — clear and re-index everything. */
  async rebuild(onProgress?: (msg: string) => void): Promise<void> {
    this.data = { version: INDEX_VERSION, sessions: {} };
    this.fts.clear();
    await this.sync(onProgress);
  }

  /**
   * Hybrid search: cosine embeddings + FTS5 BM25, fused via Reciprocal Rank
   * Fusion (k=60). Falls back to pure semantic if FTS side-car is empty.
   */
  async search(
    query: string,
    limit: number = 10,
    signal?: AbortSignal
  ): Promise<SearchResult[]> {
    const entries = Object.values(this.data.sessions);
    if (entries.length === 0) return [];

    const queryEmbedding = await this.embedder.embed(query);
    if (signal?.aborted) return [];

    // Rank by cosine similarity
    const cosineScored = entries
      .map((entry) => ({
        entry,
        score: cosineSimilarity(queryEmbedding, decodeEmbedding(entry.embedding)),
      }))
      .sort((a, b) => b.score - a.score);

    // Pull a larger candidate pool from each side so fusion has room to rank
    const poolSize = Math.max(limit * 5, 100);
    const cosineRanks = new Map<string, number>();
    cosineScored.slice(0, poolSize).forEach((s, i) => {
      cosineRanks.set(s.entry.session.id, i + 1);
    });

    const ftsRanks = this.fts.searchRanks(query, poolSize);

    // RRF fusion: score = Σ 1 / (k + rank)
    const K = 60;
    const fused = new Map<string, number>();
    for (const [id, r] of cosineRanks) fused.set(id, (fused.get(id) ?? 0) + 1 / (K + r));
    for (const [id, r] of ftsRanks) fused.set(id, (fused.get(id) ?? 0) + 1 / (K + r));

    const sorted = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);

    return sorted
      .map(([id, score]) => {
        const entry = this.data.sessions[id];
        if (!entry) return null;
        return { session: entry.session, summary: entry.summary, score };
      })
      .filter((r): r is SearchResult => r !== null);
  }

  /**
   * List sessions with optional filters.
   */
  list(filters?: ListFilters): ParsedSession[] {
    let sessions = Object.values(this.data.sessions).map((e) => e.session);

    if (filters?.project) {
      const slug = filters.project.toLowerCase();
      sessions = sessions.filter(
        (s) =>
          s.projectSlug.toLowerCase().includes(slug) ||
          s.cwd.toLowerCase().includes(slug)
      );
    }

    if (filters?.after) {
      sessions = sessions.filter((s) => s.startedAt >= filters.after!);
    }

    if (filters?.before) {
      sessions = sessions.filter((s) => s.startedAt <= filters.before!);
    }

    if (filters?.archived !== undefined) {
      sessions = sessions.filter((s) => s.archived === filters.archived);
    }

    // Sort by start time, newest first
    sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    if (filters?.limit) {
      sessions = sessions.slice(0, filters.limit);
    }

    return sessions;
  }

  /**
   * Get a specific session by file path or session ID.
   */
  get(fileOrId: string): IndexedSession | undefined {
    // Try direct session ID lookup
    if (this.data.sessions[fileOrId]) {
      return this.data.sessions[fileOrId];
    }
    // Try by file path
    return Object.values(this.data.sessions).find(
      (e) => e.session.file === fileOrId
    );
  }

  /** Get all indexed session objects. */
  getAll(): IndexedSession[] {
    return Object.values(this.data.sessions);
  }

  close(): void {
    this.fts.close();
  }
}

// ─── Search types ────────────────────────────────────────────────────

export interface SearchResult {
  session: ParsedSession;
  summary: string;
  score: number;
}

export interface ListFilters {
  project?: string;
  after?: string;
  before?: string;
  archived?: boolean;
  limit?: number;
}

// ─── Summary generation ──────────────────────────────────────────────

function buildSummary(s: ParsedSession): string {
  const lines: string[] = [];
  const name = s.name || truncate(s.firstUserMessage, 80);
  const date = s.startedAt.split("T")[0];
  const project = slugToProject(s.projectSlug);

  lines.push(`**${name}** (${date})`);
  lines.push(`Project: ${project} | CWD: ${s.cwd}`);
  lines.push(
    `Messages: ${s.userMessageCount} user, ${s.assistantMessageCount} assistant`
  );

  if (s.models.length > 0) {
    lines.push(`Models: ${s.models.join(", ")}`);
  }

  if (s.toolCalls.length > 0) {
    const top = s.toolCalls
      .slice(0, 5)
      .map((t) => `${t.name}(${t.count})`)
      .join(", ");
    lines.push(`Tools: ${top}`);
  }

  if (s.filesModified.length > 0) {
    lines.push(`Modified: ${s.filesModified.slice(0, 10).join(", ")}`);
  }

  if (s.compactionSummaries.length > 0) {
    lines.push(`\nCompaction summaries:`);
    for (const cs of s.compactionSummaries) {
      lines.push(truncate(cs, 500));
    }
  }

  if (s.archived) {
    lines.push(`(archived)`);
  }

  return lines.join("\n");
}

/**
 * Build text for embedding — combines key content for semantic search.
 */
function buildEmbeddingText(s: ParsedSession): string {
  const parts: string[] = [];

  if (s.name) parts.push(s.name);

  // User messages are the strongest signal
  const userText = s.userMessages.join("\n").slice(0, 6000);
  parts.push(userText);

  // Assistant text captures analysis, conclusions, and discoveries
  if (s.assistantText) {
    const assistantBudget = 3000;
    const truncatedAssistant = s.assistantText.slice(0, assistantBudget);
    parts.push(`Assistant:\n${truncatedAssistant}`);
  }

  // Compaction summaries are great condensed representations
  if (s.compactionSummaries.length > 0) {
    parts.push(s.compactionSummaries.join("\n").slice(0, 4000));
  }

  // Branch summaries
  if (s.branchSummaries.length > 0) {
    parts.push(s.branchSummaries.join("\n").slice(0, 2000));
  }

  // Project context
  parts.push(`Project: ${slugToProject(s.projectSlug)}`);
  parts.push(`CWD: ${s.cwd}`);

  // Files modified give strong project context
  if (s.filesModified.length > 0) {
    parts.push(`Files modified: ${s.filesModified.join(", ")}`);
  }

  // Limit total embedding text
  return parts.join("\n\n").slice(0, 16000);
}

// ─── Utilities ───────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

function slugToProject(slug: string): string {
  if (!slug.startsWith("--") || !slug.endsWith("--")) return slug;
  return slug
    .slice(2, -2)
    .replace(/-/g, "/");
}
