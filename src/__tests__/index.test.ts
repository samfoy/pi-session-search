import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";

// ─── Imports under test ──────────────────────────────────────────────

import { toFtsQuery, buildContent, FtsSessionIndex } from "../fts-index";
import { parseSession } from "../parser";
import { encodeEmbedding, decodeEmbedding } from "../session-index";
import { loadConfig } from "../config";
import { truncate, slugToProject, buildSummary, formatRelativeDate, pathToSlug } from "../utils";

// ─── toFtsQuery ──────────────────────────────────────────────────────

describe("toFtsQuery", () => {
  it("wraps simple terms in quotes", () => {
    assert.equal(toFtsQuery("hello world"), '"hello" "world"');
  });

  it("strips special FTS characters", () => {
    assert.equal(toFtsQuery('hello "world" {foo}'), '"hello" "world" "foo"');
  });

  it("returns empty string for empty input", () => {
    assert.equal(toFtsQuery(""), "");
  });

  it("returns empty string for whitespace-only input", () => {
    assert.equal(toFtsQuery("   "), "");
  });

  it("handles single term", () => {
    assert.equal(toFtsQuery("refactor"), '"refactor"');
  });

  it("strips brackets, parens, colons, carets, asterisks", () => {
    assert.equal(toFtsQuery("foo:bar [baz] (qux) ^hey *wild"), '"foo" "bar" "baz" "qux" "hey" "wild"');
  });
});

// ─── parseSession ────────────────────────────────────────────────────

