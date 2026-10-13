// A small file read whole, or a state word. A link, a folder or anything that is not a plain file, a file bigger
// than `maxBytes` and one that cannot be read are all "broken": none of them is a file somebody wrote for this.
// Never an error message, because an fs error carries a full path, and a full path carries the username.
//
// Every read goes through `fs` (the real file system unless a test hands in its own).

import * as realFs from 'node:fs/promises'

// { state: 'missing' } - no file, or no folder to hold it
// { state: 'broken', reason, info } - reason is 'link', 'not-file', 'size', 'unreadable' or whatever `refuse` said
// { state: 'ok', text, info } - info is what lstat said
// `refuse(info)` is for a caller that cares about the mode or the owner: it is asked before the file is read, and a
// word back means the file is broken for that reason and its contents are never read.
export async function readSmallFile(path, maxBytes, fs = realFs, refuse = null) {
  let info
  try {
    info = await fs.lstat(path)
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? { state: 'missing' } : { state: 'broken', reason: 'unreadable', info: null }
  }
  // lstat does not follow a link, so a link is seen as one and is never read.
  if (info.isSymbolicLink()) return { state: 'broken', reason: 'link', info }
  if (!info.isFile()) return { state: 'broken', reason: 'not-file', info }
  if (info.size > maxBytes) return { state: 'broken', reason: 'size', info }
  const refusal = refuse?.(info)
  if (refusal) return { state: 'broken', reason: refusal, info }
  try {
    return { state: 'ok', text: await fs.readFile(path, 'utf8'), info }
  } catch {
    return { state: 'broken', reason: 'unreadable', info }
  }
}
