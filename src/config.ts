import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { EmbedderConfig } from "./embedder";

// ─── Types ───────────────────────────────────────────────────────────

/** Default interval (ms) between automatic session index re-syncs. */
export const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Default delay (ms) before the initial startup sync fires (0 = immediate). */
export const DEFAULT_INITIAL_DELAY_MS = 0;

/** Sync behaviour configuration. Mirrors EmbedderConfig nesting pattern. */
export interface SyncConfig {
  /**
   * Interval (ms) between automatic session index re-syncs.
   *
   * - Positive value: sync fires every N milliseconds.
   * - `-1`: disables periodic auto-sync entirely (initial startup sync still runs).
   * - Any other non-positive value falls back to the default (5 min) with a warning.
   *
   * @default 300000 (5 minutes when sync node is absent)
   */
  interval?: number;
  /**
   * Delay (ms) before the initial startup sync fires after loading the index.
   *
   * - Positive value: wait N milliseconds before running the first sync.
   * - `0`: run immediately (default).
   * - `-1`: skip the initial startup sync entirely.
   * - Any other non-positive value falls back to the default (immediate) with a warning.
   *
   * @default 0 (immediate)
   */
  initialDelay?: number;
  /**
   * When true, automatically disable all sync (both initial and periodic)
   * if this pi process is detected as a subagent child or non-interactive
   * programmatic invocation.
   *
   * Detection signals (any one triggers):
   * - `PI_SUBAGENT_DEPTH > 0` (official pi-subagents child marker)
   * - `!process.stdin.isTTY` (non-interactive terminal)
   *
   * Useful for suppressing background sync in CI/CD pipelines, automated
   * tooling, or nested agent workflows where sync would waste resources.
   *
   * @default false
   */
  disableForChild?: boolean;
}

export interface Config {
  /** Extra session directories to scan (in addition to default) */
  extraSessionDirs: string[];
  /** Extra archive directories to scan (in addition to default) */
  extraArchiveDirs: string[];
  /** Optional sync configuration — controls periodic re-sync behaviour. */
  sync?: SyncConfig;
  /** Optional embedder configuration — enables hybrid search when set */
  embedder?: EmbedderConfig;
}

export interface ConfigFile {
  extraSessionDirs?: string[];
  extraArchiveDirs?: string[];
  /** Nested sync settings. */
  sync?: {
    /** Interval in ms; -1 disables auto-sync; other non-positive values fall back to default. */
    interval?: number;
    /** Delay in ms before initial sync; 0 = immediate, -1 = skip entirely. */
    initialDelay?: number;
    /** Auto-disable sync when running as a subagent child or non-interactively. */
    disableForChild?: boolean;
  };
  embedder?: EmbedderConfig;
}

// ─── Paths ───────────────────────────────────────────────────────────

// Lazy lookups so HOME changes at runtime (tests, sandboxes) are honored.
function globalConfigDir(): string {
  return join(homedir(), ".pi", "session-search");
}
function globalConfigFile(): string {
  return join(globalConfigDir(), "config.json");
}
function globalIndexDir(): string {
  return join(globalConfigDir(), "index");
}

/**
 * Resolve a project-local base directory for pi-session-search storage.
 *
 * Resolution order (highest priority first):
 *   1. {cwd}/.pi/settings.json → "pi-session-search".localPath
 *   2. {cwd}/.pi/settings.json → "pi-total-recall".localPath → {localPath}/session-search
 *
 * When set, config is stored at {base}/config.json and index at {base}/index.
 *
 * Intentionally does NOT relocate the session *source* directories
 * (~/.pi/agent/sessions, ~/.pi/agent/sessions-archive) — those are pi's
 * own session files and a project-local override would point at an empty
 * directory.
 *
 * Returns null when no project-local override is configured.
 */
