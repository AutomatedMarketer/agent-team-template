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

// Some of a run's files were renamed into place before another failed to be.
export class PartlyWritten extends Error {
  constructor() {
    super('some snapshot files were written before another failed')
    this.name = 'PartlyWritten'
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

// Checks, makes the folder, checks again where it really is, then writes the text to a temporary
// file beside the target. Returns { temporary, path } once the temporary file holds the whole text;
// `made` is told the temporary name as soon as this call has created it, so a caller can remove it.
async function stage(root, relativePath, text, { git }, made) {
  await assertNoLinks(root, relativePath, { git })
  const path = join(root, ...relativePath.split('/'))
  await mkdir(dirname(path), { recursive: true })
  // A link made between the check and the mkdir, or one the check could not see.
  await assertNoLinks(root, relativePath, { git })
  if (!(await isInsideFolder(dirname(path), root))) throw new LinkedPath()
  // A small gap is left on purpose between this last check and the write below: swapping a
  // folder for a link inside it takes a program already running on this computer as this user.
  // A push cannot do that - git only changes the clone when the collector runs git, and nothing
  // runs git between here and the rename. Closing it fully would need openat-style calls Node
  // does not offer.
  const temporary = `${path}.${process.pid}.tmp`
  // Anything already at the temporary name - a leftover, or a link someone committed there - is
  // removed (rm never follows a link); a folder there is not ours and stops the write. 'wx' refuses
  // to write through anything made since.
  await rm(temporary, { force: true })
  made.push(temporary)
  await writeFile(temporary, text, { flag: 'wx' })
  return { temporary, path }
}

// Writes several files as one: every file is first written whole to a temporary file beside its
// target, and only when all of them are there are they renamed into place. Any failure before the
// renames leaves no file of this run behind - every temporary file it made is removed, and nothing
// else is touched. A reader never sees half a file.
export async function writeSnapshots(root, files, { git } = {}) {
  for (const { relativePath } of files) await assertNoLinks(root, relativePath, { git })
  const made = []
  const removeMade = () => Promise.all(made.map((temporary) => rm(temporary, { force: true }).catch(() => {})))
  const staged = []
  let renamed = 0
  try {
    for (const { relativePath, text } of files) staged.push(await stage(root, relativePath, text, { git }, made))
    for (const { temporary, path } of staged) {
      await rename(temporary, path)
      renamed += 1
    }
  } catch (error) {
    // Before the renames nothing of this run is in place. A rename failing after another one
    // succeeded is the one case that leaves some files new and some old: that is PartlyWritten, so
    // the run never claims "Nothing was written". The temporary files left are removed either way.
    await removeMade()
    if (renamed > 0) throw new PartlyWritten()
    throw error
  }
}

export async function writeSnapshot(root, relativePath, text, options = {}) {
  await writeSnapshots(root, [{ relativePath, text }], options)
}
