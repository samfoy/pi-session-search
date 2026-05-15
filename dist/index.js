// src/index.ts
import { Type } from "@sinclair/typebox";

// src/config.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
var DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1e3;
var DEFAULT_INITIAL_DELAY_MS = 0;
function globalConfigDir() {
  return join(homedir(), ".pi", "session-search");
}
function globalConfigFile() {
  return join(globalConfigDir(), "config.json");
}
function globalIndexDir() {
  return join(globalConfigDir(), "index");
}
function warnUnknownKeys(block, blockName, knownKeys) {
  if (!block || typeof block !== "object") return;
  const unknown = Object.keys(block).filter((k) => !knownKeys.includes(k));
  if (unknown.length === 0) return;
  console.error(
    `pi-session-search: ignoring unknown key(s) in settings.json "${blockName}" block: ${unknown.join(", ")} (expected: ${knownKeys.join(", ")})`
  );
}
var PI_SESSION_SEARCH_SETTINGS_KEYS = ["localPath"];
var PI_TOTAL_RECALL_KNOWN_KEYS = ["localPath"];
function resolveLocalBase(cwd) {
  if (!cwd) return null;
  try {
    const raw = readFileSync(join(cwd, ".pi", "settings.json"), "utf-8");
    const settings = JSON.parse(raw) ?? {};
    const ss = settings["pi-session-search"];
    warnUnknownKeys(ss, "pi-session-search", PI_SESSION_SEARCH_SETTINGS_KEYS);
    if (ss && typeof ss === "object" && typeof ss.localPath === "string" && ss.localPath) {
      return ss.localPath;
    }
    const tr = settings["pi-total-recall"];
    warnUnknownKeys(tr, "pi-total-recall", PI_TOTAL_RECALL_KNOWN_KEYS);
    if (tr && typeof tr === "object" && typeof tr.localPath === "string" && tr.localPath) {
      return join(tr.localPath, "session-search");
    }
  } catch {
  }
  return null;
}
function getConfigPath(cwd) {
  const base = resolveLocalBase(cwd);
  if (base) return join(base, "config.json");
  return globalConfigFile();
}
function getIndexDir(cwd) {
  const base = resolveLocalBase(cwd);
  if (base) return join(base, "index");
  return globalIndexDir();
}
function loadConfig(cwd) {
  const configFile = getConfigPath(cwd);
  if (!existsSync(configFile)) return null;
  const raw = readFileSync(configFile, "utf8");
  let file;
  try {
    file = JSON.parse(raw);
  } catch {
    return null;
  }
  const rawInterval = file.sync?.interval;
  const rawInitialDelay = file.sync?.initialDelay;
  const rawDisableForChild = file.sync?.disableForChild;
  let syncCfg;
  const syncFields = {};
  if (typeof rawInterval === "number") syncFields.interval = rawInterval;
  if (typeof rawInitialDelay === "number") syncFields.initialDelay = rawInitialDelay;
  if (typeof rawDisableForChild === "boolean") syncFields.disableForChild = rawDisableForChild;
  if (Object.keys(syncFields).length > 0) syncCfg = syncFields;
  return {
    extraSessionDirs: file.extraSessionDirs ?? [],
    extraArchiveDirs: file.extraArchiveDirs ?? [],
    sync: syncCfg,
    embedder: file.embedder
  };
}
function saveConfig(file, cwd) {
  const configFile = getConfigPath(cwd);
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify(file, null, 2), "utf8");
}

