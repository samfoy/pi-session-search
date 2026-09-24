import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  loadConfig,
  saveConfig,
  getConfigPath,
  getIndexDir,
  DEFAULT_SYNC_INTERVAL_MS,
  DEFAULT_INITIAL_DELAY_MS,
} from "./config";
import type { Config } from "./config";
import { createIndexService, spawnIndexWorker } from "./index-service";
import type { IndexOptions, IndexService, SyncResult } from "./index-service";
import { readSessionConversation } from "./reader";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { truncate, pathToSlug, formatRelativeDate } from "./utils";

/**
 * Bundled worker entry. Resolves the same from src/index.ts (pi-total-recall
 * loads the TypeScript source) and dist/index.js, since both sit one level
 * below the package root.
 */
const INDEX_WORKER_FILE = fileURLToPath(new URL("../dist/index-worker.js", import.meta.url));

/** How long session_start waits for the primer before letting pi continue. */
const PRIMER_WAIT_MS = 1000;

let useIndexWorker = true;
let indexWorkerFile = INDEX_WORKER_FILE;

/** Test-only: run the index in-process, or on another worker script. */
export function _setIndexWorkerEnabled(enabled: boolean, file = INDEX_WORKER_FILE): void {
  useIndexWorker = enabled;
  indexWorkerFile = file;
}

/**
 * Index lifecycle as the tools see it. "warming" means the persisted index is
 * loaded and answering, but the initial sync has not finished yet.
 */
type IndexState = "off" | "loading" | "warming" | "ready" | "failed";

const WARMING_NOTE =
  "Note: session index warming (initial sync still running), so results may be incomplete.";

/** "<cause>. Run /reload to restart indexing." without doubling a trailing period. */
function withReloadHint(cause: string): string {
  return `${cause.replace(/\.$/, "")}. Run /reload to restart indexing.`;
}

/** Build a text tool result; one details type keeps every return path assignable. */
function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

/**
 * Resolve the effective sync interval and return the timer action.
 *
 * - `undefined` → silent default (no warning)
 * - `-1` → `{ disabled: true }` (no timer)
 * - `> 0` → `{ disabled: false, intervalMs: <value> }` (timer fires every N ms)
 * - other ≤ 0 → `{ disabled: false, intervalMs: DEFAULT, fallback: true }` (warn + default)
 */
export function resolveSyncAction(rawInterval?: number): {
  disabled: boolean;
  intervalMs?: number;
  fallback?: boolean;
} {
  if (rawInterval === undefined)
    return { disabled: false, intervalMs: DEFAULT_SYNC_INTERVAL_MS };
  if (rawInterval === -1) return { disabled: true };
  if (rawInterval <= 0) {
    return { disabled: false, intervalMs: DEFAULT_SYNC_INTERVAL_MS, fallback: true };
  }
  return { disabled: false, intervalMs: rawInterval };
}

/**
 * Resolve the initial startup sync delay and return the action.
 *
 * - `undefined` → silent default immediate (no warning)
 * - `-1` → `{ skip: true }` (no initial sync)
 * - `>= 0` → `{ skip: false, delayMs: <value> }` (sync after N ms, 0 = immediate)
 * - other < 0 → `{ skip: false, delayMs: DEFAULT, fallback: true }` (warn + default)
 */
export function resolveInitialSyncAction(rawDelay?: number): {
  skip: boolean;
  delayMs?: number;
  fallback?: boolean;
} {
  if (rawDelay === undefined)
    return { skip: false, delayMs: DEFAULT_INITIAL_DELAY_MS };
  if (rawDelay === -1) return { skip: true };
  if (rawDelay < 0) {
    return { skip: false, delayMs: DEFAULT_INITIAL_DELAY_MS, fallback: true };
  }
  return { skip: false, delayMs: rawDelay };
}

/**
 * Detect whether this pi process is a child subagent or non-interactive
 * programmatic invocation.
 *
 * Signals checked (any one triggers):
 * - `PI_SUBAGENT_DEPTH > 0` — official pi-subagents child marker
 * - `!process.stdin.isTTY` — non-interactive terminal (CI/CD, pipes, SDK embedders)
 */
export function isChildProcess(): boolean {
  const depth = Number(process.env.PI_SUBAGENT_DEPTH);
  if (depth > 0) return true;
  if (!process.stdin.isTTY) return true;
  return false;
}

