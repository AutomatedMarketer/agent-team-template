# Draft-only — the rule and why it holds

**Applies to:** the `email` and `customer-service` agents.

## The rule

These agents write replies into a drafts folder. A person reads the draft and sends it.
No agent sends mail on its own, on any schedule, in any run.

## Why

An agent that sends is an agent that can send the wrong thing to a real customer while
you are asleep, and there is no undo. The cost of a bad draft is ten seconds of reading.
The cost of a bad send is a relationship. That asymmetry is the entire argument, and it is
what a graduate is expected to be able to say out loud.

It is also what makes an inbox agent safe to run several times a day. Frequency is only
affordable when the worst case is a draft you delete.

## How the rule is enforced, in order of reliability

1. **The agent is told, literally, in its own file.** Sonnet 5 follows literal
   instructions without generalising past them, which is the reason both inbox agents run
   on Sonnet rather than Opus.
2. **`tests/safety.test.mjs`** fails if either agent file stops saying it.
3. **`.claude/settings.json` `permissions.deny`** blocks the send tools by name.

### Deny list — verified names

**Status:** pending. Layer 3 is not yet in place, and this file says so rather than
implying a guarantee that does not exist. Layers 1 and 2 are live and tested today.

| Connector | Send-capable tool | Denied in settings.json |
|---|---|---|
<!-- fill: verified-send-tools -->

**How to fill this in.** Attach the Gmail connector, ask the email agent to send a test
message to your own address, and record what happened. Then list every send-capable tool
the connector exposes and add each one to `permissions.deny`.

Verification date: <!-- fill: safety-verification-date -->

If the connector exposes no send capability at all, record that here as the finding — it
is a stronger guarantee than a deny rule, and it should be stated rather than assumed.
