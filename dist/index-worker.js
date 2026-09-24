// src/index-worker.ts
import { parentPort, workerData } from "node:worker_threads";

// src/embedder.ts
var DEFAULTS = {
  openai: { model: "text-embedding-3-small", dimensions: 512, baseUrl: "https://api.openai.com", sendDimensions: true },
  bedrock: {
    model: "amazon.titan-embed-text-v2:0",
    region: "us-east-1",
    profile: "default",
    dimensions: 512
  },
  ollama: { model: "nomic-embed-text", url: "http://localhost:11434" },
  mistral: { model: "mistral-embed", dimensions: 1024, baseUrl: "https://api.mistral.ai", sendDimensions: false },
  "openai-compatible": { model: "text-embedding-3-small", dimensions: 512, sendDimensions: false }
};
function createEmbedder(config) {
  const defaults = DEFAULTS[config.type] ?? {};
  const merged = { ...defaults, ...config };
  switch (merged.type) {
    case "openai":
      return new OpenAICompatibleEmbedder(
        merged.apiKey || process.env.OPENAI_API_KEY || "",
        merged.model,
        merged.dimensions,
        merged.baseUrl || "https://api.openai.com",
        merged.sendDimensions ?? true
      );
    case "mistral":
      return new OpenAICompatibleEmbedder(
        merged.apiKey || process.env.MISTRAL_API_KEY || "",
        merged.model,
        merged.dimensions,
        merged.baseUrl || "https://api.mistral.ai",
        merged.sendDimensions ?? false
      );
    case "openai-compatible": {
      if (!merged.baseUrl) throw new Error("openai-compatible requires baseUrl");
      return new OpenAICompatibleEmbedder(
        merged.apiKey || "",
        merged.model,
        merged.dimensions,
        merged.baseUrl,
        merged.sendDimensions ?? false
      );
    }
    case "bedrock":
      return new BedrockEmbedder(
        merged.profile,
        merged.region,
        merged.model,
        merged.dimensions
      );
    case "ollama":
      return new OllamaEmbedder(merged.url, merged.model);
    default:
      throw new Error(`Unknown embedder type: ${merged.type}`);
  }
}
function truncate(text, maxChars = 12e3) {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}
async function parallelMap(items, fn, concurrency, signal) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      if (signal?.aborted) throw new Error("Aborted");
      const idx = cursor++;
      results[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}
var OpenAICompatibleEmbedder = class {
  constructor(apiKey, model, dimensions, baseUrl, sendDimensions) {
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
    this.sendDimensions = sendDimensions;
    this.endpoint = `${baseUrl.replace(/\/$/, "")}/v1/embeddings`;
  }
  apiKey;
  model;
  dimensions;
  sendDimensions;
  endpoint;
  async embed(text, signal) {
    const [result] = await this.embedBatch([text], signal);
    if (!result) throw new Error("Embedding failed");
    return result;
  }
  async embedBatch(texts, signal) {
    const BATCH = 100;
    const results = new Array(texts.length).fill(null);
    for (let i = 0; i < texts.length; i += BATCH) {
      if (signal?.aborted) throw new Error("Aborted");
      const batch = texts.slice(i, i + BATCH).map((t) => truncate(t));
      const body = {
        input: batch,
        model: this.model
      };
      if (this.dimensions && this.sendDimensions) {
        body.dimensions = this.dimensions;
      }
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal
      });
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Embeddings API ${res.status}: ${errBody.slice(0, 200)}`);
      }
      const json = await res.json();
      for (let k = 0; k < json.data.length; k++) {
        const item = json.data[k];
        results[i + (item.index ?? k)] = item.embedding;
      }
    }
    return results;
  }
};
var BedrockEmbedder = class {
  constructor(profile, region, model, dimensions) {
    this.model = model;
    this.dimensions = dimensions;
    this.clientPromise = (async () => {
      const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
      const { fromIni } = await import("@aws-sdk/credential-providers");
      return new BedrockRuntimeClient({
        region,
        credentials: fromIni({ profile })
      });
    })();
  }
  model;
  dimensions;
  clientPromise;
  async embed(text, signal) {
    const [result] = await this.embedBatch([text], signal);
    if (!result) throw new Error("Embedding failed");
    return result;
  }
  async embedBatch(texts, signal) {
    const client = await this.clientPromise;
    return parallelMap(
      texts,
      async (text) => {
        const { InvokeModelCommand } = await import("@aws-sdk/client-bedrock-runtime");
        const body = JSON.stringify({
          inputText: truncate(text),
          dimensions: this.dimensions,
          normalize: true
        });
        const cmd = new InvokeModelCommand({
          modelId: this.model,
          contentType: "application/json",
          accept: "application/json",
          body: new TextEncoder().encode(body)
        });
        const res = await client.send(cmd);
        const parsed = JSON.parse(new TextDecoder().decode(res.body));
        if (!parsed.embedding) throw new Error("No embedding in response");
        return parsed.embedding;
      },
      10,
      signal
    );
  }
};
var OllamaEmbedder = class {
  constructor(url, model) {
    this.url = url;
    this.model = model;
    this.url = url.replace(/\/$/, "");
  }
  url;
  model;
  async embed(text, signal) {
    const res = await fetch(`${this.url}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: truncate(text) }),
      signal
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    return json.embeddings[0];
  }
  async embedBatch(texts, signal) {
    return parallelMap(
      texts,
      async (text) => {
        try {
          return await this.embed(text, signal);
        } catch {
          return null;
        }
      },
      4,
      signal
    );
  }
};

