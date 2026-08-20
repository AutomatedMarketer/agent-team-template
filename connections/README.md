# connections/ — what your team can reach

Your agents can read the web the moment you install them. Everything else — your inbox, your
calendar, your payments, your store, your site — has to be connected, and this folder is the
record of what is connected, proved, and used.

You never write these files by hand. Say:

```
/connect
```

## The promise

> **You click "sign in". Your team does everything else.**

That limit is real. A sign-in happens in your browser, on your account. Nothing here ever
asks you for a password or an API key in chat, and no credential is ever committed.

## The two files

| File | What it holds |
|---|---|
| `register.yml` | Every connection: which account, which permissions, the date it last answered, and the workflows that depend on it |
| `recipes/<slug>.md` | How a tool was connected, written down the first time so nobody researches it twice |

## Proved, not claimed

A connection is only registered after it has returned **your own data** — the subjects of
your last three emails, tomorrow's calendar, the titles of your three most recent posts.

That rule exists because the alternative fails silently at 6am inside a scheduled run, three
weeks after you set it up, and by then nobody remembers what changed.

## Recipes are why the long tail works

Nobody's stack is a catalogue. You might run a Substack newsletter, a WordPress blog, a
Shopify or Stan store, a CRM nobody else uses — and none of it is on anyone's shipped list.

So `/connect` does not consult a list. It researches the tool as it is **today**, picks the
best available shape — an official connection, a command-line tool, a small script, or as a
last resort a browser — wires it, proves it, and **writes down what it learned**.

The first connection of a kind takes twenty minutes. The second takes two, because the
recipe is already here. Over a few months this folder becomes the catalogue nobody had to
write in advance, containing exactly the tools you actually use and nothing else.

## Where the dashboard reads

The Connections screen shows `register.yml`. `runtimes.yml` in the repo root is a different
thing: anything with a URL and a heartbeat — a messaging gateway, an always-on runtime — so
the dashboard can tell you whether it is alive.