/**
 * Emit a warning when a settings block contains keys outside a known
 * schema. Catches silent typos like `LocalPath` vs `localPath` — an unknown
 * key is usually a misspelled known key that got silently ignored, leaving
 * the user wondering why their config didn't take effect.
 *
 * Logs to stderr (console.error) since this runs at startup; ctx.ui isn't
 * reliably available here and the caller is in a code path that can't
 * easily surface a UI notification.
 */
function warnUnknownKeys(block: unknown, blockName: string, knownKeys: readonly string[]): void {
  if (!block || typeof block !== "object") return;
  const unknown = Object.keys(block as Record<string, unknown>).filter((k) => !knownKeys.includes(k));
  if (unknown.length === 0) return;
  console.error(
    `pi-session-search: ignoring unknown key(s) in settings.json "${blockName}" block: ${unknown.join(", ")} (expected: ${knownKeys.join(", ")})`,
  );
}

// Keys pi-session-search reads from settings.json. The bulk of config lives
// in a separate config.json (see getConfigPath) — only localPath comes from
// the settings.json block directly.
const PI_SESSION_SEARCH_SETTINGS_KEYS = ["localPath"] as const;
const PI_TOTAL_RECALL_KNOWN_KEYS = ["localPath"] as const;

export function resolveLocalBase(cwd?: string): string | null {
  if (!cwd) return null;
  try {
    const raw = readFileSync(join(cwd, ".pi", "settings.json"), "utf-8");
    const settings = JSON.parse(raw) ?? {};

    // Package-specific override wins.
    const ss = settings["pi-session-search"];
    warnUnknownKeys(ss, "pi-session-search", PI_SESSION_SEARCH_SETTINGS_KEYS);
    if (ss && typeof ss === "object" && typeof ss.localPath === "string" && ss.localPath) {
      return ss.localPath;
    }

    // pi-total-recall cascade.
    const tr = settings["pi-total-recall"];
    warnUnknownKeys(tr, "pi-total-recall", PI_TOTAL_RECALL_KNOWN_KEYS);
    if (tr && typeof tr === "object" && typeof tr.localPath === "string" && tr.localPath) {
      return join(tr.localPath, "session-search");
    }
  } catch {
    // No settings file, unreadable, or malformed — fall through to global.
  }
  return null;
}

export function getConfigPath(cwd?: string): string {
  const base = resolveLocalBase(cwd);
  if (base) return join(base, "config.json");
  return globalConfigFile();
}

export function getIndexDir(cwd?: string): string {
  const base = resolveLocalBase(cwd);
  if (base) return join(base, "index");
  return globalIndexDir();
}

// ─── Load / Save ─────────────────────────────────────────────────────

export function loadConfig(cwd?: string): Config | null {
  const configFile = getConfigPath(cwd);
  if (!existsSync(configFile)) return null;

  const raw = readFileSync(configFile, "utf8");
  let file: ConfigFile;
  try {
    file = JSON.parse(raw) as ConfigFile;
  } catch {
    return null;
  }

  const rawInterval = file.sync?.interval;
  const rawInitialDelay = file.sync?.initialDelay;
  const rawDisableForChild = file.sync?.disableForChild;
  let syncCfg: SyncConfig | undefined;
  const syncFields: SyncConfig = {};
  if (typeof rawInterval === "number") syncFields.interval = rawInterval;
  if (typeof rawInitialDelay === "number") syncFields.initialDelay = rawInitialDelay;
  if (typeof rawDisableForChild === "boolean") syncFields.disableForChild = rawDisableForChild;
  if (Object.keys(syncFields).length > 0) syncCfg = syncFields;

  return {
    extraSessionDirs: file.extraSessionDirs ?? [],
    extraArchiveDirs: file.extraArchiveDirs ?? [],
    sync: syncCfg,
    embedder: file.embedder,
  };
}

export function saveConfig(file: ConfigFile, cwd?: string): void {
  const configFile = getConfigPath(cwd);
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify(file, null, 2), "utf8");
}
