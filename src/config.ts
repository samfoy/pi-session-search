import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { EmbedderConfig } from "./embedder";

// ─── Types ───────────────────────────────────────────────────────────

export interface Config {
  /** Extra session directories to scan (in addition to default) */
  extraSessionDirs: string[];
  /** Extra archive directories to scan (in addition to default) */
  extraArchiveDirs: string[];
  /** Optional embedder configuration — enables hybrid search when set */
  embedder?: EmbedderConfig;
}

export interface ConfigFile {
  extraSessionDirs?: string[];
  extraArchiveDirs?: string[];
  embedder?: EmbedderConfig;
}

// ─── Paths ───────────────────────────────────────────────────────────

// Lazy lookups so HOME changes at runtime (tests, sandboxes) are honored.
function globalConfigDir(): string {
  return join(process.env.HOME || "~", ".pi", "session-search");
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
export function resolveLocalBase(cwd?: string): string | null {
  if (!cwd) return null;
  try {
    const raw = readFileSync(join(cwd, ".pi", "settings.json"), "utf-8");
    const settings = JSON.parse(raw) ?? {};

    // Package-specific override wins.
    const ss = settings["pi-session-search"];
    if (ss && typeof ss === "object" && typeof ss.localPath === "string" && ss.localPath) {
      return ss.localPath;
    }

    // pi-total-recall cascade.
    const tr = settings["pi-total-recall"];
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

  return {
    extraSessionDirs: file.extraSessionDirs ?? [],
    extraArchiveDirs: file.extraArchiveDirs ?? [],
    embedder: file.embedder,
  };
}

export function saveConfig(file: ConfigFile, cwd?: string): void {
  const configFile = getConfigPath(cwd);
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify(file, null, 2), "utf8");
}
