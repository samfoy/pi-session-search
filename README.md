# pi-session-search

Index, summarize, and search past [pi](https://github.com/badlogic/pi-mono) coding sessions. Provides semantic search across your entire session history — both active and archived sessions.

## Features

- **Semantic search** — Find past sessions by topic, not just keywords (`session_search`)
- **Browse & filter** — List sessions by project, date range, archive status (`session_list`)
- **Read conversations** — View the full conversation from any past session (`session_read`)
- **Auto-indexing** — Parses JSONL session files on startup, tracks changes incrementally
- **Archive support** — Indexes both `~/.pi/agent/sessions/` and `~/.pi/agent/sessions-archive/`
- **Multiple embedders** — OpenAI, AWS Bedrock, or local Ollama

## Install

```bash
pi install pi-session-search
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:pi-session-search"]
}
```

## Setup

Run `/session-search-setup` in pi to configure the embedding provider:

- **OpenAI** — Uses `text-embedding-3-small` (needs `OPENAI_API_KEY`)
- **Bedrock** — Uses Titan Embeddings v2 (needs AWS credentials)
- **Ollama** — Uses `nomic-embed-text` (needs local Ollama running)

Config is stored at `~/.pi/session-search/config.json`.

## Usage

### Semantic search
```
session_search(query="how did we debug the Lambda timeout")
session_search(query="CI pipeline configuration", limit=5)
```

### Browse sessions
```
session_list(project="Rosie", after="2026-03-01")
session_list(archived=true, limit=20)
```

### Read a session
```
session_read(session="<file-path-or-uuid>")
session_read(session="<id>", offset=50, limit=50)
```

## Commands

| Command | Description |
|---------|-------------|
| `/session-search-setup` | Configure embedding provider |
| `/session-reindex` | Force full re-index of all sessions |

## How It Works

1. On startup, discovers all `.jsonl` session files in `~/.pi/agent/sessions/` (and `~/.pi/agent/sessions-archive/` if it exists)
2. Parses each session to extract: user messages, assistant text, tool calls, files modified, models used, compaction summaries
3. Generates a summary and embedding for each session
4. Stores the index at `~/.pi/session-search/index/`
5. On subsequent startups, only re-indexes new or changed sessions
6. Re-syncs in the background every 5 minutes to pick up new sessions

You can also configure extra session/archive directories during setup if you store sessions in non-default locations.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | Required for OpenAI embedder |

## License

MIT
