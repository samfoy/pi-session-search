---
name: session-history
description: Search, browse, and read past pi coding sessions. Use when the user asks about previous work, past decisions, what was done before, or wants to find a specific session. Covers both active and archived sessions.
---

# Session History

Search, browse, and introspect on past pi coding sessions — including archived ones.

## Available Tools

This skill provides three tools:

### session_search
Semantic search across all indexed sessions. Use for finding sessions by topic, technology, or intent.

```
session_search(query="refactoring the auth module")
session_search(query="Lambda timeout debugging", limit=5)
session_search(query="setting up CI pipeline for Nessie")
```

### session_list
Browse sessions with filters. Good for time-based queries or project-specific browsing.

```
session_list(project="Rosie")                    # Sessions in the Rosie project
session_list(after="2026-03-01", limit=10)       # Recent sessions
session_list(archived=true, limit=20)            # Archived sessions only
session_list(project="pi-slack-bot", after="2026-03-10")
```

### session_read
Read the full conversation from a specific session. Use the file path or UUID from search/list results.

```
session_read(session="~/.pi/agent/sessions/--workplace-samfp-Rosie--/2026-03-10T21-36-44.jsonl")
session_read(session="124c2fe2-820c-4d63-8899-eb8d48007d39")
session_read(session="...", offset=50, limit=50)           # Pagination for long sessions
session_read(session="...", include_tools=true)             # Include tool call results
```

## Workflow

1. **Find sessions**: Use `session_search` for semantic queries or `session_list` for browsing
2. **Read details**: Use `session_read` with the file path from results to see the full conversation
3. **Extract context**: Use information from past sessions to inform current work

## Setup

If not yet configured, run `/session-embeddings-setup` to choose an embedding provider (OpenAI, Bedrock, or Ollama).

To force a full re-index, run `/session-reindex`.

## What Gets Indexed

- All active sessions from `~/.pi/agent/sessions/`
- All archived sessions from `~/.pi/agent/sessions-archive/`
- User messages, assistant responses, tool usage patterns
- Compaction summaries (condensed session context)
- Files read/modified, models used, project directories

## Tips

- Session search is best for "when did we...", "how did we handle...", "what approach did we use for..." queries
- Session list is best for "show me recent sessions", "what did we work on in project X" queries
- For very long sessions, use `session_read` with pagination (`offset`/`limit`)
- Set `include_tools=true` on `session_read` when you need to see the actual tool outputs (verbose)
