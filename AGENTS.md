# Codex collaboration rules

This repository participates in the shared `codex-coordinator` workflow with these related projects: `worldcons`, `worldcase`, `newthesis`, `cclmetasearch`, `cclrag2`, `worldlaws`, `law_repo_trans`, and `lawRouter`.

## Required startup behavior

At the beginning of a new Codex run that will modify or review code:

1. Call `get_coordination_protocol`.
2. Call `register_session` using the project/session defaults from `.codex/config.toml`, with a useful role and capabilities.
3. Call `get_coordinator_snapshot` for this project and inspect existing related tasks before creating duplicate work.

## Collaboration behavior

- Use coordinator tasks for substantial work and keep task status current.
- While actively working, refresh session heartbeat and renew task lease when needed.
- If a change can affect another connected project through API contracts, schemas, search behavior, navigation, shared data, deployment assumptions, or integrations, check `list_sessions` and coordinate before finalizing it.
- If an affected project session is active, use `request_opinion` before committing to a cross-project design and `request_review` after implementation.
- If the relevant project session is not active, leave the context/question in `project:<project>` with `write_thread`; do not invent the other project's opinion.
- Respond to review/opinion requests assigned to this session before declaring dependent work complete.
- Use `record_decision` when reviewers disagree materially; preserve the audit trail rather than bypassing review gates.
- Use `create_blocker` for a real dependency that prevents safe progress and resolve it when cleared.
- Only use `complete_task` after dependencies, blockers, review policy, and decisions permit completion.
- On normal session end, set the session idle or unregister it; release owned work if it should be available to another session.

## User interaction

The user should not need to invoke coordinator tools manually. Treat natural-language instructions such as "관련 프로젝트와 상의해", "서로 검토해", or "협업해서 진행해" as instructions to use this workflow automatically.

## Safety / project policy

- Do not use Orca for this repository.
- Never modify the coordinator SQLite database directly to bypass task, dependency, blocker, review, quorum, decision, or lease rules.
- Preserve unrelated working-tree changes and do not overwrite another agent's work.