// src/fts-index.ts
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
import { mkdirSync, statSync as statSync2 } from "node:fs";
import { join as join2 } from "node:path";

// src/parser.ts
import { readFileSync, readdirSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join, basename, dirname } from "node:path";
function getDefaultSessionDir() {
  return process.env.PI_SESSION_DIR || join(process.env.HOME || "~", ".pi", "agent", "sessions");
}
function getDefaultArchiveDir() {
  return process.env.PI_SESSION_ARCHIVE_DIR || join(process.env.HOME || "~", ".pi", "agent", "sessions-archive");
}
function discoverSessionFiles(extraSessionDirs = [], extraArchiveDirs = [], sessionDir, archiveDir) {
  const sDirs = [sessionDir ?? getDefaultSessionDir(), ...extraSessionDirs];
  const aDirs = [archiveDir ?? getDefaultArchiveDir(), ...extraArchiveDirs];
  const results = [];
  for (const dir of sDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of walkJsonl(dir)) {
      results.push({ file: entry, archived: false });
    }
  }
  for (const dir of aDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of walkJsonl(dir)) {
      results.push({ file: entry, archived: true });
    }
  }
  return results;
}
function walkJsonl(dir) {
  const files = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...walkJsonl(full));
      } else if (entry.name.endsWith(".jsonl") && entry.name !== "pins.json" && entry.name !== "active-sessions.json") {
        files.push(full);
      }
    }
  } catch {
  }
  return files;
}
function readSessionId(file) {
  try {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(1024);
      const bytesRead = readSync(fd, buf, 0, 1024, 0);
      const firstLine = buf.toString("utf8", 0, bytesRead).split("\n")[0];
      if (!firstLine) return null;
      const obj = JSON.parse(firstLine.replace(/^\uFEFF/, "").trim());
      return obj.type === "session" ? obj.id : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}
var MAX_ASSISTANT_TEXT = 5e4;
function cleanLine(line) {
  return line.replace(/^\uFEFF/, "").trim();
}
function parseSession(file, archived) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = raw.trim().split("\n");
  if (lines.length === 0) return null;
  let header = null;
  const entries = [];
  for (const line of lines) {
    const cleaned = cleanLine(line);
    if (!cleaned) continue;
    try {
      const obj = JSON.parse(cleaned);
      if (obj.type === "session") {
        header = obj;
      } else {
        entries.push(obj);
      }
    } catch {
    }
  }
  if (!header) return null;
  const parentDir = basename(dirname(file));
  const projectSlug = parentDir.startsWith("--") ? parentDir : "unknown";
  const models = /* @__PURE__ */ new Set();
  const toolCallMap = /* @__PURE__ */ new Map();
  const filesRead = /* @__PURE__ */ new Set();
  const filesModified = /* @__PURE__ */ new Set();
  const userMessages = [];
  const compactionSummaries = [];
  const branchSummaries = [];
  let assistantText = "";
  let name;
  let lastTimestamp = header.timestamp;
  let totalCost = 0;
  let totalTokens = 0;
  let userMsgCount = 0;
  let assistantMsgCount = 0;
  for (const entry of entries) {
    if (entry.timestamp) lastTimestamp = entry.timestamp;
    switch (entry.type) {
      case "message": {
        const msg = entry.message;
        if (!msg) break;
        if (msg.role === "user") {
          userMsgCount++;
          const text = extractTextContent(msg.content);
          if (text) userMessages.push(text);
        }
        if (msg.role === "assistant") {
          assistantMsgCount++;
          if (msg.provider && msg.model) {
            models.add(`${msg.provider}/${msg.model}`);
          }
          if (msg.usage) {
            totalCost += msg.usage.cost?.total ?? 0;
            totalTokens += msg.usage.totalTokens ?? 0;
          }
          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === "text" && assistantText.length < MAX_ASSISTANT_TEXT) {
                assistantText += block.text + "\n";
              }
              if (block.type === "toolCall") {
                const name2 = block.name;
                toolCallMap.set(name2, (toolCallMap.get(name2) ?? 0) + 1);
              }
            }
          }
        }
        if (msg.role === "toolResult") {
          const tn = msg.toolName;
          if (tn === "read" || tn === "lsp_hover" || tn === "lsp_definition") {
            const path = extractPathFromToolResult(entry, msg);
            if (path) filesRead.add(path);
          }
          if (tn === "write" || tn === "edit") {
            const path = extractPathFromToolResult(entry, msg);
            if (path) filesModified.add(path);
          }
        }
        break;
      }
      case "model_change":
        if (entry.provider && entry.modelId) {
          models.add(`${entry.provider}/${entry.modelId}`);
        }
        break;
      case "compaction":
        if (entry.summary) compactionSummaries.push(entry.summary);
        break;
      case "branch_summary":
        if (entry.summary) branchSummaries.push(entry.summary);
        break;
      case "session_info":
        if (entry.name) name = entry.name;
        break;
    }
  }
  const toolCalls = Array.from(toolCallMap.entries()).map(([name2, count]) => ({ name: name2, count })).sort((a, b) => b.count - a.count);
  return {
    file,
    id: header.id,
    startedAt: header.timestamp,
    endedAt: lastTimestamp,
    cwd: header.cwd,
    name,
    archived,
    projectSlug,
    models: Array.from(models),
    userMessageCount: userMsgCount,
    assistantMessageCount: assistantMsgCount,
    toolCalls,
    filesRead: Array.from(filesRead).slice(0, 100),
    filesModified: Array.from(filesModified).slice(0, 100),
    firstUserMessage: userMessages[0] ?? "",
    userMessages,
    assistantText: assistantText.slice(0, MAX_ASSISTANT_TEXT),
    compactionSummaries,
    branchSummaries,
    totalCost,
    totalTokens
  };
}
function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }
  return "";
}
function extractPathFromToolResult(_entry, msg) {
  if (msg.details?.path) return msg.details.path;
  if (msg.details?.diff) {
    const match = msg.details.diff?.match?.(/^  \d+ (.*)/m);
    if (match) return match[1];
  }
  if (msg.toolName === "read" && msg.content?.[0]?.text) {
  }
  return null;
}

