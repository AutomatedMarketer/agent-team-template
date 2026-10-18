// The real Codex, when it is on this computer: the first program on the runner's own fixed list. Tests that use it skip when it is not
// there, and never sign in: everything they prove happens before Codex asks the model anything.
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { codexFolders } from '../../scripts/lib/mailbox/codex.mjs'
import { createRunner } from '../../scripts/lib/status/programs.mjs'

export async function realCodex() {
  for (const folder of codexFolders(homedir(), process.platform)) {
    const file = join(folder, process.platform === 'win32' ? 'codex.exe' : 'codex')
    try {
      await access(file)
      return file
    } catch {
      // Not in this folder.
    }
  }
  return null
}

// The variables a runner hands on (codex.mjs, codexEnv picks from these), from this process.
export const plainEnv = () => Object.fromEntries(['HOME', 'PATH', 'USER', 'LANG', 'TMPDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'TEMP', 'TMP', 'Path'].filter((name) => typeof process.env[name] === 'string').map((name) => [name, process.env[name]]))

export const realExec = () => createRunner({ spawn, platform: process.platform, env: plainEnv() })
