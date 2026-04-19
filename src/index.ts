import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadConfig, saveConfig, getConfigPath, getIndexDir } from "./config";
import type { Config } from "./config";
import { createEmbedder } from "./embedder";
import { SessionIndex } from "./session-index";
import { FtsSessionIndex } from "./fts-index";
import { readSessionConversation } from "./reader";
import { resolve } from "node:path";

type AnyIndex = SessionIndex | FtsSessionIndex;

export default function (pi: ExtensionAPI) {
  let sessionIndex: AnyIndex | null = null;
  let currentConfig: Config | null = null;
  let syncTimer: ReturnType<typeof setInterval> | null = null;

  const SYNC_INTERVAL_MS = 5 * 60 * 1000; // re-sync every 5 minutes

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // Session primer — inject recent session context before agent starts
  // ------------------------------------------------------------------

  pi.on("before_agent_start", async (event, ctx) => {
    if (!sessionIndex || sessionIndex.size() === 0) return;

    try {
      const cwd = ctx.cwd || "";
      // Derive a project slug from cwd to filter sessions
      const projectSlug = cwd ? pathToSlug(cwd) : undefined;

      // Get recent sessions, optionally filtered by project
      let sessions = sessionIndex.list({
        project: projectSlug,
        limit: 5,
      });

      // Fall back to global recent if no project matches
      if (sessions.length === 0 && projectSlug) {
        sessions = sessionIndex.list({ limit: 5 });
      }

      if (sessions.length === 0) return;

      const lines = sessions.map((s) => {
        const name = s.name || truncate(s.firstUserMessage, 80);
        const date = s.startedAt.split("T")[0];
        const rel = formatRelativeDate(s.startedAt);
        const displayCwd = s.cwd.replace(process.env.HOME || "", "~").slice(0, 60);
        const msgs = `${s.userMessageCount} user, ${s.assistantMessageCount} assistant`;
        const mode = s.models[0] ? ` Mode: ${s.models[0].split("/").pop()}` : "";
        return `- **${rel}**: **${name}** (${date}) Project: ${s.projectSlug} | CWD: ${displayCwd} Messages: ${msgs}${mode}`;
      });

      const primer = `\n\n## Recent Sessions (this project)\n${lines.join("\n")}\n`;

      // Keep it under 500 chars if possible
      const trimmed = primer.length > 1500 ? primer.slice(0, 1500) + "\n" : primer;

      return { systemPrompt: (event.systemPrompt || "") + trimmed };
    } catch {
      // Don't block on primer failure
      return undefined;
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      currentConfig = loadConfig();
    } catch (err: any) {
      ctx.ui.notify(`session-search: ${err.message}`, "warning");
    }

    // FTS5 works out of the box with no config; embeddings are optional.
    void startIndex(currentConfig, ctx);
  });

  async function startIndex(config: Config | null, ctx: any) {
    try {
      if (config?.embedder) {
        const embedder = createEmbedder(config.embedder);
        sessionIndex = new SessionIndex(
          embedder,
          getIndexDir(),
          config.extraSessionDirs,
          config.extraArchiveDirs,
        );
      } else {
        sessionIndex = new FtsSessionIndex(
          getIndexDir(),
          config?.extraSessionDirs ?? [],
          config?.extraArchiveDirs ?? [],
        );
      }
      await sessionIndex.load();

      // Fire-and-forget: run initial sync in the background so startIndex
      // returns immediately and doesn't block pi's startup.
      const SYNC_TIMEOUT_MS = 120_000;
      Promise.race([
        sessionIndex.sync(
          (msg) => ctx.ui.setStatus("session-search", msg)
        ),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), SYNC_TIMEOUT_MS)),
      ])
        .then((syncResult) => {
          if (syncResult === null) {
            ctx.ui.notify("session-search: sync timed out (index may be stale)", "warning");
            ctx.ui.setStatus("session-search", "");
          } else {
            const { added, updated, removed, moved } = syncResult;
            const changes = added + updated + removed + moved;
            if (changes > 0) {
              const parts: string[] = [];
              if (added) parts.push(`+${added}`);
              if (updated) parts.push(`~${updated}`);
              if (removed) parts.push(`-${removed}`);
              if (moved) parts.push(`↗${moved} moved`);
              ctx.ui.setStatus(
                "session-search",
                `Sessions: ${parts.join(" ")} (${sessionIndex.size()} total)`
              );
              setTimeout(() => ctx.ui.setStatus("session-search", ""), 5000);
            }
          }
        })
        .catch((err) => {
          ctx.ui.notify(`session-search: initial sync failed: ${err.message}`, "warning");
          ctx.ui.setStatus("session-search", "");
        });

      // Periodic background sync to pick up new/changed sessions
      syncTimer = setInterval(async () => {
        if (!sessionIndex) return;
        try {
          const result = await sessionIndex.sync();
          const changes = result.added + result.updated + result.removed + result.moved;
          if (changes > 0) {
            const parts = [];
            if (result.added) parts.push(`+${result.added}`);
            if (result.updated) parts.push(`~${result.updated}`);
            if (result.removed) parts.push(`-${result.removed}`);
            if (result.moved) parts.push(`↗${result.moved} moved`);
            ctx.ui.setStatus(
              "session-search",
              `Sessions synced: ${parts.join(" ")} (${sessionIndex.size()} total)`
            );
            setTimeout(() => ctx.ui.setStatus("session-search", ""), 5000);
          }
        } catch {
          // Silent — don't spam on background sync failures
        }
      }, SYNC_INTERVAL_MS);
    } catch (err: any) {
      ctx.ui.notify(`session-search init failed: ${err.message}`, "error");
    }
  }

  pi.on("session_shutdown", async () => {
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
    if (sessionIndex && "close" in sessionIndex) {
      (sessionIndex as any).close();
    }
  });

  // ------------------------------------------------------------------
  // Setup command
  // ------------------------------------------------------------------

  pi.registerCommand("session-embeddings-setup", {
    description:
      "Enable semantic embeddings for hybrid search (FTS5 is always on)",
    handler: async (_args, ctx) => {
      const providerChoice = await ctx.ui.select("Embedding provider:", [
        "openai — OpenAI API (text-embedding-3-small)",
        "bedrock — AWS Bedrock (Titan Embeddings v2)",
        "ollama — Local Ollama (nomic-embed-text)",
      ]);

      if (!providerChoice) {
        ctx.ui.notify("Setup cancelled.", "info");
        return;
      }

      const providerType = providerChoice.split(" ")[0] as
        | "openai"
        | "bedrock"
        | "ollama";

      let embedder: any;

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
            type: "openai" as const,
            apiKey: apiKey?.startsWith("(") ? undefined : apiKey || undefined,
            model: model || "text-embedding-3-small",
            dimensions: 512,
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
            type: "bedrock" as const,
            profile: profile || "default",
            region: region || "us-east-1",
            model: model || "amazon.titan-embed-text-v2:0",
            dimensions: 512,
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
            type: "ollama" as const,
            url: url || "http://localhost:11434",
            model: model || "nomic-embed-text",
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
        extraSessionDirs: extraDirs
          ? extraDirs.split(",").map((d: string) => d.trim()).filter(Boolean)
          : undefined,
        extraArchiveDirs: extraArchive
          ? extraArchive.split(",").map((d: string) => d.trim()).filter(Boolean)
          : undefined,
      });

      ctx.ui.notify(
        `Config saved to ${getConfigPath()}. Run /reload to activate.`,
        "success"
      );
    },
  });

  // ------------------------------------------------------------------
  // Sync command
  // ------------------------------------------------------------------

  pi.registerCommand("session-sync", {
    description: "Force an immediate incremental re-sync of session index",
    handler: async (_args, ctx) => {
      if (!sessionIndex) {
        ctx.ui.notify("Session index not ready yet.", "warning");
        return;
      }
      try {
        const r = await sessionIndex.sync((msg) => ctx.ui.setStatus("session-search", msg));
        const parts: string[] = [];
        if (r.added) parts.push(`+${r.added}`);
        if (r.updated) parts.push(`~${r.updated}`);
        if (r.removed) parts.push(`-${r.removed}`);
        if (r.moved) parts.push(`↗${r.moved}`);
        ctx.ui.notify(
          `Synced: ${parts.join(" ") || "no changes"} (${sessionIndex.size()} total)`,
          "success",
        );
        ctx.ui.setStatus("session-search", "");
      } catch (err: any) {
        ctx.ui.notify(`Sync failed: ${err.message}`, "error");
      }
    },
  });

  // ------------------------------------------------------------------
  // Reindex command
  // ------------------------------------------------------------------

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
        await sessionIndex.rebuild((msg) =>
          ctx.ui.setStatus("session-search", msg)
        );
        ctx.ui.notify(
          `Re-indexed: ${sessionIndex.size()} sessions`,
          "success"
        );
        ctx.ui.setStatus("session-search", "");
      } catch (err: any) {
        ctx.ui.notify(`Re-index failed: ${err.message}`, "error");
      }
    },
  });

  // ------------------------------------------------------------------
  // Tool: session_search
  // ------------------------------------------------------------------

  pi.registerTool({
    name: "session_search",
    label: "Session Search",
    description:
      "Semantic search over past pi sessions. Returns summaries of the most relevant sessions for a natural language query. Use to find previous work, decisions, debugging sessions, or code changes.",
    promptSnippet:
      "Semantic search over past pi sessions — find previous work, decisions, and context by topic.",
    promptGuidelines: [
      "Use session_search to find past coding sessions relevant to the current task (e.g. 'when did we refactor the auth module', 'previous work on Lambda timeouts').",
      "Use session_list for browsing by date/project. Use session_read to dive into a specific session.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Natural language search query" }),
      limit: Type.Optional(
        Type.Number({
          description: "Max results to return (default 10, max 25)",
        })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      if (!sessionIndex || sessionIndex.size() === 0) {
        const msg = !sessionIndex
          ? "Session index not ready yet."
          : "Session index is empty — it may still be building. Try again in a moment.";
        return { content: [{ type: "text", text: msg }], details: {} };
      }

      const limit = Math.min(params.limit ?? 10, 25);

      try {
        const results = await sessionIndex.search(params.query, limit, signal);

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No relevant sessions found for: "${params.query}"`,
              },
            ],
            details: {},
          };
        }

        const home = process.env.HOME || "";
        const output = results
          .map((r, i) => {
            const score = (r.score * 100).toFixed(1);
            const displayFile = r.session.file.replace(home, "~");
            return [
              `### ${i + 1}. ${r.session.name || truncate(r.session.firstUserMessage, 80)} (${score}% match)`,
              `File: ${displayFile}`,
              `ID: ${r.session.id}`,
              `Date: ${r.session.startedAt.split("T")[0]} | CWD: ${r.session.cwd}`,
              r.summary,
            ].join("\n");
          })
          .join("\n\n---\n\n");

        const header = `Found ${results.length} sessions for "${params.query}" (${sessionIndex.size()} sessions indexed):\n\n`;

        return {
          content: [{ type: "text", text: header + output }],
          details: { resultCount: results.length, indexSize: sessionIndex.size() },
        };
      } catch (err: any) {
        throw new Error(`session-search failed: ${err.message}`);
      }
    },
  });

  // ------------------------------------------------------------------
  // Tool: session_list
  // ------------------------------------------------------------------

  pi.registerTool({
    name: "session_list",
    label: "Session List",
    description:
      "List past pi sessions with optional filters by project, date range, or archive status. Returns session metadata and summaries.",
    promptSnippet:
      "List/filter past pi sessions by project, date, or archive status.",
    parameters: Type.Object({
      project: Type.Optional(
        Type.String({ description: "Filter by project name or path substring" })
      ),
      after: Type.Optional(
        Type.String({
          description: "Only sessions after this date (ISO format, e.g. 2026-03-01)",
        })
      ),
      before: Type.Optional(
        Type.String({
          description: "Only sessions before this date (ISO format)",
        })
      ),
      archived: Type.Optional(
        Type.Boolean({ description: "Filter by archived status" })
      ),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default 20, max 50)" })
      ),
    }),
    async execute(_toolCallId, params) {
      if (!sessionIndex || sessionIndex.size() === 0) {
        const msg = !sessionIndex
          ? "Session index not ready yet."
          : "Session index is empty.";
        return { content: [{ type: "text", text: msg }], details: {} };
      }

      const limit = Math.min(params.limit ?? 20, 50);
      const sessions = sessionIndex.list({
        project: params.project,
        after: params.after,
        before: params.before,
        archived: params.archived,
        limit,
      });

      if (sessions.length === 0) {
        return {
          content: [{ type: "text", text: "No sessions match the filters." }],
          details: {},
        };
      }

      const home = process.env.HOME || "";
      const output = sessions
        .map((s, i) => {
          const name = s.name || truncate(s.firstUserMessage, 60);
          const date = s.startedAt.split("T")[0];
          const tools = s.toolCalls
            .slice(0, 3)
            .map((t) => t.name)
            .join(", ");
          const arch = s.archived ? " (archived)" : "";
          const displayFile = s.file.replace(home, "~");
          return `${i + 1}. **${name}** — ${date}${arch}\n   CWD: ${s.cwd} | ${s.userMessageCount} msgs | Tools: ${tools}\n   File: ${displayFile}`;
        })
        .join("\n\n");

      const header = `${sessions.length} sessions (${sessionIndex.size()} total indexed):\n\n`;

      return {
        content: [{ type: "text", text: header + output }],
        details: { resultCount: sessions.length },
      };
    },
  });

  // ------------------------------------------------------------------
  // Tool: session_read
  // ------------------------------------------------------------------

  pi.registerTool({
    name: "session_read",
    label: "Session Read",
    description:
      "Read the full conversation from a past pi session. Provide the session file path or session ID. Supports pagination for large sessions.",
    promptSnippet:
      "Read the full conversation from a specific past pi session by file path or ID.",
    parameters: Type.Object({
      session: Type.String({
        description: "Session file path (from session_search/session_list results) or session UUID",
      }),
      offset: Type.Optional(
        Type.Number({
          description: "Start from this entry index (for pagination, default 0)",
        })
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Max entries to return (default 50, max 100)",
        })
      ),
      include_tools: Type.Optional(
        Type.Boolean({
          description: "Include tool results in output (default false, verbose)",
        })
      ),
    }),
    async execute(_toolCallId, params) {
      // Resolve file path
      let filePath = params.session;

      // If it looks like a UUID, try to find it in the index
      if (
        sessionIndex &&
        !filePath.endsWith(".jsonl") &&
        !filePath.includes("/")
      ) {
        const entry = sessionIndex.get(filePath);
        if (entry) {
          filePath = entry.session.file;
        } else {
          return {
            content: [
              {
                type: "text",
                text: `Session not found: "${params.session}". Use session_search or session_list to find the session file path.`,
              },
            ],
            details: {},
          };
        }
      }

      // Expand ~
      if (filePath.startsWith("~")) {
        filePath = filePath.replace("~", process.env.HOME || "");
      }

      // Path traversal guard: ensure the resolved path is within known session directories
      const home = process.env.HOME || "";
      const allowedRoots = [
        resolve(home, ".pi", "agent", "sessions"),
        resolve(home, ".pi", "agent", "sessions-archive"),
        ...(currentConfig?.extraSessionDirs ?? []).map((d) => resolve(d)),
        ...(currentConfig?.extraArchiveDirs ?? []).map((d) => resolve(d)),
      ];
      const resolvedPath = resolve(filePath);
      if (!allowedRoots.some((root) => resolvedPath.startsWith(root + "/") || resolvedPath === root)) {
        return {
          content: [
            {
              type: "text",
              text: `Access denied: path "${filePath}" is outside the allowed session directories.`,
            },
          ],
          details: {},
        };
      }

      const limit = Math.min(params.limit ?? 50, 100);
      const output = readSessionConversation(filePath, {
        offset: params.offset ?? 0,
        limit,
        includeTools: params.include_tools ?? false,
      });

      return {
        content: [{ type: "text", text: output }],
        details: { file: filePath },
      };
    },
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

/** Convert a cwd path to a project slug for filtering. */
function pathToSlug(cwd: string): string {
  const home = process.env.HOME || "";
  const rel = cwd.startsWith(home) ? cwd.slice(home.length + 1) : cwd;
  return rel.replace(/\//g, "-");
}

/** Format an ISO date as a relative time string (e.g. "2h ago", "3d ago"). */
function formatRelativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = now - then;
  if (diffMs < 0) return "just now";

  const minutes = Math.floor(diffMs / 60_000);
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
