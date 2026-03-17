import { readFileSync } from "node:fs";

/**
 * Read a session JSONL file and format it as a readable conversation.
 * Supports offset/limit for pagination of large sessions.
 */
export function readSessionConversation(
  file: string,
  options?: { offset?: number; limit?: number; includeTools?: boolean }
): string {
  const offset = options?.offset ?? 0;
  const limit = options?.limit ?? 50;
  const includeTools = options?.includeTools ?? false;

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err: any) {
    return `Error reading session: ${err.message}`;
  }

  const lines = raw.trim().split("\n");
  const entries: any[] = [];
  let header: any = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === "session") {
        header = obj;
      } else {
        entries.push(obj);
      }
    } catch {
      // skip
    }
  }

  // Filter to conversation-relevant entries
  const conversationEntries = entries.filter((e) => {
    if (e.type === "message") {
      const role = e.message?.role;
      if (role === "user") return true;
      if (role === "assistant") return true;
      if (role === "toolResult" && includeTools) return true;
      return false;
    }
    if (e.type === "compaction") return true;
    if (e.type === "branch_summary") return true;
    if (e.type === "session_info") return true;
    if (e.type === "model_change") return true;
    return false;
  });

  const total = conversationEntries.length;
  const page = conversationEntries.slice(offset, offset + limit);

  const output: string[] = [];

  // Header
  if (header) {
    output.push(
      `Session: ${header.id}\nStarted: ${header.timestamp}\nCWD: ${header.cwd}`
    );
    output.push(`Total entries: ${total} (showing ${offset + 1}-${Math.min(offset + limit, total)})`);
    output.push("---");
  }

  for (const entry of page) {
    const ts = entry.timestamp
      ? new Date(entry.timestamp).toLocaleString()
      : "";

    switch (entry.type) {
      case "message": {
        const msg = entry.message;
        if (msg.role === "user") {
          const text = extractText(msg.content);
          output.push(`\n**User** (${ts}):\n${text}`);
        } else if (msg.role === "assistant") {
          const text = extractAssistantText(msg.content);
          const model = msg.model ? ` [${msg.provider}/${msg.model}]` : "";
          output.push(`\n**Assistant**${model} (${ts}):\n${text}`);

          // Show tool calls as summaries
          if (Array.isArray(msg.content)) {
            const calls = msg.content.filter(
              (b: any) => b.type === "toolCall"
            );
            if (calls.length > 0) {
              const callList = calls
                .map(
                  (c: any) =>
                    `  → ${c.name}(${summarizeArgs(c.arguments)})`
                )
                .join("\n");
              output.push(callList);
            }
          }
        } else if (msg.role === "toolResult" && includeTools) {
          const text = extractText(msg.content);
          const truncated =
            text.length > 500 ? text.slice(0, 500) + "…" : text;
          const err = msg.isError ? " ❌" : "";
          output.push(
            `\n  **${msg.toolName}** result${err} (${ts}):\n  ${truncated}`
          );
        }
        break;
      }

      case "compaction":
        output.push(
          `\n--- Compaction (${ts}) ---\n${entry.summary?.slice(0, 1000) ?? "(no summary)"}`
        );
        break;

      case "branch_summary":
        output.push(
          `\n--- Branch Summary (${ts}) ---\n${entry.summary?.slice(0, 500) ?? "(no summary)"}`
        );
        break;

      case "model_change":
        output.push(
          `\n*Model changed to ${entry.provider}/${entry.modelId}* (${ts})`
        );
        break;

      case "session_info":
        output.push(`\n*Session renamed to: ${entry.name}* (${ts})`);
        break;
    }
  }

  // Pagination hint
  if (offset + limit < total) {
    output.push(
      `\n--- ${total - offset - limit} more entries. Use offset=${offset + limit} to continue. ---`
    );
  }

  return output.join("\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");
  }
  return "";
}

function extractAssistantText(content: any): string {
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");
}

function summarizeArgs(args: Record<string, any>): string {
  if (!args) return "";
  const parts: string[] = [];
  for (const [key, val] of Object.entries(args)) {
    if (typeof val === "string") {
      parts.push(`${key}="${val.length > 60 ? val.slice(0, 60) + "…" : val}"`);
    } else {
      parts.push(`${key}=${JSON.stringify(val)?.slice(0, 40)}`);
    }
  }
  return parts.join(", ");
}
