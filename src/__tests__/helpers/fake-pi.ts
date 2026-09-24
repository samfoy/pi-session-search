/**
 * Minimal pi host for driving the extension's lifecycle in tests: a temp
 * project whose .pi/settings.json points pi-session-search at a temp base
 * (config + index), with session dirs inside the same tree.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeHost {
  root: string;
  sessionsDir: string;
  indexDir: string;
  sent: { message: any; options: any }[];
  notes: string[];
  start(): Promise<void>;
  shutdown(): Promise<void>;
  tool(name: string, params: Record<string, unknown>): Promise<string>;
  cleanup(): void;
}

export function writeSession(dir: string, id: string, userMsg: string, extraLines: string[] = []): void {
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "session", version: 1, id, timestamp: "2026-01-15T10:00:00Z", cwd: "/tmp/proj" }),
    JSON.stringify({
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2026-01-15T10:00:01Z",
      message: { role: "user", content: [{ type: "text", text: userMsg }] },
    }),
    ...extraLines,
  ];
  writeFileSync(join(dir, `${id}.jsonl`), lines.join("\n"), "utf8");
}

export function createFakeHost(
  root: string,
  extension: (pi: any) => void,
  config: Record<string, unknown> = {},
): FakeHost {
  rmSync(root, { recursive: true, force: true });
  const base = join(root, "base");
  const sessionsDir = join(root, "sessions", "--tmp-proj--");
  mkdirSync(join(root, ".pi"), { recursive: true });
  mkdirSync(base, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(root, ".pi", "settings.json"),
    JSON.stringify({ "pi-session-search": { localPath: base } }),
  );
  writeFileSync(
    join(base, "config.json"),
    JSON.stringify({
      sessionDir: join(root, "sessions"),
      archiveDir: join(root, "archive"),
      sync: { interval: -1 },
      ...config,
    }),
  );

  const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
  const tools = new Map<string, any>();
  const sent: { message: any; options: any }[] = [];
  const notes: string[] = [];
  extension({
    on: (event: string, fn: any) => handlers.set(event, fn),
    registerTool: (t: any) => tools.set(t.name, t),
    registerCommand: () => {},
    sendMessage: (message: any, options: any) => sent.push({ message, options }),
  });
  const ctx = {
    cwd: root,
    hasUI: true,
    ui: { notify: (m: string) => notes.push(m), setStatus: () => {} },
    sessionManager: { getEntries: () => [] },
  };

  return {
    root,
    sessionsDir,
    indexDir: join(base, "index"),
    sent,
    notes,
    start: async () => handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx),
    shutdown: async () => handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx),
    tool: async (name, params) => (await tools.get(name).execute("call", params)).content[0].text,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Poll a tool until its text no longer carries the warming note. */
export async function untilWarm(host: FakeHost, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await host.tool("session_list", { limit: 50 });
    if (!/index warming/.test(text)) return text;
    if (Date.now() > deadline) throw new Error(`index still warming after ${timeoutMs}ms: ${text}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
