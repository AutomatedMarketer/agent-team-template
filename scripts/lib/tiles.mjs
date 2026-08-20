import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parseSimpleYaml } from './yaml-lite.mjs'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const CATALOGUE = 'tiles/catalogue.json'
const SELECTION = 'tiles.yml'

// Four tiles are the product and are always on the board. The rest are a choice, made once
// during onboarding, from a list that does not grow. A board you cannot take in at a glance
// on a phone has stopped being a dashboard, which is why the cap is enforced in code rather
// than suggested in a lesson.

export async function loadCatalogue() {
  return JSON.parse(await readFile(path.join(repoRoot, CATALOGUE), 'utf8'))
}

export async function loadSelection() {
  return parseSimpleYaml(await readFile(path.join(repoRoot, SELECTION), 'utf8'))
}

export function isUnfilled(value) {
  return typeof value === 'string' && /<!--\s*fill:/.test(value)
}

// Returns human-readable problems. Empty means the board is sound.
// Pass `connections` to also check that each chosen tile has something wired behind it;
// omit it to validate shape only.
export function validateSelection(selection, catalogue, connections = null) {
  const problems = []
  const choosable = catalogue.choosable.map((tile) => tile.id)
  const max = catalogue.maxChosen

  const chosen = selection?.chosen
  if (!Array.isArray(chosen)) {
    problems.push('chosen must be a list, even if empty')
    return problems
  }

  if (chosen.length > max) {
    problems.push(`${chosen.length} tiles chosen, but the board holds ${max}`)
  }

  for (const id of chosen) {
    if (!choosable.includes(id)) {
      problems.push(`"${id}" is not a tile in the catalogue`)
    }
  }

  const duplicates = chosen.filter((id, index) => chosen.indexOf(id) !== index)
  for (const duplicate of new Set(duplicates)) {
    problems.push(`tile "${duplicate}" is chosen more than once`)
  }

  const fixed = catalogue.fixed.map((tile) => tile.id)
  for (const id of chosen) {
    if (fixed.includes(id)) {
      problems.push(`"${id}" is always on the board and does not need choosing`)
    }
  }

  if (selection?.hero === undefined || selection.hero === '' || selection.hero === null) {
    problems.push('hero is required — pick the one number that goes at the top')
  } else if (isUnfilled(selection.hero)) {
    problems.push('hero still has its placeholder in it')
  }

  // A tile with nothing wired behind it renders an empty box, which reads as a broken product
  // rather than an unfinished setup.
  if (connections) {
    for (const id of chosen) {
      const tile = catalogue.choosable.find((candidate) => candidate.id === id)
      if (!tile || tile.wiring === 'none') continue
      if (!connections.includes(id)) {
        problems.push(`tile "${id}" has no connection wired behind it`)
      }
    }
  }

  return problems
}

// What the dashboard actually renders: the four fixed tiles, then whatever was chosen, in
// catalogue order so the board does not reshuffle between visits.
export function boardFor(selection, catalogue) {
  const chosen = Array.isArray(selection?.chosen) ? selection.chosen : []
  return [
    ...catalogue.fixed,
    ...catalogue.choosable.filter((tile) => chosen.includes(tile.id))
  ]
}