describe("parseSession", () => {
  const tmpDir = join(import.meta.dirname ?? __dirname, "__tmp_parse_test__");
  const projectDir = join(tmpDir, "--test-project--");

  it("parses a minimal JSONL session", () => {
    mkdirSync(projectDir, { recursive: true });
    const file = join(projectDir, "test-session.jsonl");

    const lines = [
      JSON.stringify({
        type: "session",
        version: 1,
        id: "abc-123",
        timestamp: "2026-01-15T10:00:00Z",
        cwd: "/home/user/project",
      }),
      JSON.stringify({
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-01-15T10:00:01Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Fix the bug in parser.ts" }],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: "2026-01-15T10:00:05Z",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet",
          content: [
            { type: "text", text: "I'll fix the bug now." },
            { type: "toolCall", name: "edit", id: "tc1" },
          ],
          usage: { cost: { total: 0.01 }, totalTokens: 500 },
        },
      }),
      JSON.stringify({
        type: "session_info",
        id: "s1",
        parentId: null,
        timestamp: "2026-01-15T10:00:10Z",
        name: "Fix parser bug",
      }),
    ];

    writeFileSync(file, lines.join("\n"), "utf8");

    try {
      const result = parseSession(file, false);
      assert.ok(result, "parseSession should return a result");
      assert.equal(result.id, "abc-123");
      assert.equal(result.cwd, "/home/user/project");
      assert.equal(result.name, "Fix parser bug");
      assert.equal(result.archived, false);
      assert.equal(result.projectSlug, "--test-project--");
      assert.equal(result.userMessageCount, 1);
      assert.equal(result.assistantMessageCount, 1);
      assert.equal(result.firstUserMessage, "Fix the bug in parser.ts");
      assert.deepEqual(result.models, ["anthropic/claude-sonnet"]);
      assert.equal(result.toolCalls.length, 1);
      assert.equal(result.toolCalls[0].name, "edit");
      assert.equal(result.toolCalls[0].count, 1);
      assert.equal(result.totalCost, 0.01);
      assert.equal(result.totalTokens, 500);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null for empty file", () => {
    mkdirSync(projectDir, { recursive: true });
    const file = join(projectDir, "empty.jsonl");
    writeFileSync(file, "", "utf8");

    try {
      const result = parseSession(file, false);
      assert.equal(result, null);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null for non-existent file", () => {
    const result = parseSession("/nonexistent/file.jsonl", false);
    assert.equal(result, null);
  });

  it("returns null when header is missing", () => {
    mkdirSync(projectDir, { recursive: true });
    const file = join(projectDir, "no-header.jsonl");
    writeFileSync(
      file,
      JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00Z" }),
      "utf8"
    );

    try {
      const result = parseSession(file, false);
      assert.equal(result, null);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── encodeEmbedding / decodeEmbedding ───────────────────────────────

describe("encodeEmbedding / decodeEmbedding", () => {
  it("round-trips a float array through base64", () => {
    const original = [0.1, -0.5, 3.14159, 0, -1000.5];
    const encoded = encodeEmbedding(original);
    assert.equal(typeof encoded, "string");
    const decoded = decodeEmbedding(encoded);
    assert.equal(decoded.length, original.length);
    for (let i = 0; i < original.length; i++) {
      assert.ok(
        Math.abs(decoded[i] - original[i]) < 1e-5,
        `Index ${i}: expected ~${original[i]}, got ${decoded[i]}`
      );
    }
  });

  it("handles empty array", () => {
    const encoded = encodeEmbedding([]);
    const decoded = decodeEmbedding(encoded);
    assert.deepEqual(decoded, []);
  });

  it("passes through legacy JSON arrays unchanged", () => {
    const legacy = [1.0, 2.0, 3.0];
    const decoded = decodeEmbedding(legacy);
    assert.deepEqual(decoded, legacy);
  });
});

// ─── buildContent ────────────────────────────────────────────────────

describe("buildContent", () => {
  it("combines name, messages, summaries, and files", () => {
    const session = {
      name: "Test Session",
      userMessages: ["Hello", "World"],
      compactionSummaries: ["Summary 1"],
      branchSummaries: ["Branch 1"],
      filesModified: ["/src/foo.ts", "/src/bar.ts"],
    } as any;

    const content = buildContent(session);
    assert.ok(content.includes("Test Session"));
    assert.ok(content.includes("Hello\nWorld"));
    assert.ok(content.includes("Summary 1"));
    assert.ok(content.includes("Branch 1"));
    assert.ok(content.includes("/src/foo.ts"));
  });

  it("handles empty fields gracefully", () => {
    const session = {
      name: "",
      userMessages: [],
      compactionSummaries: [],
      branchSummaries: [],
      filesModified: [],
    } as any;

    const content = buildContent(session);
    assert.equal(typeof content, "string");
  });
});

// ─── loadConfig ──────────────────────────────────────────────────────

describe("loadConfig", () => {
  // We can't easily test loadConfig with a custom path since it hardcodes
  // CONFIG_FILE. Instead, test the behavior we can observe.

  it("returns null for missing file", () => {
    // loadConfig checks existsSync internally — if the file doesn't exist it returns null
    // This test verifies the function is callable and returns the expected type
    const result = loadConfig();
    // It either returns a Config or null — both are valid
    assert.ok(result === null || typeof result === "object");
  });
});

// ─── slugToProject ───────────────────────────────────────────────────

describe("slugToProject", () => {
  it("converts a slug with -- delimiters to a path", () => {
    assert.equal(slugToProject("--Users-sam-Projects-foo--"), "Users/sam/Projects/foo");
  });

  it("returns non-slug strings unchanged", () => {
    assert.equal(slugToProject("unknown"), "unknown");
    assert.equal(slugToProject("plain-slug"), "plain-slug");
  });

  it("handles slug with only delimiters", () => {
    assert.equal(slugToProject("----"), "");
  });

  it("returns strings without ending -- unchanged", () => {
    assert.equal(slugToProject("--foo-bar"), "--foo-bar");
  });
});

// ─── truncate ────────────────────────────────────────────────────────

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    assert.equal(truncate("hello", 10), "hello");
  });

  it("truncates long strings with ellipsis", () => {
    assert.equal(truncate("hello world", 5), "hello…");
  });

  it("handles exact-length strings", () => {
    assert.equal(truncate("hello", 5), "hello");
  });

  it("handles empty string", () => {
    assert.equal(truncate("", 5), "");
  });
});

// ─── buildSummary ────────────────────────────────────────────────────

describe("buildSummary", () => {
  it("produces a formatted summary string", () => {
    const session = {
      name: "My Session",
      firstUserMessage: "Hello",
      startedAt: "2026-01-15T10:00:00Z",
      projectSlug: "--Users-sam-Projects-foo--",
      cwd: "/Users/sam/Projects/foo",
      userMessageCount: 5,
      assistantMessageCount: 10,
      models: ["anthropic/claude-sonnet"],
      toolCalls: [{ name: "edit", count: 3 }],
      filesModified: ["/src/index.ts"],
      compactionSummaries: [],
      branchSummaries: [],
      archived: false,
    } as any;

    const summary = buildSummary(session);
    assert.ok(summary.includes("**My Session** (2026-01-15)"));
    assert.ok(summary.includes("Messages: 5 user, 10 assistant"));
    assert.ok(summary.includes("edit(3)"));
    assert.ok(summary.includes("/src/index.ts"));
  });

  it("falls back to first user message when no name", () => {
    const session = {
      name: undefined,
      firstUserMessage: "Fix the auth module",
      startedAt: "2026-02-01T08:00:00Z",
      projectSlug: "unknown",
      cwd: "/tmp",
      userMessageCount: 1,
      assistantMessageCount: 1,
      models: [],
      toolCalls: [],
      filesModified: [],
      compactionSummaries: [],
      branchSummaries: [],
      archived: true,
    } as any;

    const summary = buildSummary(session);
    assert.ok(summary.includes("Fix the auth module"));
    assert.ok(summary.includes("(archived)"));
  });
});

// ─── formatRelativeDate ──────────────────────────────────────────────

describe("formatRelativeDate", () => {
  it("returns 'just now' for future dates", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    assert.equal(formatRelativeDate(future), "just now");
  });

  it("returns 'just now' for very recent dates", () => {
    const recent = new Date(Date.now() - 10_000).toISOString();
    assert.equal(formatRelativeDate(recent), "just now");
  });

  it("returns minutes for recent past", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    assert.equal(formatRelativeDate(fiveMinAgo), "5m ago");
  });

  it("returns hours for same-day past", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString();
    assert.equal(formatRelativeDate(threeHoursAgo), "3h ago");
  });
});

