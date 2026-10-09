// How a scheduled job is scheduled, and when it should last have run - the schedule side of the
// jobs part. Pure code: no file, no program, no clock of its own. The schedules come from two
// places and arrive as plain values:
//   launchd   StartCalendarInterval (one dictionary, or a list of them) and StartInterval (seconds)
//   Hermes    a cron expression such as "30 6 * * *"
// and both become one of the four cadences in jobs-schema.mjs: always, every N minutes, slots (set
// times), or unknown. Anything this does not understand is `unknown` - never a guess - and a job
// with an unknown schedule has no due times, so the board cannot call it late.
//
// dueTimes() then answers the one question the board needs: when did this job last have to run?
// It looks back from the check time minus the running grace, in the job's own timezone, and returns
// the two most recent times. Wall-clock times are turned into instants with Intl offsets, so a
// daylight-saving change is handled where it happens: a time that does not exist (the clocks jump
// over it) is skipped, and a time that happens twice takes the earlier one.

import { isoSeconds, isPlainObject } from './util.mjs'
import { CADENCE, JOBS_CAPS, GRACE_MINUTES, LOOKBACK_DAYS } from './jobs-schema.mjs'

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000
const HOURS = Array.from({ length: 24 }, (_, hour) => hour)

const unknown = () => ({ kind: 'unknown' })

// --- slots: one shape, one order, one copy of each ---------------------------------------------------

function slotOf(minute, hour, weekday, day) {
  const slot = { minute }
  if (hour !== undefined) slot.hour = hour
  if (weekday !== undefined) slot.weekday = weekday
  if (day !== undefined) slot.day = day
  return slot
}

// The order the contract promises: day, weekday, hour, then minute, a missing value first. The same
// schedule always writes the same bytes, so an unchanged reading commits nothing.
const bySlot = (a, b) =>
  (a.day ?? -1) - (b.day ?? -1) || (a.weekday ?? -1) - (b.weekday ?? -1) || (a.hour ?? -1) - (b.hour ?? -1) || a.minute - b.minute

function slotsCadence(slots) {
  const distinct = new Map()
  for (const slot of slots) distinct.set(JSON.stringify(slot), slot)
  const list = [...distinct.values()].sort(bySlot)
  return list.length >= 1 && list.length <= JOBS_CAPS.slots ? { kind: 'slots', slots: list } : unknown()
}

const withinBounds = (value, { min, max }) => Number.isInteger(value) && value >= min && value <= max

// --- launchd ---------------------------------------------------------------------------------------------

// One StartCalendarInterval dictionary as a slot, or null. launchd treats a missing key as "every",
// so a dictionary with no Minute means every minute - which is not a schedule this can write down.
// A Month, or a Day together with a Weekday, is not one either (launchd does not say whether the
// two are both needed or either is enough), and neither is a key launchd does not have.
function slotFromCalendarEntry(entry) {
  if (!isPlainObject(entry)) return null
  const keys = Object.keys(entry)
  if (keys.some((key) => !['Minute', 'Hour', 'Day', 'Weekday'].includes(key))) return null
  if (!withinBounds(entry.Minute, CADENCE.slot.minute)) return null
  if (entry.Hour !== undefined && !withinBounds(entry.Hour, CADENCE.slot.hour)) return null
  if (entry.Day !== undefined && !withinBounds(entry.Day, CADENCE.slot.day)) return null
  // launchd counts Sunday as 0 and as 7.
  if (entry.Weekday !== undefined && !withinBounds(entry.Weekday, { min: 0, max: 7 })) return null
  if (entry.Day !== undefined && entry.Weekday !== undefined) return null
  return slotOf(entry.Minute, entry.Hour, entry.Weekday === undefined ? undefined : entry.Weekday % 7, entry.Day)
}

export function cadenceFromCalendar(value) {
  const entries = Array.isArray(value) ? value : [value]
  if (!entries.length) return unknown()
  const slots = []
  for (const entry of entries) {
    const slot = slotFromCalendarEntry(entry)
    if (!slot) return unknown()
    slots.push(slot)
  }
  return slotsCadence(slots)
}