// src/utils.ts
function createYielder(budgetMs = 8) {
  let last = performance.now();
  return {
    due: () => performance.now() - last >= budgetMs,
    async yield() {
      await new Promise((r) => setImmediate(r));
      last = performance.now();
    }
  };
}
function truncate2(s, max) {
  return s.length <= max ? s : s.slice(0, max) + "\u2026";
}
function slugToProject(slug) {
  if (!slug.startsWith("--") || !slug.endsWith("--")) return slug;
  return slug.slice(2, -2).replace(/-/g, "/");
}
function buildSummary(s) {
  const lines = [];
  const name = s.name || truncate2(s.firstUserMessage, 80);
  const date = s.startedAt.split("T")[0];
  const project = slugToProject(s.projectSlug);
  lines.push(`**${name}** (${date})`);
  lines.push(`Project: ${project} | CWD: ${s.cwd}`);
  lines.push(
    `Messages: ${s.userMessageCount} user, ${s.assistantMessageCount} assistant`
  );
  if (s.models?.length) {
    lines.push(`Models: ${s.models.join(", ")}`);
  }
  if (s.toolCalls?.length) {
    const top = s.toolCalls.slice(0, 5).map((t) => `${t.name}(${t.count})`).join(", ");
    lines.push(`Tools: ${top}`);
  }
  if (s.filesModified?.length) {
    lines.push(`Modified: ${s.filesModified.slice(0, 10).join(", ")}`);
  }
  if (s.compactionSummaries?.length) {
    lines.push(`
Compaction summaries:`);
    for (const cs of s.compactionSummaries) {
      lines.push(truncate2(cs, 500));
    }
  }
  if (s.archived) {
    lines.push(`(archived)`);
  }
  return lines.join("\n");
}

// src/fts5-probe.ts
import { DatabaseSync } from "node:sqlite";
var cached = null;
function assertFts5Available() {
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
    try {
      db.close();
    } catch {
    }
  }
}
function fts5ErrorMessage() {
  return `SQLite FTS5 is not available in this Node runtime. pi-session-search requires Node 22.19+ or 24+ (where node:sqlite ships with FTS5 compiled in). Current: Node ${process.versions.node}. Upgrade Node and restart pi.`;
}

