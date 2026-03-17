import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join, basename, dirname } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────

export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface SessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: any;
}

export interface ParsedSession {
  /** Absolute path to the .jsonl file */
  file: string;
  /** Session UUID */
  id: string;
  /** ISO timestamp of session start */
  startedAt: string;
  /** ISO timestamp of last entry */
  endedAt: string;
  /** Working directory */
  cwd: string;
  /** Display name (from session_info entry) */
  name?: string;
  /** Whether this is from the archive */
  archived: boolean;
  /** Project directory slug (the session folder name) */
  projectSlug: string;
  /** Models used */
  models: string[];
  /** User message count */
  userMessageCount: number;
  /** Assistant message count */
  assistantMessageCount: number;
  /** Tool calls made */
  toolCalls: ToolCallSummary[];
  /** Files read */
  filesRead: string[];
  /** Files written/edited */
  filesModified: string[];
  /** First user message (for display) */
  firstUserMessage: string;
  /** All user messages (for indexing) */
  userMessages: string[];
  /** All assistant text (for indexing, truncated) */
  assistantText: string;
  /** Compaction summaries */
  compactionSummaries: string[];
  /** Branch summaries */
  branchSummaries: string[];
  /** Total token cost */
  totalCost: number;
  /** Total tokens used */
  totalTokens: number;
}

export interface ToolCallSummary {
  name: string;
  count: number;
}

// ─── Discovery ───────────────────────────────────────────────────────

const DEFAULT_SESSION_DIR = join(
  process.env.HOME || "~",
  ".pi",
  "agent",
  "sessions"
);
const DEFAULT_ARCHIVE_DIR = join(
  process.env.HOME || "~",
  ".pi",
  "agent",
  "sessions-archive"
);

/**
 * Find all .jsonl session files in the default + extra directories.
 */
export function discoverSessionFiles(
  extraSessionDirs: string[] = [],
  extraArchiveDirs: string[] = [],
): { file: string; archived: boolean }[] {
  const sDirs = [DEFAULT_SESSION_DIR, ...extraSessionDirs];
  const aDirs = [DEFAULT_ARCHIVE_DIR, ...extraArchiveDirs];

  const results: { file: string; archived: boolean }[] = [];

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

function walkJsonl(dir: string): string[] {
  const files: string[] = [];
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
    // permission error or similar — skip
  }
  return files;
}

// ─── Header-only read ────────────────────────────────────────────────

/**
 * Read just the session UUID from the JSONL header line.
 * Much cheaper than a full parse — used to correlate files with index entries
 * when a session has been moved (e.g. active → archive).
 */
export function readSessionId(file: string): string | null {
  try {
    const fd = openSync(file, "r");
    try {
      // Read just enough for the first line (headers are ~200 bytes)
      const buf = Buffer.alloc(1024);
      const bytesRead = readSync(fd, buf, 0, 1024, 0);
      const firstLine = buf.toString("utf8", 0, bytesRead).split("\n")[0];
      if (!firstLine) return null;
      const obj = JSON.parse(firstLine);
      return obj.type === "session" ? obj.id : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

// ─── Parsing ─────────────────────────────────────────────────────────

const MAX_ASSISTANT_TEXT = 50_000; // cap assistant text for indexing

export function parseSession(
  file: string,
  archived: boolean
): ParsedSession | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }

  const lines = raw.trim().split("\n");
  if (lines.length === 0) return null;

  let header: SessionHeader | null = null;
  const entries: SessionEntry[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === "session") {
        header = obj as SessionHeader;
      } else {
        entries.push(obj as SessionEntry);
      }
    } catch {
      // skip malformed lines
    }
  }

  if (!header) return null;

  // Determine project slug from the directory name
  const parentDir = basename(dirname(file));
  const projectSlug = parentDir.startsWith("--") ? parentDir : "unknown";

  // Extract data
  const models = new Set<string>();
  const toolCallMap = new Map<string, number>();
  const filesRead = new Set<string>();
  const filesModified = new Set<string>();
  const userMessages: string[] = [];
  const compactionSummaries: string[] = [];
  const branchSummaries: string[] = [];
  let assistantText = "";
  let name: string | undefined;
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
          // Extract text + tool calls
          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === "text" && assistantText.length < MAX_ASSISTANT_TEXT) {
                assistantText += block.text + "\n";
              }
              if (block.type === "toolCall") {
                const name = block.name;
                toolCallMap.set(name, (toolCallMap.get(name) ?? 0) + 1);
              }
            }
          }
        }

        if (msg.role === "toolResult") {
          const tn = msg.toolName;
          // Track file operations
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

  const toolCalls = Array.from(toolCallMap.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

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
    totalTokens,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function extractTextContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");
  }
  return "";
}

/**
 * Try to extract a file path from a tool result entry.
 * We look at the parent assistant message's tool call arguments.
 */
function extractPathFromToolResult(_entry: SessionEntry, msg: any): string | null {
  // Tool results often have details with path info
  if (msg.details?.path) return msg.details.path;
  if (msg.details?.diff) {
    // edit tool — path is in the diff header
    const match = msg.details.diff?.match?.(/^  \d+ (.*)/m);
    // Not reliable, skip
  }
  // Try content for read tool
  if (msg.toolName === "read" && msg.content?.[0]?.text) {
    // The content is the file content, not the path — skip
  }
  return null;
}