// StartInterval is seconds; the board talks in whole minutes, and a job that runs more often than
// once a minute is "every minute".
export function cadenceFromInterval(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return unknown()
  const minutes = Math.max(1, Math.round(seconds / 60))
  return withinBounds(minutes, CADENCE.everyMinutes) ? { kind: 'every', minutes } : unknown()
}

// --- cron ------------------------------------------------------------------------------------------------------

// One cron field as a set of numbers: * , */s , a , a-b , a-b/s , and lists of those. Names (MON,
// JAN) and a bare a/s are not read. null when it is anything else or out of range.
function cronField(text, min, max) {
  const values = new Set()
  for (const part of text.split(',')) {
    const match = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (!match) return null
    const [, star, from, to, stepText] = match
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!(step >= 1)) return null
    if (!star && to === undefined && stepText !== undefined) return null
    const low = star ? min : Number(from)
    const high = star ? max : to === undefined ? low : Number(to)
    if (low < min || high > max || low > high) return null
    for (let value = low; value <= high; value += step) values.add(value)
  }
  return values
}

const sortedNumbers = (set) => [...set].sort((a, b) => a - b)

// Minutes that run at 0, s, 2s ... through the hour - every s minutes, whatever the hour.
function minuteStep(minutes) {
  if (minutes.size < 2) return null
  const step = 60 / minutes.size
  if (!Number.isInteger(step)) return null
  return sortedNumbers(minutes).every((minute, index) => minute === index * step) ? step : null
}

export function cadenceFromCron(expression) {
  if (typeof expression !== 'string') return unknown()
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return unknown()
  const [minuteText, hourText, dayText, monthText, weekdayText] = fields
  const minutes = cronField(minuteText, 0, 59)
  const hours = cronField(hourText, 0, 23)
  const months = cronField(monthText, 1, 12)
  const weekdays = cronField(weekdayText, 0, 7)
  if (!minutes || !hours || !months || !weekdays) return unknown()
  // A month other than every month is not a schedule the board can judge.
  if (months.size !== 12) return unknown()
  // Cron counts Sunday as 0 and as 7.
  const weekdayList = sortedNumbers(new Set([...weekdays].map((weekday) => weekday % 7)))
  const everyWeekday = weekdayList.length === 7
  let day
  if (dayText !== '*') {
    if (!/^\d{1,2}$/.test(dayText)) return unknown()
    day = Number(dayText)
    if (!withinBounds(day, CADENCE.slot.day)) return unknown()
    // Cron runs a job when the day of the month OR the weekday matches, whenever both are written
    // (neither is a bare `*`) - even a weekday range that covers every day, so croniter, which Hermes
    // uses, runs `0 9 1 * 0-6` daily. This file does not say "or", so both written is unknown.
    if (weekdayText !== '*') return unknown()
  }
  const everyHour = hours.size === 24
  if (everyHour && day === undefined && everyWeekday) {
    const step = minuteStep(minutes)
    if (step) return { kind: 'every', minutes: step }
  }
  const minuteList = sortedNumbers(minutes)
  const hourList = everyHour ? [undefined] : sortedNumbers(hours)
  const weekdayChoices = everyWeekday ? [undefined] : weekdayList
  if (minuteList.length * hourList.length * weekdayChoices.length > JOBS_CAPS.slots) return unknown()
  const slots = []
  for (const minute of minuteList) for (const hour of hourList) for (const weekday of weekdayChoices) slots.push(slotOf(minute, hour, weekday, day))
  return slotsCadence(slots)
}

// --- wall-clock time in a zone ---------------------------------------------------------------------------

const formatters = new Map()
const zoneNames = new Map()

// A zone's name as this runtime spells it - an alias such as Asia/Kolkata comes back as the older
// Asia/Calcutta, US/Eastern as America/New_York - or null when it is not a zone at all. Two names
// are the same zone exactly when their canonical names are equal.
export function canonicalZone(zone) {
  if (typeof zone !== 'string' || !zone) return null
  if (!zoneNames.has(zone)) {
    try {
      zoneNames.set(zone, new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone)
    } catch {
      zoneNames.set(zone, null)
    }
  }
  return zoneNames.get(zone)
}

