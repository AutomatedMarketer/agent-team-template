// Small helpers shared by the usage sources. Each one turns an outside value into either a clean
// value or null - never a guess - so a source can treat null as "this answer is not understood".

import { readFile } from 'node:fs/promises'

export const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// ISO time in UTC without milliseconds, which is what the board shows and what the gate accepts.
export function isoSeconds(ms) {
  if (!Number.isFinite(ms)) return null
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

// Reset times arrive as ISO strings (sometimes with microseconds and an offset), as seconds since
// 1970, or as milliseconds. Anything else is null.
export function toIsoTime(raw) {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null
    return isoSeconds(raw > 1e12 ? raw : raw * 1000)
  }
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(raw.trim())) {
    // Date.parse only promises millisecond precision, so trim longer fractions first.
    const trimmed = raw.trim().replace(/(\.\d{3})\d+/, '$1')
    return isoSeconds(Date.parse(trimmed))
  }
  return null
}

// One decimal place, capped at 100: a meter past full is shown full rather than broken. Negative
// or non-numeric is not a percentage at all.
export function cleanPercent(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null
  return Math.min(100, Math.round(raw * 10) / 10)
}

// Reads JSON without ever letting an error message out: fs errors carry full paths, and a full
// path carries the username. The caller gets a state word and, if it worked, the value.
export async function readJson(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    return { state: error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'missing' : 'broken' }
  }
  try {
    return { state: 'ok', value: JSON.parse(text) }
  } catch {
    return { state: 'broken' }
  }
}
