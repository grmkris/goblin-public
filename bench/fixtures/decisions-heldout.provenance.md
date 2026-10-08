# Held-out decision fixtures provenance

This 100-case set (25 per task) was written independently by Claude Sonnet on 2026-10-08,
without seeing `bench/src/decisions/rules.ts`, `scoring.ts`, `questions.ts`, or the development
report. It is a blind held-out evaluation set, not production data.

The reviewed normalization map is explicit and identity-preserving for every spelling present in
the source: `open-question` -> `open-question`, `show-on-return` -> `show-on-return`,
`suggest-thread` -> `suggest-thread`, `uncertain` -> `uncertain`, `finding` -> `finding`,
`goal` -> `goal`, `constraint` -> `constraint`, `decision` -> `decision`, `none` -> `none`,
`yes` -> `yes`, `no` -> `no`, `quiet` -> `quiet`, `recap` -> `recap`, `highlight` -> `highlight`,
`continue-here` -> `continue-here`, `suggest-topic` -> `suggest-topic`, and every
`reuse-existing:<id>` value -> itself. No label was changed to match the rules.