// src/fts-index.ts
var FtsSessionIndex = class {
  db;
  dbPath;
  indexDir;
  extraSessionDirs;
  extraArchiveDirs;
  sessionDir;
  archiveDir;
  constructor(indexDir, extraSessionDirs = [], extraArchiveDirs = [], sessionDir, archiveDir) {
    this.indexDir = indexDir;
    this.extraSessionDirs = extraSessionDirs;
    this.extraArchiveDirs = extraArchiveDirs;
    this.sessionDir = sessionDir;
    this.archiveDir = archiveDir;
    mkdirSync(indexDir, { recursive: true });
    this.dbPath = join2(indexDir, "sessions-fts.db");
  }
  async load() {
    assertFts5Available();
    this.db = new DatabaseSync2(this.dbPath);
    this.db.exec("PRAGMA busy_timeout = 5000;");
    let hasSizeBytes = false;
    try {
      this.db.prepare("SELECT sizeBytes FROM sessions LIMIT 0").all();
      hasSizeBytes = true;
    } catch {
    }
    if (!hasSizeBytes) {
      this.db.exec("DROP TABLE IF EXISTS sessions");
    }
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions USING fts5(
        id UNINDEXED,
        file UNINDEXED,
        archived UNINDEXED,
        startedAt UNINDEXED,
        projectSlug UNINDEXED,
        cwd UNINDEXED,
        mtimeMs UNINDEXED,
        sizeBytes UNINDEXED,
        json UNINDEXED,
        summary UNINDEXED,
        name,
        content,
        tokenize='porter unicode61'
      );
    `);
  }
  save() {
  }
  size() {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM sessions").get();
    return Number(row?.n ?? 0);
  }
  async sync(onProgress, _onError) {
    const discovered = discoverSessionFiles(this.extraSessionDirs, this.extraArchiveDirs, this.sessionDir, this.archiveDir);
    let added = 0, updated = 0, removed = 0, moved = 0;
    const pause = createYielder();
    const idToFile = /* @__PURE__ */ new Map();
    for (const { file, archived } of discovered) {
      if (pause.due()) await pause.yield();
      let mtimeMs;
      let sizeBytes;
      try {
        const st = statSync2(file);
        mtimeMs = st.mtimeMs;
        sizeBytes = st.size;
      } catch {
        continue;
      }
      const id = readSessionId(file);
      if (!id) continue;
      const existing = idToFile.get(id);
      if (!existing || mtimeMs > existing.mtimeMs) {
        idToFile.set(id, { file, archived, mtimeMs, sizeBytes });
      }
    }
    const currentRows = this.db.prepare("SELECT id, file, mtimeMs, sizeBytes FROM sessions").all();
    const currentIds = new Set(currentRows.map((r) => String(r.id)));
    const currentById = /* @__PURE__ */ new Map();
    for (const r of currentRows) {
      currentById.set(String(r.id), {
        file: String(r.file),
        mtimeMs: Number(r.mtimeMs),
        sizeBytes: Number(r.sizeBytes ?? 0)
      });
    }
    const delStmt = this.db.prepare("DELETE FROM sessions WHERE id = ?");
    this.db.exec("BEGIN");
    for (const id of currentIds) {
      if (!idToFile.has(id)) {
        delStmt.run(id);
        removed++;
      }
    }
    this.db.exec("COMMIT");
    const toIngest = [];
    const movedUpdates = [];
    for (const [id, disc] of idToFile.entries()) {
      const cur = currentById.get(id);
      if (!cur) {
        toIngest.push({ id, ...disc });
      } else if (cur.sizeBytes !== disc.sizeBytes) {
        toIngest.push({ id, ...disc });
      } else if (cur.file !== disc.file) {
        movedUpdates.push({ id, ...disc });
      }
    }
    const moveStmt = this.db.prepare(
      "UPDATE sessions SET file = ?, archived = ?, mtimeMs = ?, sizeBytes = ? WHERE id = ?"
    );
    for (const m of movedUpdates) {
      moveStmt.run(m.file, m.archived ? 1 : 0, m.mtimeMs, m.sizeBytes, m.id);
      moved++;
    }
    if (toIngest.length > 0) onProgress?.(`Indexing ${toIngest.length} sessions...`);
    const insertStmt = this.db.prepare(`
      INSERT INTO sessions (id, file, archived, startedAt, projectSlug, cwd, mtimeMs, sizeBytes, json, summary, name, content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const replaceDel = this.db.prepare("DELETE FROM sessions WHERE id = ?");
    this.db.exec("BEGIN");
    let done = 0;
    for (const item of toIngest) {
      if (pause.due()) {
        this.db.exec("COMMIT");
        await pause.yield();
        this.db.exec("BEGIN");
      }
      const session = parseSession(item.file, item.archived);
      if (!session || session.userMessageCount === 0) {
        done++;
        continue;
      }
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
        item.sizeBytes,
        JSON.stringify(session),
        summary,
        session.name ?? "",
        content
      );
      if (isUpdate) updated++;
      else added++;
      done++;
      if (done % 25 === 0) onProgress?.(`Indexed ${done}/${toIngest.length}...`);
    }
    this.db.exec("COMMIT");
    return { added, updated, removed, moved };
  }
  async rebuild(onProgress, onError) {
    this.db.exec("DELETE FROM sessions");
    await this.sync(onProgress, onError);
  }
  async search(query, limit = 10, _signal, project) {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    const clauses = ["sessions MATCH ?"];
    const args = [fts];
    if (project) {
      clauses.push("(lower(projectSlug) LIKE ? OR lower(cwd) LIKE ?)");
      const p = `%${project.toLowerCase()}%`;
      args.push(p, p);
    }
    const sql = `SELECT json, summary, bm25(sessions) AS score FROM sessions WHERE ${clauses.join(" AND ")} ORDER BY score LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, limit);
    return rows.map((r) => {
      const session = JSON.parse(String(r.json));
      const raw = Number(r.score);
      const score = 1 / (1 + Math.abs(raw));
      return { session, summary: String(r.summary ?? ""), score };
    });
  }
  list(filters) {
    const clauses = [];
    const args = [];
    if (filters?.project) {
      clauses.push("(lower(projectSlug) LIKE ? OR lower(cwd) LIKE ?)");
      const p = `%${filters.project.toLowerCase()}%`;
      args.push(p, p);
    }
    if (filters?.after) {
      clauses.push("startedAt >= ?");
      args.push(filters.after);
    }
    if (filters?.before) {
      clauses.push("startedAt <= ?");
      args.push(filters.before);
    }
    if (filters?.archived !== void 0) {
      clauses.push("archived = ?");
      args.push(filters.archived ? 1 : 0);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filters?.limit ?? 1e3;
    const sql = `SELECT json FROM sessions ${where} ORDER BY startedAt DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, limit);
    return rows.map((r) => JSON.parse(String(r.json)));
  }
  get(fileOrId) {
    const row = this.db.prepare("SELECT json, summary FROM sessions WHERE id = ? OR file = ? LIMIT 1").get(fileOrId, fileOrId);
    if (!row) return void 0;
    return {
      session: JSON.parse(String(row.json)),
      summary: String(row.summary ?? "")
    };
  }
  getAll() {
    const rows = this.db.prepare("SELECT json, summary FROM sessions").all();
    return rows.map((r) => ({
      session: JSON.parse(String(r.json)),
      summary: String(r.summary ?? "")
    }));
  }
  close() {
    this.db.close();
  }
};
function buildContent(s) {
  const parts = [];
  if (s.name) parts.push(s.name);
  parts.push(s.userMessages.join("\n"));
  if (s.compactionSummaries?.length) parts.push(s.compactionSummaries.join("\n"));
  if (s.branchSummaries?.length) parts.push(s.branchSummaries.join("\n"));
  if (s.filesModified?.length) parts.push(s.filesModified.join(" "));
  return parts.join("\n\n");
}
function toFtsQuery(q) {
  const terms = q.replace(/[\"^*():{}\[\]]/g, " ").split(/\s+/).map((t) => t.trim()).filter((t) => t.length > 0).map((t) => `"${t}"`);
  return terms.join(" OR ");
}

// src/session-index.ts
import { readFileSync as readFileSync2, writeFileSync, existsSync as existsSync2, mkdirSync as mkdirSync2, renameSync, statSync as statSync3 } from "node:fs";
import { join as join3 } from "node:path";
import { DatabaseSync as DatabaseSync3 } from "node:sqlite";
var FtsSide = class {
  db;
  constructor(indexDir) {
    assertFts5Available();
    this.db = new DatabaseSync3(join3(indexDir, "hybrid-fts.db"));
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS s USING fts5(id UNINDEXED, name, content, tokenize='porter unicode61')"
    );
  }
  upsert(id, name, content) {
    this.db.exec("BEGIN");
    this.db.prepare("DELETE FROM s WHERE id = ?").run(id);
    this.db.prepare("INSERT INTO s (id, name, content) VALUES (?, ?, ?)").run(id, name, content);
    this.db.exec("COMMIT");
  }
  delete(id) {
    this.db.prepare("DELETE FROM s WHERE id = ?").run(id);
  }
  clear() {
    this.db.exec("DELETE FROM s");
  }
  close() {
    this.db.close();
  }
  count() {
    return this.db.prepare("SELECT count(*) as c FROM s").get().c;
  }
  /**
   * Returns id→rank map (rank starts at 1, best first).
   *
   * When `allowedIds` is provided, non-matching IDs are skipped and the rank
   * is assigned from the filtered subset. A larger pool is pulled from SQLite
   * to compensate for the filtering.
   */
  searchRanks(q, limit, allowedIds) {
    const fts = toFtsQuery(q);
    const out = /* @__PURE__ */ new Map();
    if (!fts) return out;
    const pullLimit = allowedIds ? Math.max(limit * 5, 500) : limit;
    const rows = this.db.prepare("SELECT id FROM s WHERE s MATCH ? ORDER BY bm25(s) LIMIT ?").all(fts, pullLimit);
    let rank = 1;
    for (const r of rows) {
      const id = String(r.id);
      if (allowedIds && !allowedIds.has(id)) continue;
      out.set(id, rank++);
      if (out.size >= limit) break;
    }
    return out;
  }
};
var INDEX_VERSION = 3;
function encodeEmbedding(vec) {
  const buf = Buffer.from(new Float32Array(vec).buffer);
  return buf.toString("base64");
}
function decodeEmbedding(stored) {
  if (Array.isArray(stored)) return stored;
  const buf = Buffer.from(stored, "base64");
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}
function stripHeavyFields(session) {
  return {
    ...session,
    userMessages: [],
    assistantText: "",
    firstUserMessage: session.firstUserMessage.slice(0, 200),
    compactionSummaries: session.compactionSummaries.map((s) => s.slice(0, 300)),
    branchSummaries: session.branchSummaries.map((s) => s.slice(0, 200))
  };
}
var SessionIndex = class {
  constructor(embedder, indexDir, extraSessionDirs = [], extraArchiveDirs = [], sessionDir, archiveDir, fusion = "rrf") {
    this.embedder = embedder;
    this.indexDir = indexDir;
    this.extraSessionDirs = extraSessionDirs;
    this.extraArchiveDirs = extraArchiveDirs;
    this.sessionDir = sessionDir;
    this.archiveDir = archiveDir;
    this.fusion = fusion;
    mkdirSync2(indexDir, { recursive: true });
    this.indexPath = join3(indexDir, "session-index.json");
    this.fts = new FtsSide(indexDir);
  }
  embedder;
  indexDir;
  extraSessionDirs;
  extraArchiveDirs;
  sessionDir;
  archiveDir;
  fusion;
  data = { version: INDEX_VERSION, sessions: {} };
  indexPath;
  fts;
  /** Load existing index from disk. */
  async load() {
    if (!existsSync2(this.indexPath)) return;
    try {
      const raw = readFileSync2(this.indexPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.version === INDEX_VERSION) {
        this.data = parsed;
      } else if (parsed.version === 2) {
        for (const entry of Object.values(parsed.sessions)) {
          if (Array.isArray(entry.embedding)) {
            entry.embedding = encodeEmbedding(entry.embedding);
          }
          entry.session = stripHeavyFields(entry.session);
        }
        parsed.version = INDEX_VERSION;
        this.data = parsed;
        this.save();
      }
    } catch {
      this.data = { version: INDEX_VERSION, sessions: {} };
    }
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
  populateFtsFromIndex() {
    for (const [id, entry] of Object.entries(this.data.sessions)) {
      const s = entry.session;
      const parts = [];
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
  save() {
    const tmp = `${this.indexPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), "utf8");
    renameSync(tmp, this.indexPath);
  }
  /** Number of indexed sessions. */
  size() {
    return Object.keys(this.data.sessions).length;
  }
  /**
   * Sync: discover sessions, parse new/changed ones, handle moves, remove
   * sessions whose files no longer exist anywhere.
   */
  async sync(onProgress, onError) {
    await new Promise((r) => setImmediate(r));
    const __syncStartedAt = process.hrtime.bigint();
    try {
      const discovered = discoverSessionFiles(
        this.extraSessionDirs,
        this.extraArchiveDirs,
        this.sessionDir,
        this.archiveDir
      );
      let added = 0;
      let updated = 0;
      let removed = 0;
      let moved = 0;
      let reportedEmbeddingFailure = false;
      const pause = createYielder();
      const fileToId = /* @__PURE__ */ new Map();
      const idToFile = /* @__PURE__ */ new Map();
      const indexedFileToId = /* @__PURE__ */ new Map();
      for (const [id, entry] of Object.entries(this.data.sessions)) {
        indexedFileToId.set(entry.session.file, id);
      }
      for (const { file, archived } of discovered) {
        if (pause.due()) await pause.yield();
        let mtimeMs;
        let sizeBytes;
        try {
          const st = statSync3(file);
          mtimeMs = st.mtimeMs;
          sizeBytes = st.size;
        } catch {
          continue;
        }
        let sessionId = indexedFileToId.get(file) ?? null;
        if (!sessionId) {
          sessionId = readSessionId(file);
        }
        if (!sessionId) continue;
        fileToId.set(file, sessionId);
        const existing = idToFile.get(sessionId);
        if (!existing || mtimeMs > existing.mtimeMs) {
          idToFile.set(sessionId, { file, archived, mtimeMs, sizeBytes });
        }
      }
      const discoveredIds = new Set(idToFile.keys());
      for (const id of Object.keys(this.data.sessions)) {
        if (!discoveredIds.has(id)) {
          delete this.data.sessions[id];
          this.fts.delete(id);
          removed++;
        }
      }
      const toEmbed = [];
      for (const [id, disc] of idToFile.entries()) {
        const existing = this.data.sessions[id];
        if (existing) {
          const pathChanged = existing.session.file !== disc.file;
          const sizeChanged = (existing.sizeBytes ?? 0) !== disc.sizeBytes;
          if (pathChanged && !sizeChanged) {
            existing.session.file = disc.file;
            existing.session.archived = disc.archived;
            existing.mtimeMs = disc.mtimeMs;
            existing.sizeBytes = disc.sizeBytes;
            existing.summary = buildSummary(existing.session);
            moved++;
          } else if (sizeChanged) {
            toEmbed.push({ id, ...disc });
          }
        } else {
          toEmbed.push({ id, ...disc });
        }
      }
      if (toEmbed.length === 0) {
        if (moved > 0 || removed > 0) this.save();
        return { added, updated, removed, moved };
      }
      onProgress?.(`Indexing ${toEmbed.length} sessions...`);
      const BATCH_SIZE = 20;
      for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
        const batch = toEmbed.slice(i, i + BATCH_SIZE);
        const parsed = [];
        for (const item of batch) {
          if (pause.due()) await pause.yield();
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
            if (!embedding) continue;
            const isUpdate = !!this.data.sessions[item.id];
            this.data.sessions[item.id] = {
              session: stripHeavyFields(session),
              summary: buildSummary(session),
              embedding: encodeEmbedding(embedding),
              mtimeMs: item.mtimeMs,
              sizeBytes: item.sizeBytes
            };
            this.fts.upsert(item.id, session.name ?? "", buildContent(session));
            if (isUpdate) updated++;
            else added++;
          }
        } catch (err) {
          const msg = `Embedding batch failed: ${err.message}`;
          if (!reportedEmbeddingFailure) {
            onError?.(msg);
            reportedEmbeddingFailure = true;
          }
          onProgress?.(msg);
        }
        onProgress?.(
          `Indexed ${Math.min(i + BATCH_SIZE, toEmbed.length)}/${toEmbed.length}...`
        );
      }
      this.save();
      return { added, updated, removed, moved };
    } finally {
      const __syncElapsedMs = Number(process.hrtime.bigint() - __syncStartedAt) / 1e6;
      if (__syncElapsedMs > 2e3) {
        onProgress?.(
          `sync took ${__syncElapsedMs.toFixed(0)}ms \u2014 investigate`
        );
      }
    }
  }
  /** Full rebuild — clear and re-index everything. */
  async rebuild(onProgress, onError) {
    this.data = { version: INDEX_VERSION, sessions: {} };
    this.fts.clear();
    await this.sync(onProgress, onError);
  }
  /**
   * Hybrid search: cosine embeddings + FTS5 BM25, fused via Reciprocal Rank
   * Fusion (k=60). Falls back to pure semantic if FTS side-car is empty.
   *
   * Optional `project` filter matches the same way as `list()`: case-insensitive
   * substring match against projectSlug or cwd.
   */
  async search(query, limit = 10, signal, project) {
    let entries = Object.values(this.data.sessions);
    if (entries.length === 0) return [];
    let allowedIds;
    if (project) {
      const slug = project.toLowerCase();
      entries = entries.filter(
        (e) => e.session.projectSlug.toLowerCase().includes(slug) || e.session.cwd.toLowerCase().includes(slug)
      );
      if (entries.length === 0) return [];
      allowedIds = new Set(entries.map((e) => e.session.id));
    }
    const queryEmbedding = await this.embedder.embed(query);
    if (signal?.aborted) return [];
    const cosineScored = entries.map((entry) => ({
      entry,
      score: cosineSimilarity(queryEmbedding, decodeEmbedding(entry.embedding))
    })).sort((a, b) => b.score - a.score);
    const poolSize = Math.max(limit * 5, 100);
    const cosineRanks = /* @__PURE__ */ new Map();
    cosineScored.slice(0, poolSize).forEach((s, i) => {
      cosineRanks.set(s.entry.session.id, i + 1);
    });
    const ftsRanks = this.fts.searchRanks(query, poolSize, allowedIds);
    let sorted;
    if (this.fusion === "vector-primary") {
      const ids = cosineScored.slice(0, limit).map((s) => s.entry.session.id);
      const ftsAppendLimit = 5;
      let appended = 0;
      for (const [id] of ftsRanks) {
        if (appended >= ftsAppendLimit) break;
        if (!ids.includes(id)) {
          ids.push(id);
          appended++;
        }
      }
      sorted = ids.slice(0, limit).map((id, rank) => [id, 1 / (60 + rank + 1)]);
    } else {
      const K = 60;
      const fused = /* @__PURE__ */ new Map();
      for (const [id, r] of cosineRanks) fused.set(id, (fused.get(id) ?? 0) + 1 / (K + r));
      for (const [id, r] of ftsRanks) fused.set(id, (fused.get(id) ?? 0) + 1 / (K + r));
      sorted = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    }
    return sorted.map(([id, score]) => {
      const entry = this.data.sessions[id];
      if (!entry) return null;
      return { session: entry.session, summary: entry.summary, score };
    }).filter((r) => r !== null);
  }
  /**
   * List sessions with optional filters.
   */
  list(filters) {
    let sessions = Object.values(this.data.sessions).map((e) => e.session);
    if (filters?.project) {
      const slug = filters.project.toLowerCase();
      sessions = sessions.filter(
        (s) => s.projectSlug.toLowerCase().includes(slug) || s.cwd.toLowerCase().includes(slug)
      );
    }
    if (filters?.after) {
      sessions = sessions.filter((s) => s.startedAt >= filters.after);
    }
    if (filters?.before) {
      sessions = sessions.filter((s) => s.startedAt <= filters.before);
    }
    if (filters?.archived !== void 0) {
      sessions = sessions.filter((s) => s.archived === filters.archived);
    }
    sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    if (filters?.limit) {
      sessions = sessions.slice(0, filters.limit);
    }
    return sessions;
  }
  /**
   * Get a specific session by file path or session ID.
   */
  get(fileOrId) {
    if (this.data.sessions[fileOrId]) {
      return this.data.sessions[fileOrId];
    }
    return Object.values(this.data.sessions).find(
      (e) => e.session.file === fileOrId
    );
  }
  /** Get all indexed session objects. */
  getAll() {
    return Object.values(this.data.sessions);
  }
  close() {
    this.fts.close();
  }
};
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
function buildEmbeddingText(s) {
  const parts = [];
  if (s.name) parts.push(s.name);
  const userText = s.userMessages.join("\n").slice(0, 6e3);
  parts.push(userText);
  if (s.assistantText) {
    const assistantBudget = 3e3;
    const truncatedAssistant = s.assistantText.slice(0, assistantBudget);
    parts.push(`Assistant:
${truncatedAssistant}`);
  }
  if (s.compactionSummaries.length > 0) {
    parts.push(s.compactionSummaries.join("\n").slice(0, 4e3));
  }
  if (s.branchSummaries.length > 0) {
    parts.push(s.branchSummaries.join("\n").slice(0, 2e3));
  }
  parts.push(`Project: ${slugToProject(s.projectSlug)}`);
  parts.push(`CWD: ${s.cwd}`);
  if (s.filesModified.length > 0) {
    parts.push(`Files modified: ${s.filesModified.join(", ")}`);
  }
  return parts.join("\n\n").slice(0, 16e3);
}

// src/index-service.ts
function createIndexService(options) {
  let index = null;
  let inflightSync = null;
  let writerTail = Promise.resolve();
  const open = () => {
    if (!index) throw new Error("session index is not loaded");
    return index;
  };
  const exclusive = (fn) => {
    const run = writerTail.then(fn);
    writerTail = run.catch(() => {
    });
    return run;
  };
  return {
    async load() {
      index ??= options.embedder ? new SessionIndex(
        createEmbedder(options.embedder),
        options.indexDir,
        options.extraSessionDirs,
        options.extraArchiveDirs,
        options.sessionDir,
        options.archiveDir,
        options.fusion
      ) : new FtsSessionIndex(
        options.indexDir,
        options.extraSessionDirs,
        options.extraArchiveDirs,
        options.sessionDir,
        options.archiveDir
      );
      await index.load();
      return index.size();
    },
    sync(callbacks) {
      inflightSync ??= exclusive(
        () => open().sync(callbacks?.onProgress, callbacks?.onError)
      ).finally(() => {
        inflightSync = null;
      });
      return inflightSync;
    },
    rebuild(callbacks) {
      return exclusive(() => open().rebuild(callbacks?.onProgress, callbacks?.onError));
    },
    // Results drop the raw message text: the tools never show it, and it is
    // the bulk of what would otherwise be cloned across the thread boundary.
    async search(query, limit, project) {
      const results = await open().search(query, limit, void 0, project);
      return results.map((r) => ({ ...r, session: stripHeavyFields(r.session) }));
    },
    async list(filters) {
      return open().list(filters).map(stripHeavyFields);
    },
    async get(fileOrId) {
      const entry = open().get(fileOrId);
      return entry && { session: stripHeavyFields(entry.session), summary: entry.summary };
    },
    async size() {
      return index?.size() ?? 0;
    },
    async close() {
      index?.close();
      index = null;
    }
  };
}
async function handleWorkerRequest(service2, req, post) {
  const callbacks = {
    onProgress: (msg) => post({ id: req.id, type: "progress", msg }),
    onError: (msg) => post({ id: req.id, type: "notice", msg })
  };
  const [a, b, c] = req.args;
  try {
    const value = await {
      load: () => service2.load(),
      sync: () => service2.sync(callbacks),
      rebuild: () => service2.rebuild(callbacks),
      search: () => service2.search(a, b, c),
      list: () => service2.list(a),
      get: () => service2.get(a),
      size: () => service2.size(),
      close: () => service2.close()
    }[req.op]();
    post({ id: req.id, type: "result", value });
  } catch (err) {
    post({ id: req.id, type: "failure", message: err?.message ?? String(err) });
  }
}

// src/index-worker.ts
var port = parentPort;
if (!port) throw new Error("index-worker must run as a worker thread");
var service = createIndexService(workerData);
port.on("message", (req) => {
  void handleWorkerRequest(service, req, (reply) => port.postMessage(reply));
});
//# sourceMappingURL=index-worker.js.map