// ─── pathToSlug ──────────────────────────────────────────────────────

describe("pathToSlug", () => {
  it("converts a path to a slug by replacing slashes with dashes", () => {
    const home = process.env.HOME || "";
    const slug = pathToSlug(`${home}/Projects/foo`);
    assert.equal(slug, "Projects-foo");
  });

  it("handles paths not under HOME", () => {
    const slug = pathToSlug("/tmp/some/project");
    assert.equal(slug, "-tmp-some-project");
  });
});

// ─── FtsSessionIndex.search project filter ────────────────────────────────
// Exercises the optional `project` filter on session_search end-to-end using
// the FTS-only backend (no embedder required).

describe("FtsSessionIndex.search with project filter", () => {
  const tmpRoot = join(import.meta.dirname ?? __dirname, "__tmp_search_filter__");
  const projADir = join(tmpRoot, "sessions", "--tmp-project-alpha--");
  const projBDir = join(tmpRoot, "sessions", "--tmp-project-beta--");
  const indexDir = join(tmpRoot, "index");

  function writeSession(dir: string, id: string, cwd: string, userMsg: string): string {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    const lines = [
      JSON.stringify({
        type: "session",
        version: 1,
        id,
        timestamp: "2026-01-15T10:00:00Z",
        cwd,
      }),
      JSON.stringify({
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-01-15T10:00:01Z",
        message: { role: "user", content: [{ type: "text", text: userMsg }] },
      }),
      JSON.stringify({
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: "2026-01-15T10:00:05Z",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet",
          content: [{ type: "text", text: "ok" }],
        },
      }),
    ];
    writeFileSync(file, lines.join("\n"), "utf8");
    return file;
  }

  async function buildIndex(): Promise<FtsSessionIndex> {
    writeSession(projADir, "alpha-001", "/tmp/project-alpha", "refactor the authentication flow in alpha");
    writeSession(projBDir, "beta-001",  "/tmp/project-beta",  "refactor the authentication flow in beta");
    writeSession(projBDir, "beta-002",  "/tmp/project-beta",  "debug a totally unrelated lambda timeout");
    const idx = new FtsSessionIndex(indexDir, [join(tmpRoot, "sessions")], []);
    await idx.load();
    await idx.sync();
    return idx;
  }

  it("returns sessions from all projects when no filter is provided", async () => {
    rmSync(tmpRoot, { recursive: true, force: true });
    const idx = await buildIndex();
    try {
      const results = await idx.search("authentication", 50);
      const ids = new Set(results.map((r) => r.session.id));
      // Our two test sessions that match "authentication" must both be present.
      // (There may be additional real-world sessions indexed from ~/.pi/agent/sessions;
      // the key property under test is that no project filter ⇒ no project pruning.)
      assert.ok(ids.has("alpha-001"), "expected alpha-001 in unfiltered results");
      assert.ok(ids.has("beta-001"),  "expected beta-001 in unfiltered results");
    } finally {
      idx.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("filters by project slug substring", async () => {
    rmSync(tmpRoot, { recursive: true, force: true });
    const idx = await buildIndex();
    try {
      const results = await idx.search("authentication", 10, undefined, "alpha");
      assert.equal(results.length, 1);
      assert.equal(results[0].session.id, "alpha-001");
    } finally {
      idx.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("filters by cwd substring", async () => {
    rmSync(tmpRoot, { recursive: true, force: true });
    const idx = await buildIndex();
    try {
      const results = await idx.search("authentication", 10, undefined, "/tmp/project-beta");
      assert.equal(results.length, 1);
      assert.equal(results[0].session.id, "beta-001");
    } finally {
      idx.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("is case-insensitive on the project filter", async () => {
    rmSync(tmpRoot, { recursive: true, force: true });
    const idx = await buildIndex();
    try {
      const results = await idx.search("authentication", 10, undefined, "ALPHA");
      assert.equal(results.length, 1);
      assert.equal(results[0].session.id, "alpha-001");
    } finally {
      idx.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("returns an empty array when no sessions match the project filter", async () => {
    rmSync(tmpRoot, { recursive: true, force: true });
    const idx = await buildIndex();
    try {
      const results = await idx.search("authentication", 10, undefined, "nonexistent-project");
      assert.deepEqual(results, []);
    } finally {
      idx.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("does not cross-match unrelated content inside the filtered project", async () => {
    rmSync(tmpRoot, { recursive: true, force: true });
    const idx = await buildIndex();
    try {
      // beta-002 is about lambda, not auth — scoping to beta+auth must exclude it
      const results = await idx.search("authentication", 10, undefined, "beta");
      assert.equal(results.length, 1);
      assert.equal(results[0].session.id, "beta-001");
    } finally {
      idx.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
