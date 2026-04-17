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

const CONFIG_DIR = join(process.env.HOME || "~", ".pi", "session-search");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const INDEX_DIR = join(CONFIG_DIR, "index");

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function getIndexDir(): string {
  return INDEX_DIR;
}

// ─── Load / Save ─────────────────────────────────────────────────────

export function loadConfig(): Config | null {
  if (!existsSync(CONFIG_FILE)) return null;

  const raw = readFileSync(CONFIG_FILE, "utf8");
  const file = JSON.parse(raw) as ConfigFile;

  return {
    extraSessionDirs: file.extraSessionDirs ?? [],
    extraArchiveDirs: file.extraArchiveDirs ?? [],
    embedder: file.embedder,
  };
}

export function saveConfig(file: ConfigFile): void {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(file, null, 2), "utf8");
}
