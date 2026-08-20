# heartbeat

One small file per runtime that is not a cloud run - a Hermes instance, an OpenClaw gateway, a
machine of your own.

    { "runtime": "hermes", "at": "2026-08-18T09:00:00Z" }

The dashboard reads the timestamp. Fresh means the light is on. Stale means it is not, and it
says so.

**An agent that stopped three weeks ago is worse than no agent**, because you were counting on
it. This folder is how silence becomes visible.
