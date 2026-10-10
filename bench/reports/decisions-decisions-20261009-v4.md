# Goblin decision evaluation v4

This report covers the 2026-10-09 reruns on the frozen development fixtures and an independent held-out fixture set. The held-out cutoffs are the development cutoffs copied into the immutable held-out manifest; no held-out refitting occurred. Rules and critic rows are deterministic policy evidence; critic is rules first with Clef only for undecided ordinary cases. Provider errors, timeouts, invalid answers and skipped rows are reported separately from judgment quality.

## Development set

The development fixtures and rules share an author, so their exact scores are likely optimistic. The new direct Clef, Clef-flash, Jev and OpenAI Decisions calls settled 1,110 requests without new provider or format failures. The report includes prior compatible diagnostic rows so the three-repetition view is complete.

| Task              | Arm              | Correct / judged |  Exact | Provider / timeout / format / skipped | p50 / p95 ms | Charged USD |
| ----------------- | ---------------- | ---------------: | -----: | ------------------------------------: | -----------: | ----------: |
| context-relevance | rules            |           84/120 |  70.0% |                         0 / 0 / 0 / 0 |        0 / 0 |   $0.000000 |
| context-relevance | critic           |          105/120 |  87.5% |                         0 / 0 / 0 / 0 |      0 / 696 |   $0.009118 |
| context-relevance | cheap-llm        |           89/120 |  74.2% |                         0 / 0 / 0 / 0 |  3879 / 6175 |   $0.164073 |
| context-relevance | clef             |           87/120 |  72.5% |                         0 / 0 / 0 / 0 |    464 / 752 |   $0.026792 |
| context-relevance | clef-flash       |           63/120 |  52.5% |                         0 / 0 / 0 / 0 |    306 / 522 |   $0.010047 |
| context-relevance | jev              |           74/120 |  61.7% |                         0 / 0 / 0 / 0 |    232 / 267 |   $0.003340 |
| context-relevance | openai-decisions |           81/120 |  67.5% |                         0 / 0 / 0 / 0 |    136 / 271 |   $0.014735 |
| brief-update      | rules            |          120/120 | 100.0% |                         0 / 0 / 0 / 0 |        0 / 0 |   $0.000000 |
| brief-update      | critic           |          117/120 |  97.5% |                         0 / 0 / 0 / 0 |      0 / 450 |   $0.006803 |
| brief-update      | cheap-llm        |          120/120 | 100.0% |                         0 / 0 / 0 / 0 |  2862 / 4072 |   $0.101765 |
| brief-update      | clef             |          117/120 |  97.5% |                         0 / 0 / 0 / 0 |    400 / 781 |   $0.015401 |
| brief-update      | clef-flash       |           93/120 |  77.5% |                         0 / 0 / 0 / 0 |    293 / 493 |   $0.005775 |
| brief-update      | jev              |          107/120 |  89.2% |                         0 / 0 / 0 / 0 |    228 / 259 |   $0.002285 |
| brief-update      | openai-decisions |          105/120 |  87.5% |                         0 / 0 / 0 / 0 |    128 / 185 |   $0.007351 |
| attention-triage  | rules            |          111/120 |  92.5% |                         0 / 0 / 0 / 0 |        0 / 0 |   $0.000000 |
| attention-triage  | critic           |          111/120 |  92.5% |                         0 / 0 / 0 / 0 |      0 / 443 |   $0.004055 |
| attention-triage  | cheap-llm        |          106/120 |  88.3% |                         0 / 0 / 0 / 0 |  1914 / 3092 |   $0.057440 |
| attention-triage  | clef             |          111/120 |  92.5% |                         0 / 0 / 0 / 0 |    354 / 680 |   $0.008557 |
| attention-triage  | clef-flash       |           96/120 |  80.0% |                         0 / 0 / 0 / 0 |    277 / 485 |   $0.003209 |
| attention-triage  | jev              |           97/120 |  80.8% |                         0 / 0 / 0 / 0 |    239 / 291 |   $0.001733 |
| attention-triage  | openai-decisions |          117/120 |  97.5% |                         0 / 0 / 0 / 0 |    108 / 180 |   $0.003430 |
| separate-work     | rules            |          108/120 |  90.0% |                         0 / 0 / 0 / 0 |        0 / 0 |   $0.000000 |
| separate-work     | critic           |          111/120 |  92.5% |                         0 / 0 / 0 / 0 |    185 / 510 |   $0.005841 |
| separate-work     | cheap-llm        |           91/120 |  75.8% |                         0 / 0 / 0 / 0 |  1867 / 2654 |   $0.063053 |
| separate-work     | clef             |          108/120 |  90.0% |                         0 / 0 / 0 / 0 |    344 / 523 |   $0.009022 |
| separate-work     | clef-flash       |           57/120 |  47.5% |                         0 / 0 / 0 / 0 |    157 / 481 |   $0.003383 |
| separate-work     | jev              |           96/120 |  80.0% |                         0 / 0 / 0 / 0 |    231 / 265 |   $0.001963 |
| separate-work     | openai-decisions |          108/120 |  90.0% |                         0 / 0 / 0 / 0 |     98 / 157 |   $0.003457 |