// The date and time on a wall clock in `zone` at the instant `ms`.
function wallParts(zone, ms) {
  let formatter = formatters.get(zone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric'
    })
    formatters.set(zone, formatter)
  }
  const parts = {}
  for (const { type, value } of formatter.formatToParts(ms)) if (type !== 'literal') parts[type] = Number(value)
  // Some engines write midnight as 24.
  if (parts.hour === 24) parts.hour = 0
  return parts
}

// How far the wall clock in `zone` is ahead of UTC at the instant `ms`, in milliseconds.
function offsetAt(zone, ms) {
  const wall = wallParts(zone, ms)
  const whole = ms - (((ms % 1000) + 1000) % 1000)
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - whole
}

// The instant a wall-clock time happens in `zone`: the earlier one when it happens twice (the
// clocks went back), null when it never happens (the clocks jumped over it). The offsets a day
// either side of the time are the ones in force before and after any change near it; each makes a
// candidate instant, and a candidate counts only if the zone's wall clock really shows that time then.
export function wallToInstant(zone, year, month, day, hour, minute) {
  const naive = Date.UTC(year, month - 1, day, hour, minute)
  const candidates = new Set()
  for (const probe of [naive - DAY_MS, naive + DAY_MS]) {
    const instant = naive - offsetAt(zone, probe)
    const wall = wallParts(zone, instant)
    if (wall.year === year && wall.month === month && wall.day === day && wall.hour === hour && wall.minute === minute) candidates.add(instant)
  }
  return candidates.size ? Math.min(...candidates) : null
}

// --- when it last had to run -----------------------------------------------------------------------------

// The two latest expected runs of a set of slots, at or before `limitMs` and no more than
// LOOKBACK_DAYS days before it, newest first. Days are walked back from the limit's own date on the
// wall clock; a later day always holds later instants, so the walk stops once two are found.
function slotRuns(slots, zone, limitMs) {
  const today = wallParts(zone, limitMs)
  const earliest = limitMs - LOOKBACK_DAYS * DAY_MS
  const found = new Set()
  for (let back = 0; back <= LOOKBACK_DAYS && found.size < 2; back += 1) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day - back))
    const year = date.getUTCFullYear()
    const month = date.getUTCMonth() + 1
    const dayOfMonth = date.getUTCDate()
    const weekday = date.getUTCDay()
    for (const slot of slots) {
      if (slot.weekday !== undefined && slot.weekday !== weekday) continue
      if (slot.day !== undefined && slot.day !== dayOfMonth) continue
      for (const hour of slot.hour === undefined ? HOURS : [slot.hour]) {
        const at = wallToInstant(zone, year, month, dayOfMonth, hour, slot.minute)
        if (at !== null && at <= limitMs && at >= earliest) found.add(at)
      }
    }
  }
  return [...found].sort((a, b) => b - a).slice(0, 2)
}

// An interval job's phase is not known, so the runs are placed as far back as the interval allows:
// a job that runs every N minutes has certainly run within N minutes of the limit.
function intervalRuns(minutes, limitMs) {
  const step = minutes * MINUTE_MS
  return [1, 2].map((times) => limitMs - times * step).filter((at) => limitMs - at <= LOOKBACK_DAYS * DAY_MS)
}

// { dueAt, dueBeforeAt } as ISO times, or fewer keys (or none) when fewer expected runs are known.
// `takenAtMs` is the check time; the limit is that minus the running grace. A cadence with no set
// times, or a timezone this runtime does not know, gives {}.
export function dueTimes(cadence, zone, takenAtMs) {
  const named = canonicalZone(zone)
  if (!Number.isFinite(takenAtMs) || !named || !isPlainObject(cadence)) return {}
  // The file's takenAt is whole seconds; so is everything worked out from it.
  const limitMs = Math.floor(takenAtMs / 1000) * 1000 - GRACE_MINUTES * MINUTE_MS
  let runs = []
  if (cadence.kind === 'slots' && Array.isArray(cadence.slots)) runs = slotRuns(cadence.slots, named, limitMs)
  else if (cadence.kind === 'every' && Number.isInteger(cadence.minutes) && cadence.minutes >= 1) runs = intervalRuns(cadence.minutes, limitMs)
  const due = {}
  if (runs[0] !== undefined) due.dueAt = isoSeconds(runs[0])
  if (runs[1] !== undefined) due.dueBeforeAt = isoSeconds(runs[1])
  return due
}
