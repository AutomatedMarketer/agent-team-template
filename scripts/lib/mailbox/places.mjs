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

import { isAbsolute, join, win32 } from 'node:path'
import { isInsideFolder } from '../status/commit.mjs'

// On Windows, for the runner run on its own: state and the work copy under %LOCALAPPDATA%\Agent Board, the runner's code under the profile. The student
// board does not use these: it hands in its own places (its runnerPlacesFor), with the code in <board folder>\runner-code and state in state\runner.
// The secrets file sits inside the state folder, which is allowed and is what lets one private folder (windows.mjs) cover state and secrets.
// `platform` is left out on a Mac and in every call that predates Windows, which keeps their answer exactly as it was.
export function defaultPlaces(home, { platform, env } = {}) {
  if (platform === 'win32') {
    const local = typeof env?.LOCALAPPDATA === 'string' && win32.isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : win32.join(home, 'AppData', 'Local')
    return {
      stateDir: win32.join(local, 'Agent Board', 'state'),
      codeDir: win32.join(home, 'Agent Board', 'runner-code'),
      workDir: win32.join(local, 'Agent Board', 'work'),
      envFile: win32.join(local, 'Agent Board', 'state', 'runner.env')
    }
  }
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
