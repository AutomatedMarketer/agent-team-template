# recipes/ — how each tool was connected

One file per tool, written by `/connect` the first time it works out how something connects.
You do not write these; you read them when something breaks, and your team reads them when
you set up a second machine.

## The shape

```markdown
---
name: <Tool>
kind: mcp | cli | connector | script | browser
verified: <YYYY-MM-DD>
source: <the URL that was actually read>
---

# Connecting <Tool>

## What it gives the team
## Steps
## Proof
## Known traps
```

## Why `verified` and `source` are not decoration

Connection details change monthly — a renamed flag, a moved settings page, a package that
became something else. A recipe with no date is a recipe nobody can trust, so `/connect`
re-checks anything older than **90 days** before following it, and the weekly tune-up reports
recipes that have gone stale.

`source` is the URL that was read at the time. When a step stops working, that link is where
to look first.

## Known traps is the valuable part

Anything that cost time the first time goes there: the scope that is not obvious, the second
account that looks identical to the first, the setting that has to be switched on in the
vendor's dashboard before the connection returns anything but an empty list.

That section is the difference between a recipe and a link.
