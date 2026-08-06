# Prompt blocks — do not reword

Each file here is copied verbatim from Anthropic's published prompting guidance, via
`2026-08-06-model-and-prompting-standard.md`. Agents carry these blocks inline between
markers:

    <!-- prompt-block: unattended-run -->
    ...text...
    <!-- /prompt-block -->

`npm test` compares the text between the markers to the file here, byte for byte. If you
want to change what an agent is told, add your own instruction outside the markers.

`node scripts/sync-prompt-blocks.mjs` rewrites every marked region from these files. Run
it after editing a block here.

Which agent carries which block is set in `scripts/lib/agents.mjs` and checked by
`tests/agents.test.mjs`.
