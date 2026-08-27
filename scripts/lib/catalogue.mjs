import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parseFrontmatter } from './frontmatter.mjs'
import { parseSimpleYaml } from './yaml-lite.mjs'
import { isUnfilled } from './ledger.mjs'

// The catalogue is the list of things this team can actually do: every agent, every skill, and
// every workflow, each with the plain-language description its own file already carries.
//
// It exists so that matching has a closed world to draw from. A proposal may only name something
// in here. That is the whole point — the failure this build was written to stop is a system
// confidently offering a capability nobody built, and the cheapest way to make that impossible
// is to give the matcher nothing to invent with.
//
// Deliberately NOT a new file format. The descriptions already live in the agent frontmatter,
// the skill frontmatter and the workflow yaml, written for humans. Reading those is free and
// keeps one copy of the truth; a separate catalogue.json would drift within a week.

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

const AGENT_DIR = '.claude/agents'
const SKILL_DIR = '.claude/skills'
const WORKFLOW_DIR = 'workflows'

export const KINDS = ['agent', 'skill', 'workflow']

// Kind is part of the id because `email` is both an agent and, in some repos, a skill. A citation
// that says only "email" cannot be checked, and an uncheckable citation is not a citation.
export function itemId(kind, slug) {
  return `${kind}:${slug}`
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

// An item is describable when it carries a real description — not blank, not a template marker
// nobody filled in. Only describable items can be matched against, because matching compares the
// owner's words to this text and there is nothing to compare an empty string to.
export function describable(item) {
  const description = textOf(item?.description)
  return description.length > 0 && !isUnfilled(description)
}

function fromMarkdown(file) {
  const { data } = parseFrontmatter(file.source)
  return { name: textOf(data.name) || file.slug, description: textOf(data.description) }
}

// Every shipped workflow already opens with a comment saying, in the owner's language, what the
// job produces — "What moved in your market overnight, on your screen before your first call."
// That is the description, already written and already read by anyone opening the file. Adding a
// `description:` field beside it would create a second copy to drift, so the comment block is the
// source and an explicit field, if a workflow ever gains one, simply wins.
//
// The block stops at the first paragraph break. A bare `#` ends the description; everything after
// it is engineering rationale — why this owner runs it, which file the role lives in. That prose
// is written for whoever maintains the workflow, not for the owner, and letting it through does
// real damage, because this text is both user-facing and what proposals match against. One
// over-captured line was on its own enough to make "the weekly payroll" match the team's own
// card-router, on the strength of a stray "run".
export function leadingComment(source) {
  const parts = []
  for (const line of String(source ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#')) {
      const text = trimmed.replace(/^#+\s?/, '').trim()
      if (!text) break // a bare `#` is a paragraph break: the description has ended
      parts.push(text)
      continue
    }
    // Blank lines before the comment starts are fine; anything else means the block has ended.
    if (trimmed === '' && parts.length === 0) continue
    break
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

function fromYaml(file) {
  let parsed = {}
  try {
    parsed = parseSimpleYaml(file.source) ?? {}
  } catch {
    // A workflow that will not parse is a problem for validateWorkflow, not for the catalogue.
    // Here it simply arrives with no description and gets flagged by validateCatalogue.
    parsed = {}
  }
  return {
    name: textOf(parsed.name) || file.slug,
    description: textOf(parsed.description) || leadingComment(file.source)
  }
}

// Takes already-read files so the parsing is testable without a filesystem, the same way
// tiles.mjs separates its shaping from its loading.
export function buildCatalogue(files) {
  return files.map((file) => {
    const read = file.kind === 'workflow' ? fromYaml(file) : fromMarkdown(file)
    return {
      id: itemId(file.kind, file.slug),
      kind: file.kind,
      slug: file.slug,
      name: read.name,
      description: read.description,
      path: file.path
    }
  })
}

async function readIfPresent(root, relative) {
  try {
    return await readFile(path.join(root, relative), 'utf8')
  } catch {
    return null
  }
}

async function listIfPresent(root, relative, options = {}) {
  try {
    return await readdir(path.join(root, relative), options)
  } catch {
    return []
  }
}

export async function loadCatalogue(root = repoRoot) {
  const files = []

  for (const entry of (await listIfPresent(root, AGENT_DIR)).filter((f) => f.endsWith('.md')).sort()) {
    const relative = path.posix.join(AGENT_DIR, entry)
    files.push({ kind: 'agent', slug: entry.slice(0, -3), path: relative, source: await readFile(path.join(root, relative), 'utf8') })
  }

  for (const entry of (await listIfPresent(root, SKILL_DIR, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const relative = path.posix.join(SKILL_DIR, entry, 'SKILL.md')
    const source = await readIfPresent(root, relative)
    if (source === null) continue
    files.push({ kind: 'skill', slug: entry, path: relative, source })
  }

  for (const entry of (await listIfPresent(root, WORKFLOW_DIR)).filter((f) => f.endsWith('.yml')).sort()) {
    const relative = path.posix.join(WORKFLOW_DIR, entry)
    files.push({ kind: 'workflow', slug: entry.slice(0, -4), path: relative, source: await readFile(path.join(root, relative), 'utf8') })
  }

  return buildCatalogue(files)
}

// Returns human-readable problems, the same contract as validateLedger and validateWorkflow.
// Empty means every item in the catalogue can be cited by a proposal.
export function validateCatalogue(items) {
  const problems = []
  const seen = new Map()

  for (const item of items ?? []) {
    if (seen.has(item.id)) {
      problems.push(`${item.id} is declared twice (${seen.get(item.id)} and ${item.path}) — a citation naming it could not be checked`)
    } else {
      seen.set(item.id, item.path)
    }

    if (!describable(item)) {
      problems.push(`${item.id} (${item.path}) needs a description — a proposal cites the description, so an item without one can never be proposed`)
    }
  }

  return problems
}
