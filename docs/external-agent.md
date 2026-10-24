# External agent (MCP): teach with Claude Code instead of an API key

LearnHarness can be driven by an **external agent** over the Model Context Protocol. The app stays the classroom — transcript, question dock, plan map, knowledge graph — while an MCP client you already run (for example **Claude Code on a Claude Pro/Max subscription**) is the teacher. No model slot or provider key is needed in the app.

## Setup

```bash
npm install
LH_EXTERNAL_AGENT=1 npm run dev          # app on http://localhost:3000
claude mcp add --transport http learnharness http://localhost:3000/api/mcp
```

Optional: install the bundled Claude Code command so `/learnharness` starts the teaching loop from any directory:

```bash
mkdir -p ~/.claude/commands
cp integrations/claude-code/learnharness.md ~/.claude/commands/
```

## Using it

Two ways to start a session:

1. **From Claude Code:** `/learnharness Why does the chain rule work?` (or just ask Claude to "teach me X with LearnHarness"). Claude calls `start_session`, returns a link; open it in the app.
2. **From the app:** with `LH_EXTERNAL_AGENT=1`, type a topic on the home screen as usual. In Claude Code, run `/learnharness` with no topic — Claude calls `wait_for_learner` and picks the session up.

From there the session runs exactly like the built-in one: Claude probes, concludes with an assessment, writes the plan map, and teaches with predictions and checks. You answer in the app's dock (confidence, "I don't know", your thinking — all of it reaches Claude). The app shows Claude as "thinking" while it works.

At the end (or whenever you ask), Claude extracts the session into your knowledge graph: `extraction_source` → `graph_search` → `graph_submit`.

## How it works

- `POST /api/mcp` — a stateless Streamable-HTTP MCP endpoint (JSON responses). Local origins only.
- Every agent action lands in the chat record as the **same native messages** the built-in agent writes, through the same persist seam — so the UI needs no special rendering.
- The question tools (`probe`, `recall`, `quiz`, `explain`, `ask_user_question`), `plan_init` and `probe_done` are the app's own tools: same schemas, same validation (nodeId against the live plan, option checks, the probe/teach phase split). Invalid calls are returned to the agent and never persisted.
- Question tools **block** until you answer (up to `LH_MCP_WAIT_SECONDS`, default 240 — Claude Code aborts silent HTTP calls after 5 minutes). If the window passes, the agent gets `status: "waiting"` and calls `wait_for_learner` again.
- The teaching doctrine the agent follows is the app's own composed prober/teacher prompts (including your prompt overrides), minus the background-job and demo fragments the external agent has no tools for. It's attached to tool results the first time the agent enters each phase.
- While the agent is working, the chat holds an "external turn" in the normal turn registry, so busy indicators, the stop button and reattach all work. It is released when the agent asks a question or waits, or after `LH_EXTERNAL_TURN_IDLE_SECONDS` (default 900) of silence.

## Tools

| Tool | Purpose |
|---|---|
| `start_session` | New session for a topic; returns chatId + link + probing doctrine |
| `wait_for_learner` | Block for learner input on one chat, or any chat when chatId is omitted |
| `say` | Teaching prose (Markdown + LaTeX) |
| `probe`, `recall` | Probing-phase questions (block for the answer) |
| `quiz`, `explain` | Teaching-phase questions, tagged with a plan `nodeId` |
| `ask_user_question` | Ungraded question, both phases |
| `probe_done` | Conclude probing with the learner assessment |
| `plan_init` | Write/rewrite the plan map (mermaid) |
| `read_session`, `list_sessions`, `get_instructions` | Resume after a restart |
| `extraction_source`, `graph_search`, `graph_submit` | Knowledge-graph extraction (the agent is extractor + auditor; merging is deterministic) |
| `release_session` | Hand a chat back to the built-in model loop |

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `LH_EXTERNAL_AGENT` | unset | `1`: every new teach session is externally driven; setup/key prompts are hidden |
| `LH_MCP_WAIT_SECONDS` | `240` | How long a blocking call waits before returning `waiting` |
| `LH_EXTERNAL_TURN_IDLE_SECONDS` | `900` | Release the busy indicator after this much agent silence |
| `LH_EXTERNAL_AGENT_NAME` | `claude-code` | Model label stamped on agent messages |

## Limits (v1)

- Practice sessions still run on the built-in loop (they need a configured model).
- No `research`/`pdf`/`demo`/`visual` jobs: the agent uses its own web search and file tools instead.
- Notes import (`/api/graph/import`) still uses the built-in extraction pipeline.
- One agent at a time is the intended setup.