export default function (pi: ExtensionAPI) {
  let sessionIndex: IndexService | null = null;
  let indexState: IndexState = "off";
  let indexError = "";
  let currentConfig: Config | null = null;
  let syncTimer: ReturnType<typeof setInterval> | null = null;
  let sessionCwd: string | undefined;

  // Track one-shot timers so session_shutdown can clear them. Without this,
  // deferred callbacks fire after teardown, touch ctx.ui, and hit
  // assertActive() — crashing `pi -p --no-session` on exit. (issue #8)
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  let shuttingDown = false;

  /**
   * setTimeout wrapper that registers the handle for shutdown cancellation
   * and guards the callback against a stale ctx.
   */
  function scheduleTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const handle = setTimeout(() => {
      pendingTimers.delete(handle);
      if (shuttingDown) return;
      try {
        fn();
      } catch {
        // ctx may have gone stale between the shuttingDown check and fn() —
        // swallow so we don't crash the process on exit.
      }
    }, ms);
    pendingTimers.add(handle);
    return handle;
  }

  // Resolved from config at session_start; -1 means auto-sync disabled.
  let effectiveSyncIntervalMs = DEFAULT_SYNC_INTERVAL_MS;

  /**
   * The index when it can answer (possibly while warming), or the text a tool
   * should return instead.
   */
  function usableIndex(): IndexService | string {
    if (indexState === "failed") return `Session index unavailable: ${withReloadHint(indexError)}`;
    if (!sessionIndex || indexState === "off" || indexState === "loading") {
      return "Session index warming (loading the saved index). Try again in a moment.";
    }
    return sessionIndex;
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // Session primer — inject recent session context ONCE at session_start.
  //
  // Historical note: earlier versions injected this on every before_agent_start
  // hook. That was buggy in two ways:
  //   (1) The custom message landed AFTER the user's message in history, so the
  //       model responded to the primer instead of the user's actual question.
  //   (2) The relative dates ("8m ago") drifted turn-to-turn, breaking provider
  //       prefix caches.
  // Matching pi-knowledge-search's pattern, we now inject once at session_start
  // via pi.sendMessage, before any user message. Dedup via session history so
  // /resume and re-opens don't double-inject.
  // ------------------------------------------------------------------

  async function injectPrimer(
    index: IndexService,
    ctx: { sessionManager: { getEntries: () => SessionEntry[] } },
  ): Promise<void> {
    try {
      const alreadyInjected = ctx.sessionManager
        .getEntries()
        .some(
          (e: SessionEntry) =>
            e.type === "custom_message" && e.customType === "pi-session-search-primer",
        );
      if (alreadyInjected) return;

      const cwd = sessionCwd || "";
      const projectSlug = cwd ? pathToSlug(cwd) : undefined;

      let sessions = await index.list({ project: projectSlug, limit: 5 });
      if (sessions.length === 0 && projectSlug) {
        sessions = await index.list({ limit: 5 });
      }
      if (sessions.length === 0 || shuttingDown) return;

      const lines = sessions.map((s) => {
        const name = s.name || truncate(s.firstUserMessage, 80);
        const date = s.startedAt.split("T")[0];
        const rel = formatRelativeDate(s.startedAt);
        const displayCwd = s.cwd.replace(process.env.HOME || "", "~").slice(0, 60);
        const msgs = `${s.userMessageCount} user, ${s.assistantMessageCount} assistant`;
        const mode = s.models[0] ? ` Mode: ${s.models[0].split("/").pop()}` : "";
        return `- **${rel}**: **${name}** (${date}) Project: ${s.projectSlug} | CWD: ${displayCwd} Messages: ${msgs}${mode}`;
      });

      const primer = `## Recent Sessions (this project)\n${lines.join("\n")}\n`;
      const trimmed = primer.length > 1500 ? primer.slice(0, 1500) + "\n" : primer;

      // triggerTurn: false — if the primer is late and a turn is already
      // streaming, pi appends it after that turn instead of steering it.
      pi.sendMessage(
        {
          customType: "pi-session-search-primer",
          content: trimmed,
          display: false,
          details: { sessionCount: sessions.length },
        },
        { triggerTurn: false },
      );
    } catch {
      // Primer is nice-to-have; never break startup over it.
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    sessionCwd = ctx.cwd;
    try {
      currentConfig = loadConfig(sessionCwd);
    } catch (err: any) {
      ctx.ui.notify(`session-search: ${err.message}`, "warning");
    }

    // Apply configurable sync interval (from nested sync.interval)
    let syncAction = resolveSyncAction(currentConfig?.sync?.interval);
    effectiveSyncIntervalMs = syncAction.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;

    // Apply configurable initial sync delay (from nested sync.initialDelay)
    let initialAction = resolveInitialSyncAction(currentConfig?.sync?.initialDelay);

    // Auto-disable for child processes if configured
    if (currentConfig?.sync?.disableForChild && isChildProcess()) {
      syncAction = { disabled: true };
      initialAction = { skip: true };
      ctx.ui.notify("session-search: sync auto-disabled (child process detected)", "info");
    }

    // FTS5 works out of the box with no config; embeddings are optional.
    // The index loads on a worker thread, so waiting here for the primer (so
    // it precedes the first prompt, e.g. with `pi -p`) never blocks pi's
    // event loop; the cap bounds how long startup waits on it.
    const primerDone = startIndex(currentConfig, ctx, syncAction, initialAction);
    await Promise.race([
      primerDone,
      new Promise<void>((r) => setTimeout(r, PRIMER_WAIT_MS).unref()),
    ]);
  });

  function notifySyncError(ctx: any): (msg: string) => void {
    return (msg: string) => ctx.ui.notify(`session-search: ${msg}`, "warning");
  }

  function formatChanges(r: SyncResult, movedLabel = " moved"): string {
    const parts: string[] = [];
    if (r.added) parts.push(`+${r.added}`);
    if (r.updated) parts.push(`~${r.updated}`);
    if (r.removed) parts.push(`-${r.removed}`);
    if (r.moved) parts.push(`↗${r.moved}${movedLabel}`);
    return parts.join(" ");
  }

  function openIndex(options: IndexOptions, ctx: any): IndexService {
    if (!useIndexWorker || !existsSync(indexWorkerFile)) return createIndexService(options);
    return spawnIndexWorker(indexWorkerFile, options, (err) => {
      indexState = "failed";
      indexError = err.message;
      if (syncTimer) clearInterval(syncTimer);
      syncTimer = null;
      if (!shuttingDown) ctx.ui.notify(`session-search: ${withReloadHint(err.message)}`, "error");
    });
  }

  /**
   * Open and load the index, inject the primer, then schedule syncs.
   * Resolves once the primer step is done; syncs continue in the background.
   */
  async function startIndex(
    config: Config | null,
    ctx: any,
    syncAction?: ReturnType<typeof resolveSyncAction>,
    initialAction?: ReturnType<typeof resolveInitialSyncAction>,
  ): Promise<void> {
    try {
      indexState = "loading";
      const index = openIndex(
        {
          indexDir: getIndexDir(sessionCwd),
          extraSessionDirs: config?.extraSessionDirs ?? [],
          extraArchiveDirs: config?.extraArchiveDirs ?? [],
          sessionDir: config?.sessionDir,
          archiveDir: config?.archiveDir,
          embedder: config?.embedder,
          fusion: config?.fusion,
        },
        ctx,
      );
      sessionIndex = index;

      // In-process fallback: yield first so the synchronous load runs after
      // session_start's own turn rather than inside it.
      await new Promise<void>((r) => setImmediate(r));
      if (shuttingDown) return;

      // Load persisted index (searches work immediately; runs v2→v3 migration)
      await index.load();
      if (shuttingDown) return;
      indexState = "warming";

      // Inject the "Recent Sessions" primer as a custom message BEFORE any
      // user message arrives. Matches pi-knowledge-search's pattern and
      // ensures the LLM sees the primer as pre-existing context, not as the
      // last user message (which caused it to override user questions in
      // pi-session-search 1.4.0).
      // Skip when explicitly disabled via config (`primer.enabled = false`).
      if (config?.primer?.enabled === false) {
        ctx.ui.notify("session-search: primer disabled via config", "info");
      } else {
        await injectPrimer(index, ctx);
      }
      if (shuttingDown) return;

      scheduleSyncs(index, ctx, syncAction, initialAction);
    } catch (err: any) {
      // Failed init (e.g. FTS5 unavailable on an old Node 22) — drop the broken
      // handle so tool calls report the cause instead of a half-initialized
      // index ("no such table: sessions" or similar).
      if (indexState !== "failed") {
        indexState = "failed";
        indexError = err.message;
        if (!shuttingDown) ctx.ui.notify(`session-search init failed: ${err.message}`, "error");
      }
      void sessionIndex?.close().catch(() => {});
      sessionIndex = null;
    }
  }

  function scheduleSyncs(
    index: IndexService,
    ctx: any,
    syncAction?: ReturnType<typeof resolveSyncAction>,
    initialAction?: ReturnType<typeof resolveInitialSyncAction>,
  ): void {
    // Resolve initial sync action (skip/delay/immediate)
    const initAction = initialAction ?? resolveInitialSyncAction(DEFAULT_INITIAL_DELAY_MS);
    if (initAction.skip) {
      indexState = "ready";
      ctx.ui.notify(
        "session-search: initial sync skipped (set sync.initialDelay >= 0 to enable)",
        "info",
      );
    } else if (initAction.fallback) {
      ctx.ui.notify(
        "session-search: invalid sync.initialDelay, falling back to immediate",
        "warning",
      );
    }

    // The initial sync runs on the index worker; the tools answer from the
    // saved index (with a warming note) until it finishes.
    if (!initAction.skip) {
      const SYNC_TIMEOUT_MS = 600_000;
      const delayMs = initAction.delayMs ?? DEFAULT_INITIAL_DELAY_MS;
      const runSync = () =>
        Promise.race([
          index.sync({
            onProgress: (msg) => ctx.ui.setStatus("session-search", msg),
            onError: notifySyncError(ctx),
          }),
          new Promise<null>((resolve) =>
            scheduleTimer(() => resolve(null), SYNC_TIMEOUT_MS),
          ),
        ]);

      const initialSync = async () => {
        try {
          const syncResult = await runSync();
          if (shuttingDown) return;
          if (syncResult === null) {
            ctx.ui.notify("session-search: sync timed out (index may be stale)", "warning");
            ctx.ui.setStatus("session-search", "");
          } else {
            const changes = formatChanges(syncResult);
            if (changes) {
              ctx.ui.setStatus(
                "session-search",
                `Sessions: ${changes} (${await index.size()} total)`,
              );
              scheduleTimer(() => ctx.ui.setStatus("session-search", ""), 5000);
            }
          }
        } catch (err: any) {
          if (shuttingDown) return;
          // A worker crash was already reported by openIndex's onCrash.
          if (indexState !== "failed") {
            ctx.ui.notify(`session-search: initial sync failed: ${err.message}`, "warning");
          }
          ctx.ui.setStatus("session-search", "");
        } finally {
          if (indexState === "warming") indexState = "ready";
        }
      };

      // setImmediate: with the in-process fallback, the sync's synchronous
      // prefix (directory walk) must not run inside session_start's turn.
      if (delayMs > 0) scheduleTimer(() => void initialSync(), delayMs);
      else setImmediate(() => void initialSync());
    }

    // Periodic background sync to pick up new/changed sessions
    const action = syncAction ?? resolveSyncAction(effectiveSyncIntervalMs);
    if (action.disabled) {
      ctx.ui.notify("session-search: auto-sync disabled (set sync.interval > 0 to re-enable)", "info");
    } else if (action.fallback) {
      ctx.ui.notify(
        `session-search: invalid sync.interval, falling back to ${DEFAULT_SYNC_INTERVAL_MS / 1000}s`,
        "warning",
      );
      effectiveSyncIntervalMs = DEFAULT_SYNC_INTERVAL_MS;
    }

    if (!action.disabled && effectiveSyncIntervalMs > 0) {
      syncTimer = setInterval(async () => {
        if (shuttingDown || indexState === "failed") return;
        try {
          const result = await index.sync();
          if (shuttingDown) return;
          const changes = formatChanges(result);
          if (changes) {
            ctx.ui.setStatus(
              "session-search",
              `Sessions synced: ${changes} (${await index.size()} total)`,
            );
            scheduleTimer(() => ctx.ui.setStatus("session-search", ""), 5000);
          }
        } catch {
          // Silent — don't spam on background sync failures
        }
      }, effectiveSyncIntervalMs);
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
    const index = sessionIndex;
    sessionIndex = null;
    await index?.close().catch(() => {});
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
        "mistral — Mistral API (mistral-embed)",
        "bedrock — AWS Bedrock (Titan Embeddings v2)",
        "ollama — Local Ollama (nomic-embed-text)",
        "openai-compatible — Any OpenAI-compatible API",
      ]);

      if (!providerChoice) {
        ctx.ui.notify("Setup cancelled.", "info");
        return;
      }

      const providerType = providerChoice.split(" ")[0] as
        | "openai"
        | "mistral"
        | "bedrock"
        | "ollama"
        | "openai-compatible";

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
            type: "mistral" as const,
            apiKey: apiKey?.startsWith("(") ? undefined : apiKey || undefined,
            model: model || "mistral-embed",
            dimensions: 1024,
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
          const sendDims = await ctx.ui.input(
            "Send dimensions parameter? (true only for models that support it):",
            "false"
          );
          embedder = {
            type: "openai-compatible" as const,
            baseUrl: baseUrl.replace(/\/$/, ""),
            apiKey: apiKey || undefined,
            model: model || undefined,
            dimensions: parseInt(dims || "512", 10),
            sendDimensions: sendDims?.toLowerCase() === "true",
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
      }, sessionCwd);

      ctx.ui.notify(
        `Config saved to ${getConfigPath(sessionCwd)}. Run /reload to activate.`,
        "info"
      );
    },
  });

  // ------------------------------------------------------------------
  // Sync command
  // ------------------------------------------------------------------

  pi.registerCommand("session-sync", {
    description: "Force an immediate incremental re-sync of session index",
    handler: async (_args, ctx) => {
      const index = usableIndex();
      if (typeof index === "string") {
        ctx.ui.notify(index, "warning");
        return;
      }
      try {
        const r = await index.sync({
          onProgress: (msg) => ctx.ui.setStatus("session-search", msg),
          onError: notifySyncError(ctx),
        });
        ctx.ui.notify(
          `Synced: ${formatChanges(r, "") || "no changes"} (${await index.size()} total)`,
          "info",
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
      const index = usableIndex();
      if (typeof index === "string") {
        ctx.ui.notify(index, "warning");
        return;
      }
      ctx.ui.notify("Re-indexing sessions...", "info");
      try {
        await index.rebuild({
          onProgress: (msg) => ctx.ui.setStatus("session-search", msg),
          onError: notifySyncError(ctx),
        });
        ctx.ui.notify(
          `Re-indexed: ${await index.size()} sessions`,
          "info"
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
      "Pass the optional `project` parameter to limit search to a single project — use a substring of the project path or slug (e.g. 'pi-session-search').",
      "Use session_list for browsing by date/project. Use session_read to dive into a specific session.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Natural language search query" }),
      project: Type.Optional(
        Type.String({
          description:
            "Filter by project name or path substring (matches projectSlug or cwd, same semantics as session_list)",
        })
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Max results to return (default 10, max 25)",
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const index = usableIndex();
      if (typeof index === "string") return textResult(index);
      const warming = indexState === "warming";
      const note = warming ? `${WARMING_NOTE}\n\n` : "";

      const limit = Math.min(params.limit ?? 10, 25);

      try {
        const indexSize = await index.size();
        if (indexSize === 0) {
          return textResult(
            warming
              ? "Session index warming: no sessions indexed yet. Try again in a moment."
              : "Session index is empty.",
          );
        }

        const results = await index.search(params.query, limit, params.project);

        if (results.length === 0) {
          const scope = params.project ? ` in project "${params.project}"` : "";
          return textResult(`${note}No relevant sessions found for: "${params.query}"${scope}`);
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

        const scopeNote = params.project ? ` scoped to "${params.project}"` : "";
        const header = `${note}Found ${results.length} sessions for "${params.query}"${scopeNote} (${indexSize} sessions indexed):\n\n`;

        return textResult(header + output, {
          resultCount: results.length,
          indexSize,
          project: params.project,
          warming,
        });
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
      const index = usableIndex();
      if (typeof index === "string") return textResult(index);
      const warming = indexState === "warming";
      const note = warming ? `${WARMING_NOTE}\n\n` : "";

      const indexSize = await index.size();
      if (indexSize === 0) {
        return textResult(
          warming
            ? "Session index warming: no sessions indexed yet. Try again in a moment."
            : "Session index is empty.",
        );
      }

      const limit = Math.min(params.limit ?? 20, 50);
      const sessions = await index.list({
        project: params.project,
        after: params.after,
        before: params.before,
        archived: params.archived,
        limit,
      });

      if (sessions.length === 0) {
        return textResult(`${note}No sessions match the filters.`);
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

      const header = `${note}${sessions.length} sessions (${indexSize} total indexed):\n\n`;

      return textResult(header + output, { resultCount: sessions.length, warming });
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
      if (!filePath.endsWith(".jsonl") && !filePath.includes("/")) {
        const index = usableIndex();
        if (typeof index === "string") return textResult(index);
        const entry = await index.get(filePath);
        if (entry) {
          filePath = entry.session.file;
        } else {
          const note = indexState === "warming" ? `\n\n${WARMING_NOTE}` : "";
          return textResult(
            `Session not found: "${params.session}". Use session_search or session_list to find the session file path.${note}`,
          );
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
        return textResult(
          `Access denied: path "${filePath}" is outside the allowed session directories.`,
        );
      }

      const limit = Math.min(params.limit ?? 50, 100);
      const output = readSessionConversation(filePath, {
        offset: params.offset ?? 0,
        limit,
        includeTools: params.include_tools ?? false,
      });

      return textResult(output, { file: filePath });
    },
  });
}

export { truncate, pathToSlug, formatRelativeDate } from "./utils";
export { slugToProject, buildSummary } from "./utils";
export { toFtsQuery, buildContent } from "./fts-index";
export { parseSession } from "./parser";
export { loadConfig } from "./config";
