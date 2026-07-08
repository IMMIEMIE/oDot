# oDot Roadmap

A realistic plan for a solo, part-time developer. Assumes ~10 hrs/week. Each phase ships something usable before the next starts.

**Strategy in one line:** stop competing on the agent loop; win on the surface (floating ball) and make the brain swappable (ACP).

---

## Phase 0 — Hygiene & credibility (1–2 weeks)

Cheap work with outsized payoff for users, contributors, and your portfolio.

- [ ] Remove `error.txt` from repo root; add to `.gitignore`
- [ ] Fix README clone URL (`your-username` placeholder) and verify all commands work on a fresh clone
- [ ] Record a 30-second demo GIF of the floating ball driving an edit + rollback; put it at the top of the README
- [ ] GitHub Actions CI: `npm run typecheck` + `cargo test` on push
- [ ] GitHub Actions release workflow: build `odot.exe` (and macOS if feasible) on tag, attach to Releases
- [ ] 3–5 integration tests for `runner.rs` and `tools.rs` (mock provider, assert tool dispatch + snapshot creation). These two files are 4.4k lines with no coverage — highest-risk code in the repo.

**Exit criteria:** a stranger can download a release, run it, and understand the product in 60 seconds.

## Phase 1 — Make the floating ball the product (3–5 weeks)

This is the differentiator. Terminal agents can't serve this use case; IDE plugins are locked to one editor.

- [ ] Global hotkey to summon/dismiss the ball from any app
- [ ] Active-context awareness: detect the focused window title (and file path where available) and inject it as context automatically
- [ ] "Ask about selection": hotkey grabs the current text selection (clipboard trick) into the prompt
- [ ] Screenshot-to-prompt: capture a region, attach as image context (needs a vision-capable provider)
- [ ] Review diffs and approve shell commands from the ball itself, without opening the main window
- [ ] Publish v0.x, post to r/rust, r/LocalLLaMA, Hacker News (Show HN). Collect feedback before building more.

**Exit criteria:** you can do a full ask→edit→review→rollback loop without ever leaving your editor. Real users have tried it.

## Phase 2 — Close the capability gaps that matter (3–6 weeks)

Skip full LSP integration (too heavy for one person). These two changes give most of the benefit:

- [ ] **Git checkpoints:** auto-commit (or stash-based checkpoint) per agent turn on a shadow branch; expose `git log`/`git diff` to the agent as context. This also strengthens the existing rollback story beyond per-file snapshots.
- [ ] **Post-edit verification loop:** after mutations, auto-run the project's check command (`tsc`, `cargo check`, configurable in `odot.json`) and feed errors back to the agent for self-correction. This is the single biggest win for real task success rates.
- [ ] Optional: repo map (file tree + symbol outline via a lightweight parse) injected at session start

**Exit criteria:** agent fixes its own type errors without user intervention in a typical session.

## Phase 3 — ACP host support (spike first: 1 week; commit: 4–8 weeks)

ACP is JSON-RPC 2.0 over stdio; the host launches the agent as a subprocess. There is an official Rust crate (`agent-client-protocol`), and Zed, JetBrains, and Devin Desktop already host agents this way. If oDot speaks ACP, the floating ball can drive Claude Code, Codex, Gemini CLI, or OpenCode — your agent loop stops being the bottleneck.

- [ ] **Spike (timeboxed, 1 week):** launch one ACP agent as a subprocess, complete `initialize` + `session/new`, render its streamed updates in the existing event timeline. If this fights the architecture, stop and reassess.
- [ ] Map ACP session updates onto `event_bus.rs` events; map ACP permission requests onto the existing approval UI
- [ ] Route ACP file-read/write requests through `mutation.rs` so snapshots + rollback still work for external agents (this is oDot's unique value-add over other ACP hosts)
- [ ] Agent picker in settings: built-in loop vs. external ACP agent

**Exit criteria:** Claude Code (or Gemini CLI) runs inside oDot with oDot's snapshot/rollback wrapping its edits.

## Deliberately NOT doing

- Full LSP client, embeddings/semantic search, benchmark chasing, multi-agent orchestration UI, Linux packaging (until asked), monetization. Feature parity with 20+ funded competitors is a losing game; the ball + safety layer + ACP is the defensible slice.

## Ongoing

- One design write-up (snapshot/rollback internals or "why I made my agent's brain swappable") — good for the project and for you.
- Keep CHANGELOG + tagged releases; small, frequent versions beat big silent gaps.
