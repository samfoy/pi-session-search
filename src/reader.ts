import { readFileSync } from "node:fs";

/**
 * Default cap on rendered assistant text per message. Verbatim assistant
 * prose is rarely what the calling agent needs (facts survive truncation),
 * and large blocks of it are hazardous: Anthropic's API classifier can
 * hard-block a request that contains tens of KB of model output as a
 * ToS violation ("duplicating model outputs"), permanently poisoning the
 * calling session. Tool results and compactions were already truncated;
 * assistant text was the only uncapped entry type.
 */
export const DEFAULT_MAX_ASSISTANT_CHARS = 500;

/** Default cap on total rendered output per call. */
export const DEFAULT_MAX_OUTPUT_CHARS = 10_000;

/**
 * Read a session JSONL file and format it as a readable conversation.
 * Supports offset/limit for pagination of large sessions.
 *
 * Output is size-bounded by default: assistant text is truncated per
 * message (`maxAssistantChars`) and the whole call stops at an entry
 * boundary once `maxOutputChars` is reached, emitting an exact resume
 * offset. Pass `Infinity` for either option to disable.
 */
export function readSessionConversation(
  file: string,
  options?: {
    offset?: number;
    limit?: number;
    includeTools?: boolean;
    maxAssistantChars?: number;
    maxOutputChars?: number;
  }
): string {
  const offset = options?.offset ?? 0;
  const limit = options?.limit ?? 50;
  const includeTools = options?.includeTools ?? false;
  const maxAssistantChars = options?.maxAssistantChars ?? DEFAULT_MAX_ASSISTANT_CHARS;
  const maxOutputChars = options?.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

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
    const cleaned = line.replace(/^\uFEFF/, "").trim();
    if (!cleaned) continue;
    try {
      const obj = JSON.parse(cleaned);
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

  let used = 0;
  let shown = 0;
  for (const entry of page) {
    let chunk = renderEntry(entry, { includeTools, maxAssistantChars });
    if (!chunk) {
      shown++;
      continue;
    }

    if (used + chunk.length > maxOutputChars) {
      if (shown === 0) {
        // A single oversized entry must still make progress.
        chunk = chunk.slice(0, maxOutputChars) + "… [entry truncated to fit output cap]";
        output.push(chunk);
        shown++;
      }
      break;
    }

    output.push(chunk);
    used += chunk.length;
    shown++;
  }

  // Pagination hint
  if (shown < page.length) {
    output.push(
      `\n--- Output cap reached: showing ${shown} of ${total} entries. Use offset=${offset + shown} to continue. ---`
    );
  } else if (offset + shown < total) {
    output.push(
      `\n--- ${total - offset - shown} more entries. Use offset=${offset + shown} to continue. ---`
    );
  }

  return output.join("\n");
}

function renderEntry(
  entry: any,
  opts: { includeTools: boolean; maxAssistantChars: number }
): string | null {
  const ts = entry.timestamp
    ? new Date(entry.timestamp).toLocaleString()
    : "";

  switch (entry.type) {
    case "message": {
      const msg = entry.message;
      if (msg.role === "user") {
        const text = extractText(msg.content);
        return `\n**User** (${ts}):\n${text}`;
      }
      if (msg.role === "assistant") {
        const full = extractAssistantText(msg.content);
        const text =
          full.length > opts.maxAssistantChars
            ? full.slice(0, opts.maxAssistantChars) +
              `… [+${full.length - opts.maxAssistantChars} chars, verbatim=true for full text]`
            : full;
        const model = msg.model ? ` [${msg.provider}/${msg.model}]` : "";
        const parts = [`\n**Assistant**${model} (${ts}):\n${text}`];

        // Show tool calls as summaries
        if (Array.isArray(msg.content)) {
          const calls = msg.content.filter(
            (b: any) => b.type === "toolCall"
          );
          if (calls.length > 0) {
            parts.push(
              calls
                .map(
                  (c: any) =>
                    `  → ${c.name}(${summarizeArgs(c.arguments)})`
                )
                .join("\n")
            );
          }
        }
        return parts.join("\n");
      }
      if (msg.role === "toolResult" && opts.includeTools) {
        const text = extractText(msg.content);
        const truncated =
          text.length > 500 ? text.slice(0, 500) + "…" : text;
        const err = msg.isError ? " ❌" : "";
        return `\n  **${msg.toolName}** result${err} (${ts}):\n  ${truncated}`;
      }
      return null;
    }

    case "compaction":
      return `\n--- Compaction (${ts}) ---\n${entry.summary?.slice(0, 1000) ?? "(no summary)"}`;

    case "branch_summary":
      return `\n--- Branch Summary (${ts}) ---\n${entry.summary?.slice(0, 500) ?? "(no summary)"}`;

    case "model_change":
      return `\n*Model changed to ${entry.provider}/${entry.modelId}* (${ts})`;

    case "session_info":
      return `\n*Session renamed to: ${entry.name}* (${ts})`;

    default:
      return null;
  }
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
