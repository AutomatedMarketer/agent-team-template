// Four places on the computer, and they must not overlap.
//
//   code    the runner's own pinned checkout of this repo. Moved by hand, never by a run, so the code that runs Claude
//           and pushes cannot change because somebody pushed to the team repo.
//   work    its own clone of the team repo. Reset to the team repo's main before every order: whatever is in it is lost.
//   state   claims, the allowlist, the day's counts, the pause switch, logs. Must survive a reset, and must not be
//           something a push can rewrite.
//   env     the secrets file. Never inside a clone: other people push to those.
//
// A state folder inside the work copy would have its allowlist wiped by the first reset or rewritten by a push; a work
// copy inside the code checkout would be code that changes under a run. So the runner refuses to start when one is
// inside another (or the same as another). "Inside" follows links and ignores capitals where the file system does.

import { isAbsolute, join } from 'node:path'
import { isInsideFolder } from '../status/commit.mjs'

export function defaultPlaces(home) {
  return {
    stateDir: join(home, '.local', 'state', 'agent-mailbox'),
    codeDir: join(home, '.local', 'share', 'agent-mailbox', 'runner-code'),
    workDir: join(home, '.local', 'share', 'agent-mailbox', 'work'),
    envFile: join(home, '.config', 'agent-mailbox', 'env')
  }
}

// [what is inside, what it is inside, the word for it]. The secrets file may sit in the state folder; that is allowed.
const NOT_INSIDE = [
  ['stateDir', 'codeDir', 'state-inside-code'],
  ['stateDir', 'workDir', 'state-inside-work'],
  ['codeDir', 'stateDir', 'code-inside-state'],
  ['workDir', 'stateDir', 'work-inside-state'],
  ['workDir', 'codeDir', 'work-inside-code'],
  ['codeDir', 'workDir', 'code-inside-work'],
  ['envFile', 'codeDir', 'env-inside-code'],
  ['envFile', 'workDir', 'env-inside-work']
]

// { ok: true } or { ok: false, why }, why being one of the words above or 'path' (not a full path).
export async function checkPlaces(places) {
  for (const name of ['stateDir', 'codeDir', 'workDir', 'envFile']) {
    if (typeof places?.[name] !== 'string' || !isAbsolute(places[name])) return { ok: false, why: 'path' }
  }
  for (const [inner, outer, why] of NOT_INSIDE) {
    if (await isInsideFolder(places[inner], places[outer])) return { ok: false, why }
  }
  return { ok: true }
}
