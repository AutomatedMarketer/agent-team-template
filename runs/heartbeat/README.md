# heartbeat

One small file per runtime that is not a cloud run - a Hermes instance, an OpenClaw gateway, a
machine of your own.

    { "runtime": "hermes", "at": "2026-08-18T09:00:00Z" }

The dashboard reads the timestamp. Fresh means the light is on. Stale means it is not, and it
says so. How old is too old is the runtime's own `stale_after_minutes` in `runtimes.yml` (5 to
1440, default 30): set it a little longer than the gap between two heartbeats.

**An agent that stopped three weeks ago is worse than no agent**, because you were counting on
it. This folder is how silence becomes visible.

## Hermes

`hermes.json` is written by the status collector (`scripts/collect-status.mjs`, the `hermes` part),
not by Hermes. Every three hours it reads Hermes's own files, and writes this heartbeat only when
Hermes proved it was alive: its gateway said `running` and stamped its file within five minutes of
the check, or one of its profiles' schedulers did. `at` is the newest of those times. When Hermes is
down, nothing is written and the old heartbeat is left to go stale - that is the point.

Because it comes every three hours, Hermes's entry in `runtimes.yml` sets
`stale_after_minutes: 200` (three hours and twenty minutes). With the default 30 it would show as
quiet for most of every three hours. The full rule is in `.agent-team/status/README.md`, "The Hermes
file".
