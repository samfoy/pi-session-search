import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadConfig, saveConfig, getConfigPath, getIndexDir } from "./config";
import type { Config } from "./config";
import { createEmbedder } from "./embedder";
import { SessionIndex } from "./session-index";
import { readSessionConversation } from "./reader";

export default function (pi: ExtensionAPI) {
  let sessionIndex: SessionIndex | null = null;
  let currentConfig: Config | null = null;
  let syncTimer: ReturnType<typeof setInterval> | null = null;

  const SYNC_INTERVAL_MS = 5 * 60 * 1000; // re-sync every 5 minutes

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    try {
      currentConfig = loadConfig();
    } catch (err: any) {
      ctx.ui.notify(`session-search: ${err.message}`, "warning");
      return;
    }

    if (!currentConfig) {
      // Not configured — silent until user runs setup
      return;
    }

    // Fire-and-forget: don't block session startup if indexing is slow
    // (e.g. embedder credentials are unavailable). The search tools already
    // handle the index not being ready gracefully.
    void startIndex(currentConfig, ctx);
  });

  async function startIndex(config: Config, ctx: any) {
    try {
      const embedder = createEmbedder(config.embedder);
      sessionIndex = new SessionIndex(
        embedder,
        getIndexDir(),
        config.extraSessionDirs,
        config.extraArchiveDirs,
      );
      await sessionIndex.load();

      // Sync with a timeout so a hung embedder doesn't block forever.
      // The loaded cache is still usable for searches even if sync times out.
      const SYNC_TIMEOUT_MS = 120_000;
      const syncResult = await Promise.race([
        sessionIndex.sync(
          (msg) => ctx.ui.setStatus("session-search", msg)
        ),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), SYNC_TIMEOUT_MS)),
      ]);

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
  });

  // ------------------------------------------------------------------
  // Setup command
  // ------------------------------------------------------------------

  pi.registerCommand("session-search-setup", {
    description:
      "Configure session search — choose embedding provider",
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
  // Reindex command
  // ------------------------------------------------------------------

  pi.registerCommand("session-reindex", {
    description: "Force full re-index of all session files",
    handler: async (_args, ctx) => {
      if (!sessionIndex) {
        ctx.ui.notify(
          "Not configured. Run /session-search-setup first.",
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
          ? "session-search is not configured. The user can run /session-search-setup to set it up."
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
          ? "session-search is not configured. The user can run /session-search-setup to set it up."
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