Development campaign new spend was $0.146297; historical attempts remain in the private append-only ledger. The private development report shows $0.640711 of all ledger attempts settled through that point, including the prior held-out run and unknown reservations; that aggregate is not development-only or tonight-only spend.

## Held-out set

Claude Sonnet authored 100 cases independently and blind to the rules and scoring. Cheap chat contributes its prior partial repetition plus the 97-call completion run; four invalid brief rows and eight invalid organization rows remain counted as format failures. Ten of these arose during tonight's cheap completion and two were already present; these are decoding failures rather than provider failures. Clef, Clef-flash, Jev and OpenAI Decisions each have three held-out repetitions.

| Task              | Arm              | Correct / judged | Exact | Provider / timeout / format / skipped | p50 / p95 ms | Charged USD |
| ----------------- | ---------------- | ---------------: | ----: | ------------------------------------: | -----------: | ----------: |
| context-relevance | rules            |            18/75 | 24.0% |                         0 / 0 / 0 / 0 |        0 / 0 |   $0.000000 |
| context-relevance | critic           |            51/75 | 68.0% |                         0 / 0 / 0 / 0 |    418 / 836 |   $0.011949 |
| context-relevance | cheap-llm        |            59/75 | 78.7% |                         0 / 0 / 0 / 0 |  3236 / 4754 |   $0.087494 |
| context-relevance | clef             |            54/75 | 72.0% |                         0 / 0 / 0 / 0 |    465 / 611 |   $0.014393 |
| context-relevance | clef-flash       |            48/75 | 64.0% |                         0 / 0 / 0 / 0 |    311 / 499 |   $0.005397 |
| context-relevance | jev              |            57/75 | 76.0% |                         0 / 0 / 0 / 0 |    247 / 287 |   $0.001891 |
| context-relevance | openai-decisions |            48/75 | 64.0% |                         0 / 0 / 0 / 0 |    128 / 165 |   $0.007630 |
| brief-update      | rules            |            27/75 | 36.0% |                         0 / 0 / 0 / 0 |        0 / 0 |   $0.000000 |
| brief-update      | critic           |            33/75 | 44.0% |                         0 / 0 / 0 / 0 |      0 / 435 |   $0.001976 |
| brief-update      | cheap-llm        |            53/71 | 74.6% |                         0 / 0 / 4 / 0 |  3158 / 6560 |   $0.072099 |
| brief-update      | clef             |            54/75 | 72.0% |                         0 / 0 / 0 / 0 |    426 / 897 |   $0.010264 |
| brief-update      | clef-flash       |            45/75 | 60.0% |                         0 / 0 / 0 / 0 |    292 / 474 |   $0.003849 |
| brief-update      | jev              |            54/75 | 72.0% |                         0 / 0 / 0 / 0 |    249 / 283 |   $0.001507 |
| brief-update      | openai-decisions |            48/75 | 64.0% |                         0 / 0 / 0 / 0 |    126 / 160 |   $0.004815 |
| attention-triage  | rules            |            30/75 | 40.0% |                         0 / 0 / 0 / 0 |        0 / 0 |   $0.000000 |
| attention-triage  | critic           |            63/75 | 84.0% |                         0 / 0 / 0 / 0 |    381 / 709 |   $0.005357 |
| attention-triage  | cheap-llm        |            60/75 | 80.0% |                         0 / 0 / 0 / 0 |  1837 / 3825 |   $0.038549 |
| attention-triage  | clef             |            63/75 | 84.0% |                         0 / 0 / 0 / 0 |    339 / 767 |   $0.005641 |
| attention-triage  | clef-flash       |            57/75 | 76.0% |                         0 / 0 / 0 / 0 |    291 / 493 |   $0.002115 |
| attention-triage  | jev              |            58/75 | 77.3% |                         0 / 0 / 0 / 0 |    245 / 338 |   $0.001133 |
| attention-triage  | openai-decisions |            69/75 | 92.0% |                         0 / 0 / 0 / 0 |    105 / 173 |   $0.002235 |
| separate-work     | rules            |            36/75 | 48.0% |                         0 / 0 / 0 / 0 |        0 / 0 |   $0.000000 |
| separate-work     | critic           |            60/75 | 80.0% |                         0 / 0 / 0 / 0 |    377 / 530 |   $0.006173 |
| separate-work     | cheap-llm        |            50/67 | 74.6% |                         0 / 0 / 8 / 0 |  2018 / 2659 |   $0.044028 |
| separate-work     | clef             |            60/75 | 80.0% |                         0 / 0 / 0 / 0 |    342 / 648 |   $0.006173 |
| separate-work     | clef-flash       |            42/75 | 56.0% |                         0 / 0 / 0 / 0 |    304 / 503 |   $0.002315 |
| separate-work     | jev              |            46/75 | 61.3% |                         0 / 0 / 0 / 0 |    237 / 287 |   $0.001308 |
| separate-work     | openai-decisions |            57/75 | 76.0% |                         0 / 0 / 0 / 0 |    103 / 139 |   $0.002326 |

