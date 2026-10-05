# Memory benchmark workspace

A bounded experiment workspace for native Pi memory comparisons. The starter manifest selects GLM 5.3 and
DeepSeek V4 Pro 0813, three development scenario families, two checkpoints and two probes per checkpoint, producing
96 paired answer episodes across eight configurations. Three separate families remain held out.

`bun run bench:plan` prints a keyless dry-run; `bun run bench:validate` checks fixtures and manifests. Models do not
generate fixture truth: a local event ledger establishes owner decisions and observed results at each prefix.

This initial slice provides schemas, fixtures, deterministic grading and planning. Native execution and reporting
are added in subsequent coherent changes. Private artifacts belong under `.local/bench/`.
