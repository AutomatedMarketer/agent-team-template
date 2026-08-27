---
name: token-saver
description: Use when the user asks about token usage, context, or cost — "why is this so expensive", "am I burning tokens", "how do I save tokens", "what's eating my context", "should I clear or compact", "is my cache still good", or before/after actions that reset the prompt cache (switching model, changing effort, upgrading Claude Code). Also use when a session is long and the user is deciding whether to keep going, hand off, or start fresh. Advisory only — explains what is actually happening and recommends; never silently changes how thorough the work is.
audience: team
---

# Token Saver

Cost advisor for Claude Code sessions. **Explain, recommend, let the user decide.**

Never quietly become terse or skip work to save tokens — if a tradeoff exists, name it.

---

## 1. The mental model (lead with this)

Every follow-on message **resends the whole conversation**. The API is stateless. Caching
does not change that — it changes what those tokens *cost*.

**Prices move; these multipliers have not. Teach the ratio, not the dollar figure.**

| Token type | Cost vs. base input |
|---|---|
| Cache read | **0.1×** |
| Base input (uncached) | **1×** |
| Cache write, 5-minute | **1.25×** |
| Cache write, 1-hour | **2×** |
| **Output** | **5×** — see caveat below |

The three cache figures are **published multipliers**. The output figure is **not** — it's an
observation that every model on today's price list happens to price output at 5× its base
input. Say it that way; don't call it a documented rule.

**Break-even** — Anthropic's own framing, better than any "N× cheaper" claim:
- 5-minute cache pays for itself after **1 read**
- 1-hour cache pays for itself after **2 reads**

**Two things people get wrong:**
- Cached tokens **still occupy the context window**. Caching is a discount, not a diet.
- Total input = `input_tokens` **+** `cache_read_input_tokens` **+** `cache_creation_input_tokens`.
  Reading `input_tokens` alone undercounts badly — it only covers tokens after the last
  cache breakpoint.

## 2. How long the cache lives

There is no single answer. **Do not state "1 hour" as a universal fact.**

| Where | Default TTL |
|---|---|
| Claude API / Bedrock / Vertex / Foundry | **5 minutes** |
| Claude Code on a Claude subscription | **1 hour** (requested automatically) |
| Claude Code running on usage credits (past plan limit) | drops to **5 minutes** |
| Subagents | **5 minutes**, even on a subscription |

- **Refreshing is free** — each cache hit resets the timer at no cost.
- The clock starts when the **request begins**, not when the response ends. A long streamed
  reply eats into the window.
- **Scope is one machine + one directory.** The system prompt embeds the working directory,
  so two sessions in different folders never share a cache — *including worktrees of the
  same repo.*

## 3. What actually breaks the cache

The prefix match is exact: **a change anywhere invalidates everything after it.** Layers, in
order — **system prompt** → **project context** (CLAUDE.md, memory) → **conversation**.

Two cache-key inputs aren't in the prompt text at all: **the model** and **the effort level**.

### Reliably invalidates
| Action | Note |
|---|---|
| **Switch model** (`/model`) | The only truly unconditional one. Each model has its own cache; plan-mode toggles count. |
| **Change effort** (`/effort`) | Except a no-op change to the level already in effect. |
| **Upgrade Claude Code** | Docs hedge — it *typically* changes the system prompt or tool definitions. Applies at next launch. |

### Sometimes — the nuance most advice gets wrong
| Action | Actually |
|---|---|
| **Fast mode** | **First enable only.** Turning it off, rate-limit fallback, and re-enabling all keep the cache. |
| **MCP connect/disconnect** | Cache **survives** when tools are deferred (the default). Only bites when tool definitions sit in the prefix. |
| **Plugin on/off** | Only plugins that ship **MCP servers**. Skills, commands, agents, hooks: no effect. |
| **Denying a tool** | Only a **whole-tool** deny rule (`Bash`, `WebFetch`). Denying one call at a prompt does nothing. Scoped rules like `Bash(rm *)` are fine. |
| **`/compact`** | Invalidates the conversation layer. Project context re-hits **only if** CLAUDE.md and memory are unchanged since session start. The expensive part is the compaction itself, not the turn after it. |

### Does NOT break the cache — reassure people about these
Editing repo files · editing CLAUDE.md mid-session · changing output style · changing
permission mode · running skills and commands · `/recap` · `/rewind` · spawning a subagent.

**`/clear` is different — be precise about it.** It **costs nothing to run**, which is why
it's usually the right call. But it does not *preserve* your cache either: it starts a fresh
conversation with empty context, so the conversation layer is rebuilt from there. Cheap and
correct — just don't tell people it "keeps the cache."

**Frame the cost honestly:** a broken cache is *one* slower, pricier turn — then the new
prefix is cached. Not a permanent penalty.

## 4. Inspecting reality

| Command | Shows |
|---|---|
| **`/usage`** (`/cost` is an alias) | Session totals incl. **cache read** and **cache write** tokens |
| **`/context`** | Grid of what's filling the context window + optimization hints. **Not a cache tool.** |
| **`/doctor`** | Finds unused skills, MCP servers and plugins vs. their context cost. **Reports first, asks before changing anything.** |

## 5. Long session — clear, compact, or hand off?

Ask what needs to survive, then recommend:

| Situation | Recommend | Why |
|---|---|---|
| Work is visible in the files/repo | **`/clear`** | Free. Claude re-reads the code and picks it up. Most common right answer. |
| Reasoning matters but isn't written down | **`/compact`** | Keeps a summary in the conversation. |
| You want a durable record across sessions | **Write a handoff file** | A markdown file on disk beats a summary that lives only in one chat. |
| Session is huge (500k+) | Any of the above | Past a point, quality degrades from context rot regardless of cost. |

**Say this out loud when it applies:** long sessions aren't just expensive, they get *worse*.
Cost is often the smaller problem.

## 6. Reducing spend, in order of impact

1. **Don't fragment the cache.** Batch model/effort changes; don't flip settings mid-flow.
2. **Trim what loads every session.** `/context` then `/doctor`. Every skill's name and
   description sits in context permanently — a large skill library is a standing tax.
3. **Keep CLAUDE.md short.** Long ones don't just cost context — Anthropic notes they
   *reduce how well instructions are followed*. Bloat makes Claude worse, not just pricier.
4. **Watch output.** Output is **5×** input. Asking for a whole file back when a diff would
   do is the most common avoidable spend.
5. **Right-size the model** for mechanical work.

## 7. Never say these

- ❌ "The cache lasts an hour" — depends on surface; **5 minutes** is the API default
- ❌ "Cache reads are 20× cheaper" — Anthropic never publishes that; use break-even
- ❌ "Caching means the conversation isn't resent" — it is, every turn
- ❌ "Cached tokens don't count toward context" — they do
- ❌ "The minimum cacheable prompt is 1,024 tokens" — it's **per model** (512 / 1,024 / 2,048 / 4,096)
- ❌ "MCP / plugins / denying a tool always break the cache" — all three are conditional
- ❌ "Subagents give you a per-token discount" — there is no rebate. The saving is real but
  indirect: work happens in a separate context so your main conversation doesn't carry it
  forward, and you can route the sub-task to a cheaper model. Anthropic files this under
  reducing token usage — so don't over-correct and claim it saves nothing.
- ❌ Quoting per-million dollar figures as the teaching unit

## 8. When exact numbers are needed

Send the user to the live source rather than quoting figures that will age:
<https://platform.claude.com/docs/en/about-claude/pricing>
