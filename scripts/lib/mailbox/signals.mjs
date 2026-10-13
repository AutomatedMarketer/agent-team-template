// What happens when the runner is stopped by a signal (launchctl bootout, a logout, Ctrl-C in a terminal).
//
// Claude is started in its own process group, so a signal that ends the runner does not reach it: it would run on with no time limit (the
// limit is kept by the runner, and the runner is gone), and the lock would stay for an hour (takeLock treats only an older one as stale).
// So the runner keeps a small record of what is alive (`live`: the Claude processes it started, and the lock it holds), and on SIGTERM or SIGINT:
//   1. every live Claude is killed, the whole group, with the same kill the time limit uses;
//   2. the lock is released;
//   3. whatever order was in progress is left exactly as it is: its claim has a receipt and no final word, which the next tick reads as
//      "outcome unknown" and settles by READING the team repo (ledger.mjs, reconcile). It is never run again, and never written down as
//      failed or ok here, because nobody knows;
//   4. the process exits with a code that is not 0 (128 plus the signal's number, the shell's own way of saying "killed by a signal").
// `stopping` tells the rest of the code a signal came: nothing more is written as an order's final word after that (tick.mjs, settle).

export const SIGNALS = Object.freeze({ SIGINT: 2, SIGTERM: 15 })

export const createLive = () => ({ children: new Set(), lock: null, stopping: false })

// -> an async function (signal) -> void. `kill(pid, signal)` and `release(lock)` are the real ones in the runner and fakes in the tests;
// `exit(code)` ends the process. It acts once: a second signal while it is working changes nothing.
export function signalHandler(live, { kill, release, exit, log = () => {} }) {
  let acted = false
  return async (signal) => {
    if (acted) return
    acted = true
    live.stopping = true
    for (const pid of [...live.children]) {
      try {
        kill(pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    live.children.clear()
    const lock = live.lock
    live.lock = null
    try {
      await release(lock)
    } catch {
      // A lock that cannot be removed goes stale by itself in an hour.
    }
    log(`mailbox: stopped by ${signal}; any order in progress is left as outcome unknown and is settled by reading on the next tick`)
    exit(128 + (SIGNALS[signal] ?? SIGNALS.SIGTERM))
  }
}

// Listen for both signals on `proc` (the real process, or a stand-in with on() and exit()).
export function listenForSignals(proc, handler) {
  for (const signal of Object.keys(SIGNALS)) proc.on(signal, () => handler(signal))
}
