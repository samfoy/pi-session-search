import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverSessionFiles } from "../parser";

// Minimal valid JSONL session header
const SESSION_HEADER = JSON.stringify({
  type: "session",
  version: 1,
  id: "test-id-1",
  timestamp: new Date().toISOString(),
  cwd: "/tmp",
});

function makeSessionFile(dir: string, name = "test.jsonl"): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, SESSION_HEADER + "\n");
  return file;
}

describe("discoverSessionFiles", () => {
  let tmpBase: string;

  before(() => {
    tmpBase = join(tmpdir(), `pi-session-search-test-${Date.now()}`);
  });

  after(() => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("finds sessions via PI_SESSION_DIR env var", () => {
    const customDir = join(tmpBase, "custom-sessions");
    const defaultDir = join(tmpBase, "default-sessions");
    makeSessionFile(customDir, "custom.jsonl");
    makeSessionFile(defaultDir, "default.jsonl");

    const saved = process.env.PI_SESSION_DIR;
    process.env.PI_SESSION_DIR = customDir;
    try {
      const results = discoverSessionFiles([], [], undefined, undefined);
      // Should find the custom dir (via env var), not the default
      const files = results.map((r) => r.file);
      assert.ok(
        files.some((f) => f.includes("custom.jsonl")),
        "should find file in PI_SESSION_DIR",
      );
      assert.ok(
        !files.some((f) => f.includes("default.jsonl")),
        "should NOT find file in unrelated default dir when PI_SESSION_DIR is set",
      );
    } finally {
      if (saved === undefined) delete process.env.PI_SESSION_DIR;
      else process.env.PI_SESSION_DIR = saved;
    }
  });

  it("explicit sessionDir param overrides env var", () => {
    const envDir = join(tmpBase, "env-sessions");
    const explicitDir = join(tmpBase, "explicit-sessions");
    makeSessionFile(envDir, "env.jsonl");
    makeSessionFile(explicitDir, "explicit.jsonl");

    const saved = process.env.PI_SESSION_DIR;
    process.env.PI_SESSION_DIR = envDir;
    try {
      const results = discoverSessionFiles([], [], explicitDir, undefined);
      const files = results.map((r) => r.file);
      assert.ok(
        files.some((f) => f.includes("explicit.jsonl")),
        "should find file in explicit sessionDir",
      );
      assert.ok(
        !files.some((f) => f.includes("env.jsonl")),
        "should NOT find env dir file when explicit sessionDir is set",
      );
    } finally {
      if (saved === undefined) delete process.env.PI_SESSION_DIR;
      else process.env.PI_SESSION_DIR = saved;
    }
  });

  it("finds archive sessions via PI_SESSION_ARCHIVE_DIR env var", () => {
    const customArchive = join(tmpBase, "custom-archive");
    makeSessionFile(customArchive, "archived.jsonl");

    const savedS = process.env.PI_SESSION_DIR;
    const savedA = process.env.PI_SESSION_ARCHIVE_DIR;
    // Point session dir at empty location to avoid noise
    process.env.PI_SESSION_DIR = join(tmpBase, "nonexistent");
    process.env.PI_SESSION_ARCHIVE_DIR = customArchive;
    try {
      const results = discoverSessionFiles([], []);
      const archiveResults = results.filter((r) => r.archived);
      assert.ok(
        archiveResults.some((r) => r.file.includes("archived.jsonl")),
        "should find archived file via PI_SESSION_ARCHIVE_DIR",
      );
    } finally {
      if (savedS === undefined) delete process.env.PI_SESSION_DIR;
      else process.env.PI_SESSION_DIR = savedS;
      if (savedA === undefined) delete process.env.PI_SESSION_ARCHIVE_DIR;
      else process.env.PI_SESSION_ARCHIVE_DIR = savedA;
    }
  });
});