// src/embedder.ts
var DEFAULTS = {
  openai: { model: "text-embedding-3-small", dimensions: 512, baseUrl: "https://api.openai.com" },
  bedrock: {
    model: "amazon.titan-embed-text-v2:0",
    region: "us-east-1",
    profile: "default",
    dimensions: 512
  },
  ollama: { model: "nomic-embed-text", url: "http://localhost:11434" },
  mistral: { model: "mistral-embed", dimensions: 1024, baseUrl: "https://api.mistral.ai" },
  "openai-compatible": { model: "text-embedding-3-small", dimensions: 512 }
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
        merged.baseUrl || "https://api.openai.com"
      );
    case "mistral":
      return new OpenAICompatibleEmbedder(
        merged.apiKey || process.env.MISTRAL_API_KEY || "",
        merged.model,
        merged.dimensions,
        merged.baseUrl || "https://api.mistral.ai"
      );
    case "openai-compatible": {
      if (!merged.baseUrl) throw new Error("openai-compatible requires baseUrl");
      return new OpenAICompatibleEmbedder(
        merged.apiKey || "",
        merged.model,
        merged.dimensions,
        merged.baseUrl
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
  constructor(apiKey, model, dimensions, baseUrl) {
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
    this.endpoint = `${baseUrl.replace(/\/$/, "")}/v1/embeddings`;
  }
  apiKey;
  model;
  dimensions;
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
      if (this.dimensions && !this.endpoint.includes("mistral.ai")) {
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
      for (const item of json.data) {
        results[i + item.index] = item.embedding;
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

// src/session-index.ts
import { readFileSync as readFileSync3, writeFileSync as writeFileSync2, existsSync as existsSync3, mkdirSync as mkdirSync3, statSync as statSync3 } from "node:fs";
import { join as join4 } from "node:path";
import { DatabaseSync as DatabaseSync3 } from "node:sqlite";

// src/parser.ts
import { readFileSync as readFileSync2, readdirSync, existsSync as existsSync2, openSync, readSync, closeSync } from "node:fs";
import { join as join2, basename, dirname as dirname2 } from "node:path";
var DEFAULT_SESSION_DIR = join2(
  process.env.HOME || "~",
  ".pi",
  "agent",
  "sessions"
);
var DEFAULT_ARCHIVE_DIR = join2(
  process.env.HOME || "~",
  ".pi",
  "agent",
  "sessions-archive"
);
function discoverSessionFiles(extraSessionDirs = [], extraArchiveDirs = []) {
  const sDirs = [DEFAULT_SESSION_DIR, ...extraSessionDirs];
  const aDirs = [DEFAULT_ARCHIVE_DIR, ...extraArchiveDirs];
  const results = [];
  for (const dir of sDirs) {
    if (!existsSync2(dir)) continue;
    for (const entry of walkJsonl(dir)) {
      results.push({ file: entry, archived: false });
    }
  }
  for (const dir of aDirs) {
    if (!existsSync2(dir)) continue;
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
      const full = join2(dir, entry.name);
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
    raw = readFileSync2(file, "utf8");
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
  const parentDir = basename(dirname2(file));
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

// src/fts-index.ts
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
import { mkdirSync as mkdirSync2, statSync as statSync2 } from "node:fs";
import { join as join3 } from "node:path";

// src/utils.ts
import { homedir as homedir2 } from "node:os";
function truncate2(s, max) {
  return s.length <= max ? s : s.slice(0, max) + "\u2026";
}
function slugToProject(slug) {
  if (!slug.startsWith("--") || !slug.endsWith("--")) return slug;
  return slug.slice(2, -2).replace(/-/g, "/");
}
function formatRelativeDate(iso) {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = now - then;
  if (diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / 6e4);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "1d ago";
  if (days < 7) return `${days}d ago`;
  if (days < 14) return "last week";
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  return months <= 1 ? "last month" : `${months}mo ago`;
}
function pathToSlug(cwd) {
  const home = homedir2();
  const rel = cwd.startsWith(home) ? cwd.slice(home.length + 1) : cwd;
  return rel.replace(/\//g, "-");
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
  return `SQLite FTS5 is not available in this Node runtime. pi-session-search requires Node 24+ (where node:sqlite ships with FTS5 compiled in). Current: Node ${process.versions.node}. Upgrade Node and restart pi.`;
}

// src/fts-index.ts
var FtsSessionIndex = class {
  db;
  dbPath;
  indexDir;
  extraSessionDirs;
  extraArchiveDirs;
  constructor(indexDir, extraSessionDirs = [], extraArchiveDirs = []) {
    this.indexDir = indexDir;
    this.extraSessionDirs = extraSessionDirs;
    this.extraArchiveDirs = extraArchiveDirs;
    mkdirSync2(indexDir, { recursive: true });
    this.dbPath = join3(indexDir, "sessions-fts.db");
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
  async sync(onProgress) {
    const discovered = discoverSessionFiles(this.extraSessionDirs, this.extraArchiveDirs);
    let added = 0, updated = 0, removed = 0, moved = 0;
    const idToFile = /* @__PURE__ */ new Map();
    for (const { file, archived } of discovered) {
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
  async rebuild(onProgress) {
    this.db.exec("DELETE FROM sessions");
    await this.sync(onProgress);
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
var FtsSide = class {
  db;
  constructor(indexDir) {
    assertFts5Available();
    this.db = new DatabaseSync3(join4(indexDir, "hybrid-fts.db"));
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
  constructor(embedder, indexDir, extraSessionDirs = [], extraArchiveDirs = []) {
    this.embedder = embedder;
    this.indexDir = indexDir;
    this.extraSessionDirs = extraSessionDirs;
    this.extraArchiveDirs = extraArchiveDirs;
    mkdirSync3(indexDir, { recursive: true });
    this.indexPath = join4(indexDir, "session-index.json");
    this.fts = new FtsSide(indexDir);
  }
  embedder;
  indexDir;
  extraSessionDirs;
  extraArchiveDirs;
  data = { version: INDEX_VERSION, sessions: {} };
  indexPath;
  fts;
  /** Load existing index from disk. */
  async load() {
    if (!existsSync3(this.indexPath)) return;
    try {
      const raw = readFileSync3(this.indexPath, "utf8");
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
    writeFileSync2(this.indexPath, JSON.stringify(this.data), "utf8");
  }
  /** Number of indexed sessions. */
  size() {
    return Object.keys(this.data.sessions).length;
  }
  /**
   * Sync: discover sessions, parse new/changed ones, handle moves, remove
   * sessions whose files no longer exist anywhere.
   */
  async sync(onProgress) {
    await new Promise((r) => setImmediate(r));
    const __syncStartedAt = process.hrtime.bigint();
    try {
      const discovered = discoverSessionFiles(
        this.extraSessionDirs,
        this.extraArchiveDirs
      );
      let added = 0;
      let updated = 0;
      let removed = 0;
      let moved = 0;
      const fileToId = /* @__PURE__ */ new Map();
      const idToFile = /* @__PURE__ */ new Map();
      const indexedFileToId = /* @__PURE__ */ new Map();
      for (const [id, entry] of Object.entries(this.data.sessions)) {
        indexedFileToId.set(entry.session.file, id);
      }
      for (const { file, archived } of discovered) {
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
          onProgress?.(`Embedding batch failed: ${err.message}`);
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
  async rebuild(onProgress) {
    this.data = { version: INDEX_VERSION, sessions: {} };
    this.fts.clear();
    await this.sync(onProgress);
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
    const K = 60;
    const fused = /* @__PURE__ */ new Map();
    for (const [id, r] of cosineRanks) fused.set(id, (fused.get(id) ?? 0) + 1 / (K + r));
    for (const [id, r] of ftsRanks) fused.set(id, (fused.get(id) ?? 0) + 1 / (K + r));
    const sorted = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
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

// src/reader.ts
import { readFileSync as readFileSync4 } from "node:fs";
function readSessionConversation(file, options) {
  const offset = options?.offset ?? 0;
  const limit = options?.limit ?? 50;
  const includeTools = options?.includeTools ?? false;
  let raw;
  try {
    raw = readFileSync4(file, "utf8");
  } catch (err) {
    return `Error reading session: ${err.message}`;
  }
  const lines = raw.trim().split("\n");
  const entries = [];
  let header = null;
  for (const line of lines) {
    const cleaned = line.replace(/^\uFEFF/, "").trim();
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
  const conversationEntries = entries.filter((e) => {
    if (e.type === "message") {
      const role = e.message?.role;
      if (role === "user") return true;
      if (role === "assistant") return true;
      if (role === "toolResult" && includeTools) return true;
      return false;
    }
    if (e.type === "compaction") return true;
    if (e.type === "branch_summary") return true;
    if (e.type === "session_info") return true;
    if (e.type === "model_change") return true;
    return false;
  });
  const total = conversationEntries.length;
  const page = conversationEntries.slice(offset, offset + limit);
  const output = [];
  if (header) {
    output.push(
      `Session: ${header.id}
Started: ${header.timestamp}
CWD: ${header.cwd}`
    );
    output.push(`Total entries: ${total} (showing ${offset + 1}-${Math.min(offset + limit, total)})`);
    output.push("---");
  }
  for (const entry of page) {
    const ts = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : "";
    switch (entry.type) {
      case "message": {
        const msg = entry.message;
        if (msg.role === "user") {
          const text = extractText(msg.content);
          output.push(`
**User** (${ts}):
${text}`);
        } else if (msg.role === "assistant") {
          const text = extractAssistantText(msg.content);
          const model = msg.model ? ` [${msg.provider}/${msg.model}]` : "";
          output.push(`
**Assistant**${model} (${ts}):
${text}`);
          if (Array.isArray(msg.content)) {
            const calls = msg.content.filter(
              (b) => b.type === "toolCall"
            );
            if (calls.length > 0) {
              const callList = calls.map(
                (c) => `  \u2192 ${c.name}(${summarizeArgs(c.arguments)})`
              ).join("\n");
              output.push(callList);
            }
          }
        } else if (msg.role === "toolResult" && includeTools) {
          const text = extractText(msg.content);
          const truncated = text.length > 500 ? text.slice(0, 500) + "\u2026" : text;
          const err = msg.isError ? " \u274C" : "";
          output.push(
            `
  **${msg.toolName}** result${err} (${ts}):
  ${truncated}`
          );
        }
        break;
      }
      case "compaction":
        output.push(
          `
--- Compaction (${ts}) ---
${entry.summary?.slice(0, 1e3) ?? "(no summary)"}`
        );
        break;
      case "branch_summary":
        output.push(
          `
--- Branch Summary (${ts}) ---
${entry.summary?.slice(0, 500) ?? "(no summary)"}`
        );
        break;
      case "model_change":
        output.push(
          `
*Model changed to ${entry.provider}/${entry.modelId}* (${ts})`
        );
        break;
      case "session_info":
        output.push(`
*Session renamed to: ${entry.name}* (${ts})`);
        break;
    }
  }
  if (offset + limit < total) {
    output.push(
      `
--- ${total - offset - limit} more entries. Use offset=${offset + limit} to continue. ---`
    );
  }
  return output.join("\n");
}
function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }
  return "";
}
function extractAssistantText(content) {
  if (!Array.isArray(content)) return String(content ?? "");
  return content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}
function summarizeArgs(args) {
  if (!args) return "";
  const parts = [];
  for (const [key, val] of Object.entries(args)) {
    if (typeof val === "string") {
      parts.push(`${key}="${val.length > 60 ? val.slice(0, 60) + "\u2026" : val}"`);
    } else {
      parts.push(`${key}=${JSON.stringify(val)?.slice(0, 40)}`);
    }
  }
  return parts.join(", ");
}

// src/index.ts
import { resolve } from "node:path";
function resolveSyncAction(rawInterval) {
  if (rawInterval === void 0)
    return { disabled: false, intervalMs: DEFAULT_SYNC_INTERVAL_MS };
  if (rawInterval === -1) return { disabled: true };
  if (rawInterval <= 0) {
    return { disabled: false, intervalMs: DEFAULT_SYNC_INTERVAL_MS, fallback: true };
  }
  return { disabled: false, intervalMs: rawInterval };
}
function resolveInitialSyncAction(rawDelay) {
  if (rawDelay === void 0)
    return { skip: false, delayMs: DEFAULT_INITIAL_DELAY_MS };
  if (rawDelay === -1) return { skip: true };
  if (rawDelay < 0) {
    return { skip: false, delayMs: DEFAULT_INITIAL_DELAY_MS, fallback: true };
  }
  return { skip: false, delayMs: rawDelay };
}
function isChildProcess() {
  const depth = Number(process.env.PI_SUBAGENT_DEPTH);
  if (depth > 0) return true;
  if (!process.stdin.isTTY) return true;
  return false;
}
function index_default(pi) {
  let sessionIndex = null;
  let currentConfig = null;
  let syncTimer = null;
  let sessionCwd;
  const pendingTimers = /* @__PURE__ */ new Set();
  let shuttingDown = false;
  function scheduleTimer(fn, ms) {
    const handle = setTimeout(() => {
      pendingTimers.delete(handle);
      if (shuttingDown) return;
      try {
        fn();
      } catch {
      }
    }, ms);
    pendingTimers.add(handle);
    return handle;
  }
  let effectiveSyncIntervalMs = DEFAULT_SYNC_INTERVAL_MS;
  function injectPrimer(ctx) {
    if (!sessionIndex || sessionIndex.size() === 0) return;
    try {
      const alreadyInjected = ctx.sessionManager.getEntries().some(
        (e) => e.type === "custom_message" && e.customType === "pi-session-search-primer"
      );
      if (alreadyInjected) return;
      const cwd = sessionCwd || "";
      const projectSlug = cwd ? pathToSlug(cwd) : void 0;
      let sessions = sessionIndex.list({ project: projectSlug, limit: 5 });
      if (sessions.length === 0 && projectSlug) {
        sessions = sessionIndex.list({ limit: 5 });
      }
      if (sessions.length === 0) return;
      const lines = sessions.map((s) => {
        const name = s.name || truncate2(s.firstUserMessage, 80);
        const date = s.startedAt.split("T")[0];
        const rel = formatRelativeDate(s.startedAt);
        const displayCwd = s.cwd.replace(process.env.HOME || "", "~").slice(0, 60);
        const msgs = `${s.userMessageCount} user, ${s.assistantMessageCount} assistant`;
        const mode = s.models[0] ? ` Mode: ${s.models[0].split("/").pop()}` : "";
        return `- **${rel}**: **${name}** (${date}) Project: ${s.projectSlug} | CWD: ${displayCwd} Messages: ${msgs}${mode}`;
      });
      const primer = `## Recent Sessions (this project)
${lines.join("\n")}
`;
      const trimmed = primer.length > 1500 ? primer.slice(0, 1500) + "\n" : primer;
      pi.sendMessage({
        customType: "pi-session-search-primer",
        content: trimmed,
        display: false,
        details: { sessionCount: sessions.length }
      });
    } catch {
    }
  }
  pi.on("session_start", async (_event, ctx) => {
    sessionCwd = ctx.cwd;
    try {
      currentConfig = loadConfig(sessionCwd);
    } catch (err) {
      ctx.ui.notify(`session-search: ${err.message}`, "warning");
    }
    let syncAction = resolveSyncAction(currentConfig?.sync?.interval);
    effectiveSyncIntervalMs = syncAction.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    let initialAction = resolveInitialSyncAction(currentConfig?.sync?.initialDelay);
    if (currentConfig?.sync?.disableForChild && isChildProcess()) {
      syncAction = { disabled: true };
      initialAction = { skip: true };
      ctx.ui.notify("session-search: sync auto-disabled (child process detected)", "info");
    }
    void startIndex(currentConfig, ctx, syncAction, initialAction);
  });
  async function startIndex(config, ctx, syncAction, initialAction) {
    try {
      if (config?.embedder) {
        const embedder = createEmbedder(config.embedder);
        sessionIndex = new SessionIndex(
          embedder,
          getIndexDir(sessionCwd),
          config.extraSessionDirs,
          config.extraArchiveDirs
        );
      } else {
        sessionIndex = new FtsSessionIndex(
          getIndexDir(sessionCwd),
          config?.extraSessionDirs ?? [],
          config?.extraArchiveDirs ?? []
        );
      }
      await sessionIndex.load();
      injectPrimer(ctx);
      const initAction = initialAction ?? resolveInitialSyncAction(DEFAULT_INITIAL_DELAY_MS);
      if (initAction.skip) {
        ctx.ui.notify(
          "session-search: initial sync skipped (set sync.initialDelay >= 0 to enable)",
          "info"
        );
      } else if (initAction.fallback) {
        ctx.ui.notify(
          "session-search: invalid sync.initialDelay, falling back to immediate",
          "warning"
        );
      }
      if (!initAction.skip) {
        const SYNC_TIMEOUT_MS = 6e5;
        const delayMs = initAction.delayMs ?? DEFAULT_INITIAL_DELAY_MS;
        const runSync = () => Promise.race([
          sessionIndex.sync((msg) => ctx.ui.setStatus("session-search", msg)),
          new Promise(
            (resolve2) => scheduleTimer(() => resolve2(null), SYNC_TIMEOUT_MS)
          )
        ]);
        const handleSyncResult = (syncResult) => {
          if (shuttingDown) return;
          if (syncResult === null) {
            ctx.ui.notify("session-search: sync timed out (index may be stale)", "warning");
            ctx.ui.setStatus("session-search", "");
          } else {
            const { added, updated, removed, moved } = syncResult;
            const changes = added + updated + removed + moved;
            if (changes > 0) {
              const parts = [];
              if (added) parts.push(`+${added}`);
              if (updated) parts.push(`~${updated}`);
              if (removed) parts.push(`-${removed}`);
              if (moved) parts.push(`\u2197${moved} moved`);
              ctx.ui.setStatus(
                "session-search",
                `Sessions: ${parts.join(" ")} (${sessionIndex?.size() ?? 0} total)`
              );
              scheduleTimer(() => ctx.ui.setStatus("session-search", ""), 5e3);
            }
          }
        };
        if (delayMs > 0) {
          scheduleTimer(async () => {
            try {
              handleSyncResult(await runSync());
            } catch (err) {
              if (shuttingDown) return;
              ctx.ui.notify(`session-search: initial sync failed: ${err.message}`, "warning");
              ctx.ui.setStatus("session-search", "");
            }
          }, delayMs);
        } else {
          setImmediate(() => {
            runSync().then(handleSyncResult).catch((err) => {
              if (shuttingDown) return;
              ctx.ui.notify(`session-search: initial sync failed: ${err.message}`, "warning");
              ctx.ui.setStatus("session-search", "");
            });
          });
        }
      }
      const action = syncAction ?? resolveSyncAction(effectiveSyncIntervalMs);
      if (action.disabled) {
        ctx.ui.notify("session-search: auto-sync disabled (set sync.interval > 0 to re-enable)", "info");
      } else if (action.fallback) {
        ctx.ui.notify(
          `session-search: invalid sync.interval, falling back to ${DEFAULT_SYNC_INTERVAL_MS / 1e3}s`,
          "warning"
        );
        effectiveSyncIntervalMs = DEFAULT_SYNC_INTERVAL_MS;
      }
      if (!action.disabled && effectiveSyncIntervalMs > 0) {
        syncTimer = setInterval(async () => {
          if (!sessionIndex || shuttingDown) return;
          try {
            const result = await sessionIndex.sync();
            if (shuttingDown) return;
            const changes = result.added + result.updated + result.removed + result.moved;
            if (changes > 0) {
              const parts = [];
              if (result.added) parts.push(`+${result.added}`);
              if (result.updated) parts.push(`~${result.updated}`);
              if (result.removed) parts.push(`-${result.removed}`);
              if (result.moved) parts.push(`\u2197${result.moved} moved`);
              ctx.ui.setStatus(
                "session-search",
                `Sessions synced: ${parts.join(" ")} (${sessionIndex.size()} total)`
              );
              scheduleTimer(() => ctx.ui.setStatus("session-search", ""), 5e3);
            }
          } catch {
          }
        }, effectiveSyncIntervalMs);
      }
    } catch (err) {
      sessionIndex = null;
      ctx.ui.notify(`session-search init failed: ${err.message}`, "error");
    }
  }
  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
    for (const handle of pendingTimers) {
      clearTimeout(handle);
    }
    pendingTimers.clear();
    if (sessionIndex && "close" in sessionIndex) {
      sessionIndex.close();
    }
  });
  pi.registerCommand("session-embeddings-setup", {
    description: "Enable semantic embeddings for hybrid search (FTS5 is always on)",
    handler: async (_args, ctx) => {
      const providerChoice = await ctx.ui.select("Embedding provider:", [
        "openai \u2014 OpenAI API (text-embedding-3-small)",
        "mistral \u2014 Mistral API (mistral-embed)",
        "bedrock \u2014 AWS Bedrock (Titan Embeddings v2)",
        "ollama \u2014 Local Ollama (nomic-embed-text)",
        "openai-compatible \u2014 Any OpenAI-compatible API"
      ]);
      if (!providerChoice) {
        ctx.ui.notify("Setup cancelled.", "info");
        return;
      }
      const providerType = providerChoice.split(" ")[0];
      let embedder;
      switch (providerType) {
        case "openai": {
          const apiKey = await ctx.ui.input(
            "OpenAI API key (or env var name):",
            process.env.OPENAI_API_KEY ? "(using OPENAI_API_KEY from env)" : ""
          );
          const model = await ctx.ui.input(
            "Model:",
            "text-embedding-3-small"
          );
          embedder = {
            type: "openai",
            apiKey: apiKey?.startsWith("(") ? void 0 : apiKey || void 0,
            model: model || "text-embedding-3-small",
            dimensions: 512
          };
          break;
        }
        case "mistral": {
          const apiKey = await ctx.ui.input(
            "Mistral API key:",
            process.env.MISTRAL_API_KEY ? "(using MISTRAL_API_KEY from env)" : ""
          );
          const model = await ctx.ui.input(
            "Model:",
            "mistral-embed"
          );
          embedder = {
            type: "mistral",
            apiKey: apiKey?.startsWith("(") ? void 0 : apiKey || void 0,
            model: model || "mistral-embed",
            dimensions: 1024
          };
          break;
        }
        case "bedrock": {
          const profile = await ctx.ui.input("AWS profile:", "default");
          const region = await ctx.ui.input("AWS region:", "us-east-1");
          const model = await ctx.ui.input(
            "Model:",
            "amazon.titan-embed-text-v2:0"
          );
          embedder = {
            type: "bedrock",
            profile: profile || "default",
            region: region || "us-east-1",
            model: model || "amazon.titan-embed-text-v2:0",
            dimensions: 512
          };
          break;
        }
        case "ollama": {
          const url = await ctx.ui.input(
            "Ollama URL:",
            "http://localhost:11434"
          );
          const model = await ctx.ui.input("Model:", "nomic-embed-text");
          embedder = {
            type: "ollama",
            url: url || "http://localhost:11434",
            model: model || "nomic-embed-text"
          };
          break;
        }
        case "openai-compatible": {
          const baseUrl = await ctx.ui.input(
            "Base URL (e.g. https://api.together.xyz):",
            ""
          );
          if (!baseUrl) {
            ctx.ui.notify("Base URL is required for openai-compatible.", "warning");
            return;
          }
          const apiKey = await ctx.ui.input("API key:", "");
          const model = await ctx.ui.input("Model:", "");
          const dims = await ctx.ui.input("Dimensions (e.g. 512, 1024):", "512");
          embedder = {
            type: "openai-compatible",
            baseUrl: baseUrl.replace(/\/$/, ""),
            apiKey: apiKey || void 0,
            model: model || void 0,
            dimensions: parseInt(dims || "512", 10)
          };
          break;
        }
      }
      const extraDirs = await ctx.ui.input(
        "Extra session directories (comma-separated, optional):",
        ""
      );
      const extraArchive = await ctx.ui.input(
        "Extra archive directories (comma-separated, optional):",
        ""
      );
      saveConfig({
        embedder,
        extraSessionDirs: extraDirs ? extraDirs.split(",").map((d) => d.trim()).filter(Boolean) : void 0,
        extraArchiveDirs: extraArchive ? extraArchive.split(",").map((d) => d.trim()).filter(Boolean) : void 0
      }, sessionCwd);
      ctx.ui.notify(
        `Config saved to ${getConfigPath(sessionCwd)}. Run /reload to activate.`,
        "success"
      );
    }
  });
  pi.registerCommand("session-sync", {
    description: "Force an immediate incremental re-sync of session index",
    handler: async (_args, ctx) => {
      if (!sessionIndex) {
        ctx.ui.notify("Session index not ready yet.", "warning");
        return;
      }
      try {
        const r = await sessionIndex.sync((msg) => ctx.ui.setStatus("session-search", msg));
        const parts = [];
        if (r.added) parts.push(`+${r.added}`);
        if (r.updated) parts.push(`~${r.updated}`);
        if (r.removed) parts.push(`-${r.removed}`);
        if (r.moved) parts.push(`\u2197${r.moved}`);
        ctx.ui.notify(
          `Synced: ${parts.join(" ") || "no changes"} (${sessionIndex.size()} total)`,
          "success"
        );
        ctx.ui.setStatus("session-search", "");
      } catch (err) {
        ctx.ui.notify(`Sync failed: ${err.message}`, "error");
      }
    }
  });
  pi.registerCommand("session-reindex", {
    description: "Force full re-index of all session files",
    handler: async (_args, ctx) => {
      if (!sessionIndex) {
        ctx.ui.notify(
          "Session index not ready yet.",
          "warning"
        );
        return;
      }
      ctx.ui.notify("Re-indexing sessions...", "info");
      try {
        await sessionIndex.rebuild(
          (msg) => ctx.ui.setStatus("session-search", msg)
        );
        ctx.ui.notify(
          `Re-indexed: ${sessionIndex.size()} sessions`,
          "success"
        );
        ctx.ui.setStatus("session-search", "");
      } catch (err) {
        ctx.ui.notify(`Re-index failed: ${err.message}`, "error");
      }
    }
  });
  pi.registerTool({
    name: "session_search",
    label: "Session Search",
    description: "Semantic search over past pi sessions. Returns summaries of the most relevant sessions for a natural language query. Use to find previous work, decisions, debugging sessions, or code changes.",
    promptSnippet: "Semantic search over past pi sessions \u2014 find previous work, decisions, and context by topic.",
    promptGuidelines: [
      "Use session_search to find past coding sessions relevant to the current task (e.g. 'when did we refactor the auth module', 'previous work on Lambda timeouts').",
      "Pass the optional `project` parameter to limit search to a single project \u2014 use a substring of the project path or slug (e.g. 'pi-session-search').",
      "Use session_list for browsing by date/project. Use session_read to dive into a specific session."
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Natural language search query" }),
      project: Type.Optional(
        Type.String({
          description: "Filter by project name or path substring (matches projectSlug or cwd, same semantics as session_list)"
        })
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Max results to return (default 10, max 25)"
        })
      )
    }),
    async execute(_toolCallId, params, signal) {
      if (!sessionIndex || sessionIndex.size() === 0) {
        const msg = !sessionIndex ? "Session index not ready yet." : "Session index is empty \u2014 it may still be building. Try again in a moment.";
        return { content: [{ type: "text", text: msg }], details: {} };
      }
      const limit = Math.min(params.limit ?? 10, 25);
      try {
        const results = await sessionIndex.search(params.query, limit, signal, params.project);
        if (results.length === 0) {
          const scope = params.project ? ` in project "${params.project}"` : "";
          return {
            content: [
              {
                type: "text",
                text: `No relevant sessions found for: "${params.query}"${scope}`
              }
            ],
            details: {}
          };
        }
        const home = process.env.HOME || "";
        const output = results.map((r, i) => {
          const score = (r.score * 100).toFixed(1);
          const displayFile = r.session.file.replace(home, "~");
          return [
            `### ${i + 1}. ${r.session.name || truncate2(r.session.firstUserMessage, 80)} (${score}% match)`,
            `File: ${displayFile}`,
            `ID: ${r.session.id}`,
            `Date: ${r.session.startedAt.split("T")[0]} | CWD: ${r.session.cwd}`,
            r.summary
          ].join("\n");
        }).join("\n\n---\n\n");
        const scopeNote = params.project ? ` scoped to "${params.project}"` : "";
        const header = `Found ${results.length} sessions for "${params.query}"${scopeNote} (${sessionIndex.size()} sessions indexed):

`;
        return {
          content: [{ type: "text", text: header + output }],
          details: { resultCount: results.length, indexSize: sessionIndex.size(), project: params.project }
        };
      } catch (err) {
        throw new Error(`session-search failed: ${err.message}`);
      }
    }
  });
  pi.registerTool({
    name: "session_list",
    label: "Session List",
    description: "List past pi sessions with optional filters by project, date range, or archive status. Returns session metadata and summaries.",
    promptSnippet: "List/filter past pi sessions by project, date, or archive status.",
    parameters: Type.Object({
      project: Type.Optional(
        Type.String({ description: "Filter by project name or path substring" })
      ),
      after: Type.Optional(
        Type.String({
          description: "Only sessions after this date (ISO format, e.g. 2026-03-01)"
        })
      ),
      before: Type.Optional(
        Type.String({
          description: "Only sessions before this date (ISO format)"
        })
      ),
      archived: Type.Optional(
        Type.Boolean({ description: "Filter by archived status" })
      ),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default 20, max 50)" })
      )
    }),
    async execute(_toolCallId, params) {
      if (!sessionIndex || sessionIndex.size() === 0) {
        const msg = !sessionIndex ? "Session index not ready yet." : "Session index is empty.";
        return { content: [{ type: "text", text: msg }], details: {} };
      }
      const limit = Math.min(params.limit ?? 20, 50);
      const sessions = sessionIndex.list({
        project: params.project,
        after: params.after,
        before: params.before,
        archived: params.archived,
        limit
      });
      if (sessions.length === 0) {
        return {
          content: [{ type: "text", text: "No sessions match the filters." }],
          details: {}
        };
      }
      const home = process.env.HOME || "";
      const output = sessions.map((s, i) => {
        const name = s.name || truncate2(s.firstUserMessage, 60);
        const date = s.startedAt.split("T")[0];
        const tools = s.toolCalls.slice(0, 3).map((t) => t.name).join(", ");
        const arch = s.archived ? " (archived)" : "";
        const displayFile = s.file.replace(home, "~");
        return `${i + 1}. **${name}** \u2014 ${date}${arch}
   CWD: ${s.cwd} | ${s.userMessageCount} msgs | Tools: ${tools}
   File: ${displayFile}`;
      }).join("\n\n");
      const header = `${sessions.length} sessions (${sessionIndex.size()} total indexed):

`;
      return {
        content: [{ type: "text", text: header + output }],
        details: { resultCount: sessions.length }
      };
    }
  });
  pi.registerTool({
    name: "session_read",
    label: "Session Read",
    description: "Read the full conversation from a past pi session. Provide the session file path or session ID. Supports pagination for large sessions.",
    promptSnippet: "Read the full conversation from a specific past pi session by file path or ID.",
    parameters: Type.Object({
      session: Type.String({
        description: "Session file path (from session_search/session_list results) or session UUID"
      }),
      offset: Type.Optional(
        Type.Number({
          description: "Start from this entry index (for pagination, default 0)"
        })
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Max entries to return (default 50, max 100)"
        })
      ),
      include_tools: Type.Optional(
        Type.Boolean({
          description: "Include tool results in output (default false, verbose)"
        })
      )
    }),
    async execute(_toolCallId, params) {
      let filePath = params.session;
      if (sessionIndex && !filePath.endsWith(".jsonl") && !filePath.includes("/")) {
        const entry = sessionIndex.get(filePath);
        if (entry) {
          filePath = entry.session.file;
        } else {
          return {
            content: [
              {
                type: "text",
                text: `Session not found: "${params.session}". Use session_search or session_list to find the session file path.`
              }
            ],
            details: {}
          };
        }
      }
      if (filePath.startsWith("~")) {
        filePath = filePath.replace("~", process.env.HOME || "");
      }
      const home = process.env.HOME || "";
      const allowedRoots = [
        resolve(home, ".pi", "agent", "sessions"),
        resolve(home, ".pi", "agent", "sessions-archive"),
        ...(currentConfig?.extraSessionDirs ?? []).map((d) => resolve(d)),
        ...(currentConfig?.extraArchiveDirs ?? []).map((d) => resolve(d))
      ];
      const resolvedPath = resolve(filePath);
      if (!allowedRoots.some((root) => resolvedPath.startsWith(root + "/") || resolvedPath === root)) {
        return {
          content: [
            {
              type: "text",
              text: `Access denied: path "${filePath}" is outside the allowed session directories.`
            }
          ],
          details: {}
        };
      }
      const limit = Math.min(params.limit ?? 50, 100);
      const output = readSessionConversation(filePath, {
        offset: params.offset ?? 0,
        limit,
        includeTools: params.include_tools ?? false
      });
      return {
        content: [{ type: "text", text: output }],
        details: { file: filePath }
      };
    }
  });
}
export {
  buildContent,
  buildSummary,
  index_default as default,
  formatRelativeDate,
  isChildProcess,
  loadConfig,
  parseSession,
  pathToSlug,
  resolveInitialSyncAction,
  resolveSyncAction,
  slugToProject,
  toFtsQuery,
  truncate2 as truncate
};
//# sourceMappingURL=index.js.map
