# Draft-only — the rule and why it holds

**Applies to:** every agent that could reach the outside world — `email`, `customer-service`,
`research`, `content` and `sales`. The five Lesson 13's safety pass asks you to test.

This page is written around the two mail agents because that is where the rule bites hardest
and where the deny list matters. The other three state the same rule in their own files, in
their own verbs: `research` does not send, post or contact; `content` does not publish,
schedule or post; `sales` does not email the prospect. All five are held by
`tests/safety.test.mjs`, each against the verb it actually has to refuse.

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
2. **`tests/safety.test.mjs`** fails if any of the five agent files stops saying it. It covered
   only the two mail agents until Lesson 13's walkthrough found that the other three could be
   reworded silently — the lesson tested five, the guard held two.
3. **`.claude/settings.json` `permissions.deny`** blocks the send tools by name.

### Deny list — verified names

**Status:** pending. Layer 3 is not yet in place, and this file says so rather than
implying a guarantee that does not exist. Layers 1 and 2 are live and tested today.

| Connector | Send-capable tool | Denied in settings.json |
|---|---|---|
<!-- fill: verified-send-tools -->

**How to fill this in — without sending anything.**

1. With the connector attached, ask the email agent to **list every tool it can see that could
   send, forward, or reply**. Naming a capability does not use it.
2. Add each of those names to `permissions.deny` in `.claude/settings.json`.
3. Record them in the table above with today's date.

**Do not verify this by sending a test message.** That test cannot tell you what you want to
know and can only cost you something. If the agent refuses, you have learned that layer 1 works
and nothing about layer 3. If it sends, layer 1 has just failed and you caused it on purpose, on
a real account. The thing being protected here is that no mail leaves without a person deciding —
an exercise that asks a person to decide to send is not evidence about the unattended case,
which is the only case that matters.

The check that *is* worth running is the refusal, and it is already on the course's Day 3 safety
pass: ask each outbound agent to send, and watch it decline. That tests layer 1, which is the
layer doing the work.

Verification date: <!-- fill: safety-verification-date -->

If the connector exposes no send capability at all, record that here as the finding — it
is a stronger guarantee than a deny rule, and it should be stated rather than assumed.

**Three states, and only two of them close layer 3.** They are easy to confuse, and the third
one is the trap:

| State | What it means | Closes layer 3? |
|---|---|---|
| **Denied** | A connector is attached, you asked it to name its send-capable tools, and those names are in `permissions.deny`. | **Yes.** Fill the table and the date. |
| **Inspected, none found** | A connector is attached, you asked, and it exposes nothing that can send. | **Yes**, and it is the stronger finding. Record which connector you inspected, and when. |
| **No connector attached** | `connections/register.yml` is empty, or carries no mail connector. | **No.** Nothing has been verified. |

**The third state is not the second one.** An empty register by default proves nothing about what
a connector would expose; an empty register *after inspection* is a positive finding about a named
connector on a named date. Writing "no send capability" when nothing was ever attached records a
guarantee nobody checked — which is the exact failure this file exists to prevent.

If you have no connector, leave this **pending** and say so. That is the honest state, layers 1
and 2 are still doing their work, and nothing is pretending otherwise.
