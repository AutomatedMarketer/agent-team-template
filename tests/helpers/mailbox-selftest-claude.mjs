// A fake Claude for the self-test. The self-test asks Claude to try nine things in a fixed order (see selftest.mjs) and reads the
// transcript to see what became of each. This one behaves as Claude Code does, by the rules its docs give, applied to the arguments
// the runner really passes and the settings file it really points at:
//
//   - the tools it says it has are the ones in --tools;
//   - the traps the self-test planted fire, or do not, by claude-traps.mjs (the planted commands are really run);
//   - each of the seven file steps is allowed or refused by claude-permissions.mjs: --restricted, blockReadsOutsideWorkingDirectories,
//     the allow list, and the deny list, where deny beats allow. An allowed step is really done; a refused one is answered with an error.
//
// So a mistake in the runner's flags or settings - a deny rule that covers the folder it works in, a tool name that is allowed
// everywhere - changes what this does, and a test sees it. Options make it misbehave on purpose:
//   through     steps (3-7, outside) that are let through whatever the rules say, really reading or writing the file
//   skip        steps that are never tried
//   unanswered  steps that are tried and never answered
//   refuseInside  its own folder is refused too (the allow rules are broken, so a refusal elsewhere would prove nothing)
//   when(args)  whether the misbehaviour above applies to this run (the web run has its own list of tools)
//   weaken      { dropFlags, settings, addTools, plainAllows, noRestricted, noBlockReads, noDeny }: the run is started as if the runner had
//               left a protection out - so a trap fires, or a wall is not there
//   say(steps, cwd)  one more line the assistant says (to put a secret into what it says)
//   initTools(args)  the tools it says it has, when that is not the --tools list
//   before(cwd, steps, args)  something to do or check before it starts (what is planted, where)
//   record      an array to push each step's decision to: { step, tool, path, allowed, confined, denyList, notAllowed }
//   home        the home folder `~` means in a rule (default: the world's)
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { configFromArgs, decide, lenientRead } from './claude-permissions.mjs'
import { fireTraps, withoutFlags } from './claude-traps.mjs'

const said = (content) => ({ type: 'assistant', message: { content: [{ type: 'text', text: content }] } })
const used = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
const answered = (id, content, isError) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } })

// The text in backticks on numbered line `step` of the prompt: a full path for steps 3 to 7, a name in its own folder for 8 and 9.
export function stepsOf(prompt) {
  const steps = {}
  for (let step = 3; step <= 9; step += 1) steps[step] = new RegExp(`^${step}\\. [^\`\\n]*\`([^\`]+)\``, 'm').exec(prompt)?.[1] ?? null
  return steps
}

const STEPS = [[3, 'Read'], [4, 'Read'], [5, 'Read'], [6, 'Write'], [7, 'Write'], [8, 'Read'], [9, 'Write']]

export function confinedClaude(w, { when = () => true, through = [], skip = [], unanswered = [], refuseInside = false, weaken = null, say = null, before = null, initTools = null, record = null, home = w.root } = {}) {
  return async (cwd, args) => {
    const steps = stepsOf(args[1])
    await before?.(cwd, steps, args)
    const misbehaves = when(args)
    const weak = misbehaves ? weaken ?? {} : {}

    fireTraps(cwd, args, weak)

    const started = withoutFlags(args, weak.dropFlags ?? [])
    const config = configFromArgs(args, { read: lenientRead })
    if (weak.plainAllows) config.allow = ['Read', 'Edit']
    if (weak.noRestricted) config.restricted = false
    if (weak.noBlockReads) config.blockReads = false
    if (weak.noDeny) config.deny = []
    const listed = started.includes('--tools') ? started[started.indexOf('--tools') + 1].split(',') : []
    const events = [{ ...w.INIT, tools: initTools ? initTools(args) : [...listed, ...(weak.addTools ?? [])] }]

    for (const [step, tool] of STEPS) {
      const inside = step >= 8
      if (misbehaves && skip.includes(step)) continue
      const id = `t${step}`
      const target = inside ? join(cwd, steps[step]) : steps[step]
      events.push(used(id, tool, { file_path: steps[step] }))
      if (misbehaves && unanswered.includes(step)) continue
      const decision = decide(config, { tool, path: target, cwd, home })
      record?.push({ step, tool, path: target, ...decision })
      const lets = inside ? decision.allowed && !refuseInside : misbehaves && through.includes(step) ? true : decision.allowed
      if (!lets) {
        events.push(answered(id, `Permission to use ${tool} has been denied.`, true))
        continue
      }
      if (tool === 'Read') {
        events.push(answered(id, [{ type: 'text', text: `1\t${(await readFile(target, 'utf8')).trim()}` }], false))
      } else {
        await writeFile(target, 'done')
        events.push(answered(id, `File created successfully at: ${steps[step]}`, false))
      }
    }
    if (say) events.push(said(await say(steps, cwd)))
    events.push(said('Went through all nine steps.'), w.RESULT)
    return events
  }
}
