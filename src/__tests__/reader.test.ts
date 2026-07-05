import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// ─── Imports under test ──────────────────────────────────────────────

import {
  readSessionConversation,
  DEFAULT_MAX_ASSISTANT_CHARS,
  DEFAULT_MAX_OUTPUT_CHARS,
} from "../reader";

// ─── Fixtures ────────────────────────────────────────────────────────

const dir = join(tmpdir(), `reader-test-${process.pid}`);

function sessionFile(name: string, entries: object[]): string {
  const file = join(dir, name);
  const header = {
    type: "session",
    version: 3,
    id: "00000000-0000-0000-0000-000000000000",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/project",
  };
  writeFileSync(
    file,
    [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n"
  );
  return file;
}

function userMsg(text: string): object {
  return {
    type: "message",
    timestamp: "2026-01-01T00:01:00.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function assistantMsg(text: string): object {
  return {
    type: "message",
    timestamp: "2026-01-01T00:02:00.000Z",
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude-x",
      content: [
        { type: "text", text },
        { type: "toolCall", name: "bash", arguments: { command: "ls -la" } },
      ],
    },
  };
}

before(() => mkdirSync(dir, { recursive: true }));
after(() => rmSync(dir, { recursive: true, force: true }));

// ─── Assistant truncation ────────────────────────────────────────────

describe("readSessionConversation assistant truncation", () => {
  it("truncates assistant text beyond maxAssistantChars with a marker", () => {
    const long = "assistant prose ".repeat(100); // 1600 chars
    const file = sessionFile("truncate.jsonl", [userMsg("hi"), assistantMsg(long)]);
    const out = readSessionConversation(file);

    assert.ok(out.includes("verbatim=true for full text"));
    assert.ok(!out.includes(long));
    const marker = `[+${long.length - DEFAULT_MAX_ASSISTANT_CHARS} chars`;
    assert.ok(out.includes(marker), `expected marker ${marker}`);
  });

  it("keeps short assistant text and tool-call summaries intact", () => {
    const file = sessionFile("short.jsonl", [assistantMsg("done, all green")]);
    const out = readSessionConversation(file);

    assert.ok(out.includes("done, all green"));
    assert.ok(out.includes('→ bash(command="ls -la")'));
    assert.ok(!out.includes("verbatim=true"));
  });

  it("never truncates user text", () => {
    const long = "my own words ".repeat(200); // 2600 chars
    const file = sessionFile("user.jsonl", [userMsg(long)]);
    const out = readSessionConversation(file);

    assert.ok(out.includes(long));
  });

  it("maxAssistantChars=Infinity disables truncation", () => {
    const long = "assistant prose ".repeat(100);
    const file = sessionFile("verbatim.jsonl", [assistantMsg(long)]);
    const out = readSessionConversation(file, { maxAssistantChars: Infinity });

    assert.ok(out.includes(long));
    assert.ok(!out.includes("verbatim=true"));
  });
});

// ─── Output cap ──────────────────────────────────────────────────────

describe("readSessionConversation output cap", () => {
  it("stops at an entry boundary and emits an exact resume offset", () => {
    const entries = Array.from({ length: 40 }, (_, i) =>
      userMsg(`message ${i}: ${"x".repeat(400)}`)
    );
    const file = sessionFile("cap.jsonl", entries);
    const out = readSessionConversation(file, { maxOutputChars: 2000 });

    const match = out.match(/Output cap reached: showing (\d+) of 40 entries\. Use offset=(\d+) to continue\./);
    assert.ok(match, "expected output-cap pagination hint");
    const shown = Number(match![1]);
    assert.equal(Number(match![2]), shown);
    // Every shown entry is complete, the first non-shown one is absent.
    assert.ok(out.includes(`message ${shown - 1}:`));
    assert.ok(!out.includes(`message ${shown}:`));
  });

  it("resume offset accounts for a non-zero starting offset", () => {
    const entries = Array.from({ length: 40 }, (_, i) =>
      userMsg(`message ${i}: ${"x".repeat(400)}`)
    );
    const file = sessionFile("cap-offset.jsonl", entries);
    const out = readSessionConversation(file, { offset: 10, maxOutputChars: 2000 });

    const match = out.match(/showing (\d+) of 40 entries\. Use offset=(\d+) to continue\./);
    assert.ok(match);
    assert.equal(Number(match![2]), 10 + Number(match![1]));
    assert.ok(out.includes("message 10:"));
  });

  it("still makes progress when a single entry exceeds the cap", () => {
    const file = sessionFile("oversized.jsonl", [
      userMsg("z".repeat(30_000)),
      userMsg("next entry"),
    ]);
    const out = readSessionConversation(file, { maxOutputChars: 1000 });

    assert.ok(out.includes("[entry truncated to fit output cap]"));
    assert.ok(!out.includes("next entry"));
    assert.ok(out.includes("Use offset=1 to continue"));
  });

  it("keeps the plain pagination hint when under the cap", () => {
    const entries = Array.from({ length: 10 }, (_, i) => userMsg(`m${i}`));
    const file = sessionFile("page.jsonl", entries);
    const out = readSessionConversation(file, { limit: 4 });

    assert.ok(out.includes("--- 6 more entries. Use offset=4 to continue. ---"));
    assert.ok(!out.includes("Output cap reached"));
  });

  it("caps a default read of a transcript-heavy session near DEFAULT_MAX_OUTPUT_CHARS", () => {
    // Worst case that motivated the cap: ~30KB of verbatim assistant prose.
    const entries = Array.from({ length: 60 }, (_, i) =>
      assistantMsg(`reply ${i}: ${"verbatim model output ".repeat(30)}`)
    );
    const file = sessionFile("heavy.jsonl", entries);
    const out = readSessionConversation(file);

    assert.ok(out.length < DEFAULT_MAX_OUTPUT_CHARS + 1000, `got ${out.length} chars`);
  });

  it("maxOutputChars=Infinity disables the cap", () => {
    const entries = Array.from({ length: 30 }, (_, i) =>
      userMsg(`message ${i}: ${"x".repeat(800)}`)
    );
    const file = sessionFile("nocap.jsonl", entries);
    const out = readSessionConversation(file, { maxOutputChars: Infinity });

    assert.ok(out.includes("message 29:"));
    assert.ok(!out.includes("Output cap reached"));
  });
});
