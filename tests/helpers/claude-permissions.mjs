// How Claude Code decides whether a file tool may touch a path, as its docs define it. A fake Claude in the tests applies this to the
// arguments the runner really passes and the settings file it really points at, so a mistake in either - a deny rule that covers the
// folder a job works in, a tool name with no path that is allowed everywhere - is found by a test, not on the Mac.
//
//   https://code.claude.com/docs/en/permissions       path patterns; deny beats allow; a Read deny rule also blocks Edit (v2.1.208) and
//                                                     Write (v2.1.228); a rule written for Write with a path is accepted and never consulted
//   https://code.claude.com/docs/en/permission-modes  dontAsk: anything not allowed is refused
//   https://code.claude.com/docs/en/settings-reference  blockReadsOutsideWorkingDirectories (v2.1.257): a read outside the folder is refused in every mode
//   https://code.claude.com/docs/en/cli-reference     --restricted (v2.1.248): the built-in file tools stay in the working directory
//
// Path patterns: `//path` is a path from the root of the disk, `~/path` is from the home folder, `/path` is from the folder Claude
// is started in for a rule on the command line (from the folder of the settings file for a rule in it), and `path` or `./path` is
// from the folder Claude is started in. `**` goes through any number of folders, `*` stays in one.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const posix = (path) => resolve(path).replaceAll('\\', '/')
const fold = (text) => (process.platform === 'win32' ? text.toLowerCase() : text)

// { tool, spec } or null. `spec` is the text in brackets, null when there is none.
export function parseRule(text) {
  const found = typeof text === 'string' ? /^([A-Za-z0-9_*-]+)(?:\((.+)\))?$/.exec(text) : null
  return found ? { tool: found[1], spec: found[2] ?? null } : null
}

function globToRegex(pattern) {
  let out = ''
  let at = 0
  while (at < pattern.length) {
    const rest = pattern.slice(at)
    if (rest.startsWith('/**/')) {
      out += '/(?:.*/)?'
      at += 4
    } else if (rest === '/**') {
      out += '(?:/.*)?'
      at += 3
    } else if (rest.startsWith('**')) {
      out += '.*'
      at += 2
    } else if (rest[0] === '*') {
      out += '[^/]*'
      at += 1
    } else if (rest[0] === '?') {
      out += '[^/]'
      at += 1
    } else {
      out += rest[0].replace(/[.+^${}()|[\]\\]/g, '\\$&')
      at += 1
    }
  }
  return new RegExp(`^${out}$`, process.platform === 'win32' ? 'i' : '')
}

function absolutePattern(spec, { cwd, home, root }) {
  if (spec.startsWith('//')) return posix(spec.slice(1))
  if (spec.startsWith('~/')) return `${home}/${spec.slice(2)}`
  if (spec.startsWith('/')) return `${root}${spec}`
  return `${cwd}/${spec.startsWith('./') ? spec.slice(2) : spec}`
}

const matches = (spec, target, where) => globToRegex(absolutePattern(spec, where)).test(target)

// Which rules cover which tool. Edit covers every tool that edits a file, Write included; a Read deny rule also covers Edit and Write.
const DENY_COVERS = { Read: ['Read', 'Edit', 'Write'], Edit: ['Edit', 'Write'], Write: ['Write'] }
const ALLOW_COVERS = { Read: ['Read'], Edit: ['Edit', 'Write'], Write: ['Write'] }

// config: { allow: rules from the command line, deny: rules from the settings file, settingsDir, restricted, blockReads, mode }.
// -> { allowed, confined, denyList, notAllowed }: why it was refused is kept apart, so a test can say it was confinement and not the deny list.
export function decide(config, { tool, path, cwd, home }) {
  const where = { cwd: posix(cwd), home: posix(home) }
  const target = posix(path)
  const outside = !(fold(target) === fold(where.cwd) || fold(target).startsWith(`${fold(where.cwd)}/`))
  const confined = (config.restricted === true && outside) || (config.blockReads === true && tool === 'Read' && outside)

  const hit = (rules, covers, root) => rules.map(parseRule).some((rule) => {
    if (rule === null || !(covers[rule.tool] ?? []).includes(tool)) return false
    if (rule.spec === null) return true
    // A rule for Write that names a path is never consulted.
    return rule.tool !== 'Write' && matches(rule.spec, target, { ...where, root })
  })
  const denyList = hit(config.deny ?? [], DENY_COVERS, posix(config.settingsDir ?? cwd))
  const allowHit = hit(config.allow ?? [], ALLOW_COVERS, where.cwd)
  const notAllowed = config.mode === 'dontAsk' && !allowHit
  return { allowed: !confined && !denyList && !notAllowed, confined, denyList, notAllowed }
}

// A settings file that cannot be read is no settings: a fake Claude carries on with none, where the real one would stop. (A test that points
// the runner at a folder with no settings file is about something else.)
export const lenientRead = (path, encoding) => {
  try {
    return readFileSync(path, encoding)
  } catch {
    return '{}'
  }
}

// The rules as a run is really started: the allow list after --allowedTools, the deny list and the block in the settings file named by
// --settings, --restricted, and the permission mode.
export function configFromArgs(args, { read = readFileSync } = {}) {
  const valueOf = (flag) => args[args.indexOf(flag) + 1]
  const at = args.indexOf('--allowedTools')
  const allow = []
  if (at >= 0) for (let next = at + 1; next < args.length && !args[next].startsWith('--'); next += 1) allow.push(args[next])
  const settingsPath = valueOf('--settings')
  const settings = JSON.parse(read(settingsPath, 'utf8'))
  return {
    allow,
    deny: settings.permissions?.deny ?? [],
    settingsDir: dirname(settingsPath),
    restricted: args.includes('--restricted'),
    blockReads: settings.permissions?.blockReadsOutsideWorkingDirectories === true,
    mode: valueOf('--permission-mode'),
    settings
  }
}
