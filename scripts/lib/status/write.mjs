// Writing the snapshot into a repo folder, and only into it.
//
// The folder may be the data clone, which is reset to whatever the team repo holds every run. So
// anyone who can push can make .agent-team, .agent-team/status or .agent-team/status/usage a link
// to somewhere else, and a write that followed it would land anywhere this user can write. Every
// part of the path is checked before anything is written: on disk, in git's own index when there
// is one, and by where the folder really resolves to.

import { lstat, mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { isInsideFolder } from './commit.mjs'

export class LinkedPath extends Error {
  constructor() {
    super('part of the snapshot path is a link')
    this.name = 'LinkedPath'
  }
}

async function isLinkOnDisk(path) {
  try {
    return (await lstat(path)).isSymbolicLink()
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

// Git keeps a link as mode 120000 whether or not this system checked it out as one (Windows
// without link rights writes a plain file holding the target instead).
async function isLinkInGit(git, root, relativePath) {
  if (typeof git !== 'function') return false
  let listed
  try {
    listed = (await git(['ls-files', '-s', '--', relativePath.split('/')[0]], root)).stdout
  } catch {
    return false
  }
  return listed.split('\n').some((line) => {
    const [meta, path] = line.split('\t')
    if (!meta?.startsWith('120000 ') || !path) return false
    return relativePath === path || relativePath.startsWith(`${path}/`)
  })
}

export async function assertNoLinks(root, relativePath, { git } = {}) {
  let current = root
  for (const segment of relativePath.split('/')) {
    current = join(current, segment)
    if (await isLinkOnDisk(current)) throw new LinkedPath()
  }
  if (await isLinkInGit(git, root, relativePath)) throw new LinkedPath()
}

// Checks, makes the folder, checks again where it really is, then writes through a temporary
// file and a rename so a reader never sees half a file.
export async function writeSnapshot(root, relativePath, text, { git } = {}) {
  await assertNoLinks(root, relativePath, { git })
  const path = join(root, ...relativePath.split('/'))
  await mkdir(dirname(path), { recursive: true })
  // A link made between the check and the mkdir, or one the check could not see.
  await assertNoLinks(root, relativePath, { git })
  if (!(await isInsideFolder(dirname(path), root))) throw new LinkedPath()
  const temporary = `${path}.${process.pid}.tmp`
  try {
    // Anything already at the temporary name - a leftover, or a link someone committed there - is
    // removed (rm never follows a link), and 'wx' refuses to write through one made since.
    await rm(temporary, { force: true })
    await writeFile(temporary, text, { flag: 'wx' })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}
