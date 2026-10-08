// The git the collector tests run - for their own throwaway repos, and handed to the collector as
// deps.git - with one narrow retry.
//
// Why the retry: on a Windows PC with a real-time virus scanner (Norton 360 on Nuno's PC), the
// scanner opens each file git has just written. If git renames that file into place while the
// scanner still holds it - git writes every object to a temporary file, then renames it - the
// rename fails and git stops with "unable to write file ...: Permission denied". Under the full
// suite's parallel load this hit roughly 1 push in 60, in whichever git test it landed on (seen in
// status-parts, status-commit). Reproduced outside the suite with 12 parallel push loops: 2 of 120
// failed; with this retry, 0 of 360, after 2 retries.
//
// Only that exact message is retried, at most four times, a little longer each time. Any other git
// failure - every one a test is about - is returned at once, unchanged. A failed object write
// changes nothing git counts as done (no ref moves, no commit is made), so running the same command
// again is safe; a clone that failed part way has its half-made folder removed first.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const execFileP = promisify(execFile)

export const HELD_BY_SCANNER = /unable to (write|create temporary) file.*Permission denied/
export const RETRIES = 4

const runGit = (args, cwd) => execFileP('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })

export async function git(args, cwd) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runGit(args, cwd)
    } catch (error) {
      if (attempt >= RETRIES || !HELD_BY_SCANNER.test(String(error?.stderr ?? ''))) throw error
      if (args[0] === 'clone') await rm(resolve(cwd ?? '.', args[args.length - 1]), { recursive: true, force: true })
      await new Promise((done) => setTimeout(done, 200 * (attempt + 1)))
    }
  }
}