The new held-out campaign spent $0.254208 (all arms plus cheap completion); the total for all new 2026-10-09 manifests is $0.400505, below the $3.50 hard ceiling. The owner-approved unfinished reservation from the prior campaign remains a separate $0.011823 full charge with unknown usage.

## Recommendations

The held-out numbers carry the recommendation. Every threshold below is the frozen development threshold and is a proposal for owner review; no judgment is ready for automatic use because held-out samples are small, the cheap repetition has format failures, and model and rule evidence are not independent of all product decisions.

| Judgment          | Arm  | Frozen threshold | Held-out exact | Recommendation                                                                                                                                                  |
| ----------------- | ---- | ---------------: | -------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context relevance | clef |            0.594 |          54/75 | Frozen inclusion precision 100%, recall 78.1%, and zero wrong-context choices. Cheap chat has higher exact accuracy but misses the 70% inclusion recall target. |
| Brief update      | clef |           0.9158 |          54/75 | Highest complete model exact score (72.0%) without cheap-chat format failures; false decision labels remain.                                                    |
| Attention         | clef |           0.5107 |          63/75 | 84.0%, all held-out highlight cases selected at the frozen threshold; Clef and critic tie.                                                                      |
| Separate work     | clef |           0.7503 |          60/75 | 80.0% and 91.7% positive precision/84.6% recall; critic ties on exact score and makes a model call for every held-out organization case.                        |

No arm is enabled for automatic actions. All outputs remain owner-confirmed proposals. Questions, approvals and failures continue to be surfaced by runtime rules regardless of model score.

## Evidence and limits

Development manifest: `.local/bench/decisions/decisions-dev-20261009/manifest.json`; held-out manifest: `.local/bench/decisions/decisions-heldout-20261009/manifest.json`; held-out fixture count: 100 (25 per task). Private request/response traces and append-only attempts remain under `.local/bench/decisions/`. This is local benchmark evidence, not deployed acceptance or production proof.
