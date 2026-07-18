# Agent Guidance

Read the detailed project context in **`CLAUDE.md`**, especially its
**`## Active Handoff`** section for current state. Codex also loads the shared
private guidance in `~/.codex/AGENTS.md` automatically.

## Conventions for any agent working here
- **Secrets**: never hardcode. Read `~/projects/secrets.env` (or this project's `.env`).
  NEVER write a secret value into `CLAUDE.md`/`AGENTS.md` — both are in git.
- **Dry-run first**: show a plan before changing code, config, or live state; wait for
  approval; then execute.
- **Handoff**: before finishing, update `## Active Handoff` in `CLAUDE.md` with the
  current state, tagged with the date + your model name, e.g. `[2026-06-20 (Antigravity)]`.
- **Artifacts**: write any analysis or reports into this repo (for example,
  `./handoff/`), never only to a tool-private directory.
