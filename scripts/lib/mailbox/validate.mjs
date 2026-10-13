// A signed order is the board's, but its typed words are still someone's: every field is checked again here by
// the board's own rules, which are the shared contract's (tests/fixtures/mailbox-parity.json, `payload`). A field
// is good only in the exact form the board writes it - trimmed, left out when empty, plain text, a slug or one of
// the listed words - and anything else makes the whole order not valid. Nothing is repaired or stripped: a
// character nobody can see means the words are not what they look like.
//
// The board's instruction text (what a cloud routine would be told to do) rides in the payload but is not part
// of the contract and is never used here: the Mac does each action by its own code, from these fields only.
//
// A refusal is just { ok: false }. It names no field and repeats no value: the order is someone's words.

import { PAYLOAD_SOURCE } from './contract.mjs'

export const FIELDS = Object.freeze({
  task: { required: ['title'], optional: ['details', 'for', 'model'] },
  skill: { required: ['title'], optional: ['details'] },
  agent: { required: ['title'], optional: ['details'] },
  move: { required: ['task', 'status'], optional: [] },
  approve: { required: ['task'], optional: [] },
  run: { required: ['workflow'], optional: [] },
  pause: { required: ['workflow'], optional: [] },
  arm: { required: ['workflow'], optional: [] }
})

export const MODEL_TIERS = ['opus', 'sonnet', 'haiku']
export const TASK_STATUSES = ['todo', 'doing', 'done']
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const FIELD_RULES = Object.freeze({
  title: { min: 3, max: 200 },
  details: { min: 1, max: 2000 },
  approve: { min: 1, max: 200 },
  slug: { max: 100 }
})

const BS = String.fromCharCode(92)
// C0 controls and DEL. A title is one plain line, so any of them (a line break included) is refused.
const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`)
// In details a tab and a line break are text; every other control character is not.
const CONTROL_BUT_LINES = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(0x0b)}${String.fromCharCode(0x0c)}${String.fromCharCode(0x0e)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`)

// A character nobody can see is any of the Unicode general categories Cf, Co, Cn, the variation selectors
// U+FE00 to U+FE0F and U+E0100 to U+E01EF - except U+FE0E or U+FE0F straight after an emoji, and U+200D (the
// zero-width joiner) between two emoji parts, which is how a family, a coder or a flag is written. The contract's
// hiddenRule, word for word; the board's api/_voice.js hiddenText is the same function.
const variation = (from, to) => `${BS}u{${from.toString(16)}}-${BS}u{${to.toString(16)}}`
const HIDDEN_CHAR = new RegExp(`[${BS}p{Cf}${BS}p{Co}${BS}p{Cn}${variation(0xfe00, 0xfe0f)}${variation(0xe0100, 0xe01ef)}]`, 'u')
const EMOJI_CHAR = /\p{Emoji}/u
const EMOJI_PART = /\p{Extended_Pictographic}|\p{Emoji_Modifier}/u
const VS15 = String.fromCharCode(0xfe0e)
const VS16 = String.fromCharCode(0xfe0f)
const ZWJ = String.fromCharCode(0x200d)

export function hiddenText(value) {
  if (typeof value !== 'string') return false
  const chars = [...value]
  for (let at = 0; at < chars.length; at += 1) {
    const char = chars[at]
    if (!HIDDEN_CHAR.test(char)) continue
    // (At the start there is no character before, and nothing coerced from undefined is an emoji.)
    if ((char === VS15 || char === VS16) && EMOJI_CHAR.test(chars[at - 1])) continue
    if (char === ZWJ) {
      const before = chars[at - 1] === VS16 ? chars[at - 2] : chars[at - 1]
      if (before !== undefined && EMOJI_PART.test(before) && chars[at + 1] !== undefined && EMOJI_PART.test(chars[at + 1])) continue
    }
    return true
  }
  return false
}

const isText = (value, { min, max }) => typeof value === 'string' && value.length >= min && value.length <= max
// A line of text equal to itself trimmed, with nothing in it that is a control or cannot be seen.
const isPlainLine = (value, rule) => isText(value, rule) && value === value.trim() && !CONTROL.test(value) && !hiddenText(value)
// (The shape has at least one character, so an empty slug needs no check of its own.)
export const isSlug = (value) => typeof value === 'string' && value.length <= FIELD_RULES.slug.max && SLUG_SHAPE.test(value)

// How each field is held. Every one is checked by its name, so a field that is not here cannot be good.
const CHECKS = {
  title: (value) => isPlainLine(value, FIELD_RULES.title),
  details: (value) => isText(value, FIELD_RULES.details) && !CONTROL_BUT_LINES.test(value) && !hiddenText(value),
  for: isSlug,
  model: (value) => MODEL_TIERS.includes(value),
  status: (value) => TASK_STATUSES.includes(value),
  workflow: isSlug
}

// A card named by its file name (a move) or by its row (an approval): the same word, held two ways.
const fieldOk = (action, name, value) => {
  if (name === 'task') return action === 'move' ? isSlug(value) : isPlainLine(value, FIELD_RULES.approve)
  return CHECKS[name](value)
}

// Parsed JSON is plain data. Anything with a prototype of its own, an accessor or a symbol key is not, and is
// refused before one of its properties is read - a getter must never run on an order's say-so.
function isPlainData(value) {
  // (An array has Array.prototype, so the prototype check below refuses it too.)
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  if (Object.getOwnPropertySymbols(value).length) return false
  return Object.getOwnPropertyNames(value).every((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    return descriptor.enumerable && Object.hasOwn(descriptor, 'value')
  })
}

// payload: what the order carried. Returns { ok: true, action, fields } - a copy of exactly the fields the
// action has - or { ok: false }.
export function validatePayload(payload) {
  if (!isPlainData(payload)) return { ok: false }
  if (payload.source !== PAYLOAD_SOURCE) return { ok: false }
  const { action } = payload
  // FIELDS has exactly the contract's actions (tests/mailbox-contract.test.mjs), so it is the list.
  if (typeof action !== 'string' || !Object.hasOwn(FIELDS, action)) return { ok: false }
  const { required, optional } = FIELDS[action]
  const allowed = new Set(['source', 'action', 'instruction', ...required, ...optional])
  for (const name of Object.keys(payload)) {
    if (!allowed.has(name)) return { ok: false }
  }
  if (Object.hasOwn(payload, 'instruction') && typeof payload.instruction !== 'string') return { ok: false }
  const fields = {}
  for (const name of [...required, ...optional]) {
    if (!Object.hasOwn(payload, name)) {
      if (required.includes(name)) return { ok: false }
      continue
    }
    if (!fieldOk(action, name, payload[name])) return { ok: false }
    fields[name] = payload[name]
  }
  return { ok: true, action, fields }
}
