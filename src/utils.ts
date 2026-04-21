/**
 * Shared utility functions used across the session search package.
 */

/** Truncate a string to `max` characters, appending "…" if truncated. */
export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

/**
 * Convert a project slug (e.g. "--Users-sam-Projects-foo--") back to a
 * human-readable path ("Users/sam/Projects/foo").
 */
export function slugToProject(slug: string): string {
  if (!slug.startsWith("--") || !slug.endsWith("--")) return slug;
  return slug.slice(2, -2).replace(/-/g, "/");
}

/** Format an ISO date as a relative time string (e.g. "2h ago", "3d ago"). */
export function formatRelativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = now - then;
  if (diffMs < 0) return "just now";

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return "1d ago";
  if (days < 7) return `${days}d ago`;
  if (days < 14) return "last week";

  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;

  const months = Math.floor(days / 30);
  return months <= 1 ? "last month" : `${months}mo ago`;
}

/** Convert a cwd path to a project slug for filtering. */
export function pathToSlug(cwd: string): string {
  const home = process.env.HOME || "";
  const rel = cwd.startsWith(home) ? cwd.slice(home.length + 1) : cwd;
  return rel.replace(/\//g, "-");
}

import type { ParsedSession } from "./parser";

/** Build a display summary for a session. */
export function buildSummary(s: ParsedSession): string {
  const lines: string[] = [];
  const name = s.name || truncate(s.firstUserMessage, 80);
  const date = s.startedAt.split("T")[0];
  const project = slugToProject(s.projectSlug);

  lines.push(`**${name}** (${date})`);
  lines.push(`Project: ${project} | CWD: ${s.cwd}`);
  lines.push(
    `Messages: ${s.userMessageCount} user, ${s.assistantMessageCount} assistant`
  );

  if (s.models?.length) {
    lines.push(`Models: ${s.models.join(", ")}`);
  }

  if (s.toolCalls?.length) {
    const top = s.toolCalls
      .slice(0, 5)
      .map((t) => `${t.name}(${t.count})`)
      .join(", ");
    lines.push(`Tools: ${top}`);
  }

  if (s.filesModified?.length) {
    lines.push(`Modified: ${s.filesModified.slice(0, 10).join(", ")}`);
  }

  if (s.compactionSummaries?.length) {
    lines.push(`\nCompaction summaries:`);
    for (const cs of s.compactionSummaries) {
      lines.push(truncate(cs, 500));
    }
  }

  if (s.archived) {
    lines.push(`(archived)`);
  }

  return lines.join("\n");
}
