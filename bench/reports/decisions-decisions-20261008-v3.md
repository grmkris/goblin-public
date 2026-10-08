# Goblin decision-model evaluation

Run decisions-20261008-v3; fixture SHA-256 d25f35a7d95d98df77a755f7b453e114229a142a0e10d0c6e9b3454fad39b560; source SHA-256 f683c4224e3af69a7ab63c60af3d4bd40d81fadf0a0a802c569257f123e3362c.
Included sources: decisions-20261008-v2 (93731b08794f8e387ca167b016adaf3c2f45d6ee3419297f4e73000f4982ae42); decisions-20261008-v3 (f683c4224e3af69a7ab63c60af3d4bd40d81fadf0a0a802c569257f123e3362c). Later included rows supersede earlier matching arm/case/repetition rows; all original attempts and costs remain in the ledger.

160 synthetic labelled cases, 40 per task. Three live repetitions share the frozen fixture set. Each task covers ordinary, ambiguous, contradictory, missing, stale and do-nothing evidence. Relevance has 3–8 permitted candidates and none-relevant. Brief updates score type, duplicate and conflict together. Attention contains ordinary results only. Organization uses only offered existing IDs.

| Task              | Arm              | Correct / judged | Accuracy | Question accuracy | Errors / timeouts / format / skipped | Rules | p50 / p95 ms | Charged USD | Priced USD |
| ----------------- | ---------------- | ---------------: | -------: | ----------------: | -----------------------------------: | ----: | -----------: | ----------: | ---------: |
| context-relevance | rules            |           84/120 |    70.0% |             86.8% |                              0/0/0/0 |   120 |          0/0 |   $0.000000 |  $0.000000 |
| context-relevance | critic           |            66/81 |    81.5% |             91.8% |                             0/0/0/39 |    81 |          0/0 |   $0.000000 |  $0.000000 |
| context-relevance | cheap-llm        |           89/120 |    74.2% |             92.0% |                              0/0/0/0 |     0 |    3879/6175 |   $0.164073 |    unknown |
| context-relevance | clef             |              0/0 |      n/a |               n/a |                            0/0/0/120 |     0 |    null/null |   $0.000000 |  $0.000000 |
| context-relevance | clef-flash       |              0/0 |      n/a |               n/a |                            0/0/0/120 |     0 |    null/null |   $0.000000 |  $0.000000 |
| context-relevance | jev              |           72/120 |    60.0% |             90.4% |                              0/0/0/0 |     0 |      302/408 |   $0.003340 |  $0.003340 |
| context-relevance | openai-decisions |              0/0 |      n/a |               n/a |                            2/0/0/118 |     0 |          5/5 |   $0.000480 |    unknown |
| brief-update      | rules            |          120/120 |   100.0% |            100.0% |                              0/0/0/0 |   120 |          0/0 |   $0.000000 |  $0.000000 |
| brief-update      | critic           |            72/72 |   100.0% |            100.0% |                             0/0/0/48 |    72 |          0/0 |   $0.000000 |  $0.000000 |
| brief-update      | cheap-llm        |          120/120 |   100.0% |            100.0% |                              0/0/0/0 |     0 |    2862/4072 |   $0.101765 |    unknown |
| brief-update      | clef             |              0/0 |      n/a |               n/a |                            0/0/0/120 |     0 |    null/null |   $0.000000 |  $0.000000 |
| brief-update      | clef-flash       |              0/0 |      n/a |               n/a |                            0/0/0/120 |     0 |    null/null |   $0.000000 |  $0.000000 |
| brief-update      | jev              |          106/120 |    88.3% |             96.1% |                              0/0/0/0 |     0 |      298/339 |   $0.002285 |  $0.002285 |
| brief-update      | openai-decisions |              0/0 |      n/a |               n/a |                            0/0/0/120 |     0 |    null/null |   $0.000000 |  $0.000000 |
| attention-triage  | rules            |          111/120 |    92.5% |             92.5% |                              0/0/0/0 |   120 |          0/0 |   $0.000000 |  $0.000000 |
| attention-triage  | critic           |            75/75 |   100.0% |            100.0% |                             0/0/0/45 |    75 |          0/0 |   $0.000000 |  $0.000000 |
| attention-triage  | cheap-llm        |          106/120 |    88.3% |             88.3% |                              0/0/0/0 |     0 |    1914/3092 |   $0.057440 |    unknown |
| attention-triage  | clef             |              0/0 |      n/a |               n/a |                            0/0/0/120 |     0 |    null/null |   $0.000000 |  $0.000000 |
| attention-triage  | clef-flash       |              0/0 |      n/a |               n/a |                            0/0/0/120 |     0 |    null/null |   $0.000000 |  $0.000000 |
| attention-triage  | jev              |           99/120 |    82.5% |             82.5% |                              0/0/0/0 |     0 |      291/365 |   $0.001733 |  $0.001733 |
| attention-triage  | openai-decisions |              0/0 |      n/a |               n/a |                            0/0/0/120 |     0 |    null/null |   $0.000000 |  $0.000000 |
| separate-work     | rules            |          108/120 |    90.0% |             90.0% |                              0/0/0/0 |   120 |          0/0 |   $0.000000 |  $0.000000 |
| separate-work     | critic           |            54/54 |   100.0% |            100.0% |                             0/0/0/66 |    54 |          0/0 |   $0.000000 |  $0.000000 |
| separate-work     | cheap-llm        |           91/120 |    75.8% |             75.8% |                              0/0/0/0 |     0 |    1867/2654 |   $0.063053 |    unknown |
| separate-work     | clef             |              0/0 |      n/a |               n/a |                            0/0/0/120 |     0 |    null/null |   $0.000000 |  $0.000000 |
| separate-work     | clef-flash       |              0/0 |      n/a |               n/a |                            0/0/0/120 |     0 |    null/null |   $0.000000 |  $0.000000 |
| separate-work     | jev              |           96/120 |    80.0% |             80.0% |                              0/0/0/0 |     0 |      299/387 |   $0.001963 |  $0.001963 |
| separate-work     | openai-decisions |              0/0 |      n/a |               n/a |                            0/0/0/120 |     0 |    null/null |   $0.000000 |  $0.000000 |

| Task              | Arm              | Wrong context | Wrong decision type | Missed highlights | Extra highlights | Extra organization | Threshold | Precision | Recall |
| ----------------- | ---------------- | ------------: | ------------------: | ----------------: | ---------------: | -----------------: | --------: | --------: | -----: |
| context-relevance | rules            |             0 |                   0 |                 0 |                0 |                  0 |    0.0000 |     16.3% | 100.0% |
| context-relevance | critic           |             0 |                   0 |                 0 |                0 |                  0 |    0.0000 |     16.0% | 100.0% |
| context-relevance | cheap-llm        |            20 |                   0 |                 0 |                0 |                  0 |    0.9500 |     84.1% |  82.1% |
| context-relevance | clef             |             0 |                   0 |                 0 |                0 |                  0 |       n/a |       n/a |    n/a |
| context-relevance | clef-flash       |             0 |                   0 |                 0 |                0 |                  0 |       n/a |       n/a |    n/a |
| context-relevance | jev              |            13 |                   0 |                 0 |                0 |                  0 |    0.6900 |    100.0% |  76.2% |
| context-relevance | openai-decisions |             0 |                   0 |                 0 |                0 |                  0 |       n/a |       n/a |    n/a |
| brief-update      | rules            |             0 |                   0 |                 0 |                0 |                  0 |    1.0000 |    100.0% | 100.0% |
| brief-update      | critic           |             0 |                   0 |                 0 |                0 |                  0 |    1.0000 |    100.0% | 100.0% |
| brief-update      | cheap-llm        |             0 |                   0 |                 0 |                0 |                  0 |    0.9000 |    100.0% | 100.0% |
| brief-update      | clef             |             0 |                   0 |                 0 |                0 |                  0 |       n/a |       n/a |    n/a |
| brief-update      | clef-flash       |             0 |                   0 |                 0 |                0 |                  0 |       n/a |       n/a |    n/a |
| brief-update      | jev              |             0 |                   4 |                 0 |                0 |                  0 |    0.8800 |    100.0% |  95.8% |
| brief-update      | openai-decisions |             0 |                   0 |                 0 |                0 |                  0 |       n/a |       n/a |    n/a |
| attention-triage  | rules            |             0 |                   0 |                 3 |                0 |                  0 |    1.0000 |    100.0% |  87.5% |
| attention-triage  | critic           |             0 |                   0 |                 0 |                0 |                  0 |    1.0000 |    100.0% | 100.0% |
| attention-triage  | cheap-llm        |             0 |                   0 |                 0 |                0 |                  0 |    0.8000 |    100.0% | 100.0% |
| attention-triage  | clef             |             0 |                   0 |                 0 |                0 |                  0 |       n/a |       n/a |    n/a |
| attention-triage  | clef-flash       |             0 |                   0 |                 0 |                0 |                  0 |       n/a |       n/a |    n/a |
| attention-triage  | jev              |             0 |                   0 |                 0 |               12 |                  0 |    0.9700 |    100.0% | 100.0% |
| attention-triage  | openai-decisions |             0 |                   0 |                 0 |                0 |                  0 |       n/a |       n/a |    n/a |
| separate-work     | rules            |             0 |                   0 |                 0 |                0 |                  0 |    1.0000 |    100.0% |  87.5% |
| separate-work     | critic           |             0 |                   0 |                 0 |                0 |                  0 |    1.0000 |    100.0% | 100.0% |
| separate-work     | cheap-llm        |             0 |                   0 |                 0 |                0 |                 11 |    0.8500 |    100.0% |  87.5% |
| separate-work     | clef             |             0 |                   0 |                 0 |                0 |                  0 |       n/a |       n/a |    n/a |
| separate-work     | clef-flash       |             0 |                   0 |                 0 |                0 |                  0 |       n/a |       n/a |    n/a |
| separate-work     | jev              |             0 |                   0 |                 0 |                0 |                  3 |    0.8000 |    100.0% | 100.0% |
| separate-work     | openai-decisions |             0 |                   0 |                 0 |                0 |                  0 |       n/a |       n/a |    n/a |

Accuracy requires every question for a case to match. Provider/timeout/format failures are separate from judgment errors. Prices use published input rates for Clef ($0.24/M), Clef-flash ($0.09/M), Jev ($0.042/M) and Decisions ($0.10/M). Cheap chat charges use a conservative $1/M input + $5/M completion rate because the CLIProxy invoice rate is unavailable; priced cost stays unknown. Unknown usage retains the complete reservation. Batch latency is shared by its two cases; rule-only latency is zero. Failed and denied calls remain charged where inference usage is unknown.

| Task              | Arm              | Probability bucket |   N | Mean confidence | Correctness |
| ----------------- | ---------------- | ------------------ | --: | --------------: | ----------: |
| context-relevance | rules            | 0.0–0.2            |   0 |             n/a |         n/a |
| context-relevance | rules            | 0.2–0.4            |   0 |             n/a |         n/a |
| context-relevance | rules            | 0.4–0.6            |   0 |             n/a |         n/a |
| context-relevance | rules            | 0.6–0.8            |   0 |             n/a |         n/a |
| context-relevance | rules            | 0.8–1.0            | 636 |          100.0% |       86.8% |
| context-relevance | critic           | 0.0–0.2            |   0 |             n/a |         n/a |
| context-relevance | critic           | 0.2–0.4            |   0 |             n/a |         n/a |
| context-relevance | critic           | 0.4–0.6            |   0 |             n/a |         n/a |
| context-relevance | critic           | 0.6–0.8            |   0 |             n/a |         n/a |
| context-relevance | critic           | 0.8–1.0            | 438 |          100.0% |       91.8% |
| context-relevance | cheap-llm        | 0.0–0.2            |   0 |             n/a |         n/a |
| context-relevance | cheap-llm        | 0.2–0.4            |   0 |             n/a |         n/a |
| context-relevance | cheap-llm        | 0.4–0.6            |   0 |             n/a |         n/a |
| context-relevance | cheap-llm        | 0.6–0.8            |   0 |             n/a |         n/a |
| context-relevance | cheap-llm        | 0.8–1.0            | 636 |           98.2% |       92.0% |
| context-relevance | clef             | 0.0–0.2            |   0 |             n/a |         n/a |
| context-relevance | clef             | 0.2–0.4            |   0 |             n/a |         n/a |
| context-relevance | clef             | 0.4–0.6            |   0 |             n/a |         n/a |
| context-relevance | clef             | 0.6–0.8            |   0 |             n/a |         n/a |
| context-relevance | clef             | 0.8–1.0            |   0 |             n/a |         n/a |
| context-relevance | clef-flash       | 0.0–0.2            |   0 |             n/a |         n/a |
| context-relevance | clef-flash       | 0.2–0.4            |   0 |             n/a |         n/a |
| context-relevance | clef-flash       | 0.4–0.6            |   0 |             n/a |         n/a |
| context-relevance | clef-flash       | 0.6–0.8            |   0 |             n/a |         n/a |
| context-relevance | clef-flash       | 0.8–1.0            |   0 |             n/a |         n/a |
| context-relevance | jev              | 0.0–0.2            |   0 |             n/a |         n/a |
| context-relevance | jev              | 0.2–0.4            |   0 |             n/a |         n/a |
| context-relevance | jev              | 0.4–0.6            |  14 |           55.4% |       57.1% |
| context-relevance | jev              | 0.6–0.8            |  82 |           70.6% |       50.0% |
| context-relevance | jev              | 0.8–1.0            | 540 |           95.3% |       97.4% |
| context-relevance | openai-decisions | 0.0–0.2            |   0 |             n/a |         n/a |
| context-relevance | openai-decisions | 0.2–0.4            |   0 |             n/a |         n/a |
| context-relevance | openai-decisions | 0.4–0.6            |   0 |             n/a |         n/a |
| context-relevance | openai-decisions | 0.6–0.8            |   0 |             n/a |         n/a |
| context-relevance | openai-decisions | 0.8–1.0            |   0 |             n/a |         n/a |
| brief-update      | rules            | 0.0–0.2            |   0 |             n/a |         n/a |
| brief-update      | rules            | 0.2–0.4            |   0 |             n/a |         n/a |
| brief-update      | rules            | 0.4–0.6            |   0 |             n/a |         n/a |
| brief-update      | rules            | 0.6–0.8            |   0 |             n/a |         n/a |
| brief-update      | rules            | 0.8–1.0            | 360 |          100.0% |      100.0% |
| brief-update      | critic           | 0.0–0.2            |   0 |             n/a |         n/a |
| brief-update      | critic           | 0.2–0.4            |   0 |             n/a |         n/a |
| brief-update      | critic           | 0.4–0.6            |   0 |             n/a |         n/a |
| brief-update      | critic           | 0.6–0.8            |   0 |             n/a |         n/a |
| brief-update      | critic           | 0.8–1.0            | 216 |          100.0% |      100.0% |
| brief-update      | cheap-llm        | 0.0–0.2            |   0 |             n/a |         n/a |
| brief-update      | cheap-llm        | 0.2–0.4            |   0 |             n/a |         n/a |
| brief-update      | cheap-llm        | 0.4–0.6            |   2 |           60.0% |      100.0% |
| brief-update      | cheap-llm        | 0.6–0.8            |   1 |           70.0% |      100.0% |
| brief-update      | cheap-llm        | 0.8–1.0            | 357 |           99.2% |      100.0% |
| brief-update      | clef             | 0.0–0.2            |   0 |             n/a |         n/a |
| brief-update      | clef             | 0.2–0.4            |   0 |             n/a |         n/a |
| brief-update      | clef             | 0.4–0.6            |   0 |             n/a |         n/a |
| brief-update      | clef             | 0.6–0.8            |   0 |             n/a |         n/a |
| brief-update      | clef             | 0.8–1.0            |   0 |             n/a |         n/a |
| brief-update      | clef-flash       | 0.0–0.2            |   0 |             n/a |         n/a |
| brief-update      | clef-flash       | 0.2–0.4            |   0 |             n/a |         n/a |
| brief-update      | clef-flash       | 0.4–0.6            |   0 |             n/a |         n/a |
| brief-update      | clef-flash       | 0.6–0.8            |   0 |             n/a |         n/a |
| brief-update      | clef-flash       | 0.8–1.0            |   0 |             n/a |         n/a |
| brief-update      | jev              | 0.0–0.2            |   0 |             n/a |         n/a |
| brief-update      | jev              | 0.2–0.4            |   0 |             n/a |         n/a |
| brief-update      | jev              | 0.4–0.6            |  23 |           54.4% |       56.5% |
| brief-update      | jev              | 0.6–0.8            |  38 |           72.9% |       92.1% |
| brief-update      | jev              | 0.8–1.0            | 299 |           91.8% |       99.7% |
| brief-update      | openai-decisions | 0.0–0.2            |   0 |             n/a |         n/a |
| brief-update      | openai-decisions | 0.2–0.4            |   0 |             n/a |         n/a |
| brief-update      | openai-decisions | 0.4–0.6            |   0 |             n/a |         n/a |
| brief-update      | openai-decisions | 0.6–0.8            |   0 |             n/a |         n/a |
| brief-update      | openai-decisions | 0.8–1.0            |   0 |             n/a |         n/a |
| attention-triage  | rules            | 0.0–0.2            |   0 |             n/a |         n/a |
| attention-triage  | rules            | 0.2–0.4            |   0 |             n/a |         n/a |
| attention-triage  | rules            | 0.4–0.6            |   0 |             n/a |         n/a |
| attention-triage  | rules            | 0.6–0.8            |   0 |             n/a |         n/a |
| attention-triage  | rules            | 0.8–1.0            | 120 |          100.0% |       92.5% |
| attention-triage  | critic           | 0.0–0.2            |   0 |             n/a |         n/a |
| attention-triage  | critic           | 0.2–0.4            |   0 |             n/a |         n/a |
| attention-triage  | critic           | 0.4–0.6            |   0 |             n/a |         n/a |
| attention-triage  | critic           | 0.6–0.8            |   0 |             n/a |         n/a |
| attention-triage  | critic           | 0.8–1.0            |  75 |          100.0% |      100.0% |
| attention-triage  | cheap-llm        | 0.0–0.2            |   0 |             n/a |         n/a |
| attention-triage  | cheap-llm        | 0.2–0.4            |   0 |             n/a |         n/a |
| attention-triage  | cheap-llm        | 0.4–0.6            |   6 |           55.0% |       50.0% |
| attention-triage  | cheap-llm        | 0.6–0.8            |   9 |           70.0% |       66.7% |
| attention-triage  | cheap-llm        | 0.8–1.0            | 105 |           89.0% |       92.4% |
| attention-triage  | clef             | 0.0–0.2            |   0 |             n/a |         n/a |
| attention-triage  | clef             | 0.2–0.4            |   0 |             n/a |         n/a |
| attention-triage  | clef             | 0.4–0.6            |   0 |             n/a |         n/a |
| attention-triage  | clef             | 0.6–0.8            |   0 |             n/a |         n/a |
| attention-triage  | clef             | 0.8–1.0            |   0 |             n/a |         n/a |
| attention-triage  | clef-flash       | 0.0–0.2            |   0 |             n/a |         n/a |
| attention-triage  | clef-flash       | 0.2–0.4            |   0 |             n/a |         n/a |
| attention-triage  | clef-flash       | 0.4–0.6            |   0 |             n/a |         n/a |
| attention-triage  | clef-flash       | 0.6–0.8            |   0 |             n/a |         n/a |
| attention-triage  | clef-flash       | 0.8–1.0            |   0 |             n/a |         n/a |
| attention-triage  | jev              | 0.0–0.2            |   0 |             n/a |         n/a |
| attention-triage  | jev              | 0.2–0.4            |   2 |           37.5% |        0.0% |
| attention-triage  | jev              | 0.4–0.6            |  28 |           50.6% |       32.1% |
| attention-triage  | jev              | 0.6–0.8            |  10 |           66.4% |      100.0% |
| attention-triage  | jev              | 0.8–1.0            |  80 |           94.0% |      100.0% |
| attention-triage  | openai-decisions | 0.0–0.2            |   0 |             n/a |         n/a |
| attention-triage  | openai-decisions | 0.2–0.4            |   0 |             n/a |         n/a |
| attention-triage  | openai-decisions | 0.4–0.6            |   0 |             n/a |         n/a |
| attention-triage  | openai-decisions | 0.6–0.8            |   0 |             n/a |         n/a |
| attention-triage  | openai-decisions | 0.8–1.0            |   0 |             n/a |         n/a |
| separate-work     | rules            | 0.0–0.2            |   0 |             n/a |         n/a |
| separate-work     | rules            | 0.2–0.4            |   0 |             n/a |         n/a |
| separate-work     | rules            | 0.4–0.6            |   0 |             n/a |         n/a |
| separate-work     | rules            | 0.6–0.8            |   0 |             n/a |         n/a |
| separate-work     | rules            | 0.8–1.0            | 120 |          100.0% |       90.0% |
| separate-work     | critic           | 0.0–0.2            |   0 |             n/a |         n/a |
| separate-work     | critic           | 0.2–0.4            |   0 |             n/a |         n/a |
| separate-work     | critic           | 0.4–0.6            |   0 |             n/a |         n/a |
| separate-work     | critic           | 0.6–0.8            |   0 |             n/a |         n/a |
| separate-work     | critic           | 0.8–1.0            |  54 |          100.0% |      100.0% |
| separate-work     | cheap-llm        | 0.0–0.2            |   0 |             n/a |         n/a |
| separate-work     | cheap-llm        | 0.2–0.4            |   0 |             n/a |         n/a |
| separate-work     | cheap-llm        | 0.4–0.6            |   1 |           60.0% |        0.0% |
| separate-work     | cheap-llm        | 0.6–0.8            |  26 |           70.4% |       50.0% |
| separate-work     | cheap-llm        | 0.8–1.0            |  93 |           90.6% |       83.9% |
| separate-work     | clef             | 0.0–0.2            |   0 |             n/a |         n/a |
| separate-work     | clef             | 0.2–0.4            |   0 |             n/a |         n/a |
| separate-work     | clef             | 0.4–0.6            |   0 |             n/a |         n/a |
| separate-work     | clef             | 0.6–0.8            |   0 |             n/a |         n/a |
| separate-work     | clef             | 0.8–1.0            |   0 |             n/a |         n/a |
| separate-work     | clef-flash       | 0.0–0.2            |   0 |             n/a |         n/a |
| separate-work     | clef-flash       | 0.2–0.4            |   0 |             n/a |         n/a |
| separate-work     | clef-flash       | 0.4–0.6            |   0 |             n/a |         n/a |
| separate-work     | clef-flash       | 0.6–0.8            |   0 |             n/a |         n/a |
| separate-work     | clef-flash       | 0.8–1.0            |   0 |             n/a |         n/a |
| separate-work     | jev              | 0.0–0.2            |   0 |             n/a |         n/a |
| separate-work     | jev              | 0.2–0.4            |   5 |           35.6% |        0.0% |
| separate-work     | jev              | 0.4–0.6            |  18 |           56.2% |       44.4% |
| separate-work     | jev              | 0.6–0.8            |  36 |           71.7% |       75.0% |
| separate-work     | jev              | 0.8–1.0            |  61 |           91.1% |      100.0% |
| separate-work     | openai-decisions | 0.0–0.2            |   0 |             n/a |         n/a |
| separate-work     | openai-decisions | 0.2–0.4            |   0 |             n/a |         n/a |
| separate-work     | openai-decisions | 0.4–0.6            |   0 |             n/a |         n/a |
| separate-work     | openai-decisions | 0.6–0.8            |   0 |             n/a |         n/a |
| separate-work     | openai-decisions | 0.8–1.0            |   0 |             n/a |         n/a |

Calibration uses the probability of the chosen answer against correctness. Rules have deterministic 0/1 outputs; these are policy scores, not learned confidence. Positive classes are candidate inclusion, any durable brief type, highlight, and an organization action (suggest/reuse). Each threshold maximizes positive precision subject to >=70% recall; ties favor recall, then the higher threshold. Thresholds were fit on this same development set and require independent owner-label validation before automatic behavior.

| Task              | Arm              | Repetition 1 | Repetition 2 | Repetition 3 |
| ----------------- | ---------------- | -----------: | -----------: | -----------: |
| context-relevance | rules            |        28/40 |        28/40 |        28/40 |
| context-relevance | critic           |        22/27 |        22/27 |        22/27 |
| context-relevance | cheap-llm        |        30/40 |        29/40 |        30/40 |
| context-relevance | clef             |          0/0 |          0/0 |          0/0 |
| context-relevance | clef-flash       |          0/0 |          0/0 |          0/0 |
| context-relevance | jev              |        24/40 |        24/40 |        24/40 |
| context-relevance | openai-decisions |          0/0 |          0/0 |          0/0 |
| brief-update      | rules            |        40/40 |        40/40 |        40/40 |
| brief-update      | critic           |        24/24 |        24/24 |        24/24 |
| brief-update      | cheap-llm        |        40/40 |        40/40 |        40/40 |
| brief-update      | clef             |          0/0 |          0/0 |          0/0 |
| brief-update      | clef-flash       |          0/0 |          0/0 |          0/0 |
| brief-update      | jev              |        35/40 |        36/40 |        35/40 |
| brief-update      | openai-decisions |          0/0 |          0/0 |          0/0 |
| attention-triage  | rules            |        37/40 |        37/40 |        37/40 |
| attention-triage  | critic           |        25/25 |        25/25 |        25/25 |
| attention-triage  | cheap-llm        |        35/40 |        36/40 |        35/40 |
| attention-triage  | clef             |          0/0 |          0/0 |          0/0 |
| attention-triage  | clef-flash       |          0/0 |          0/0 |          0/0 |
| attention-triage  | jev              |        33/40 |        33/40 |        33/40 |
| attention-triage  | openai-decisions |          0/0 |          0/0 |          0/0 |
| separate-work     | rules            |        36/40 |        36/40 |        36/40 |
| separate-work     | critic           |        18/18 |        18/18 |        18/18 |
| separate-work     | cheap-llm        |        31/40 |        30/40 |        30/40 |
| separate-work     | clef             |          0/0 |          0/0 |          0/0 |
| separate-work     | clef-flash       |          0/0 |          0/0 |          0/0 |
| separate-work     | jev              |        32/40 |        32/40 |        32/40 |
| separate-work     | openai-decisions |          0/0 |          0/0 |          0/0 |

Total upstream attempts: 482; charged input: 430718; charged completion: 77058; charged USD: $0.396180.

The immutable manifest, dry-run receipt, append-only attempts/results, exact credential-free payloads and raw provider responses remain under .local/bench/decisions/. The committed fixtures and harness reproduce the rules and scoring without credentials. The synthetic cases reuse several semantic patterns across domains; 120 repetition rows do not constitute 120 independent examples. This is offline development evidence, not deployed acceptance.

| Arm              | Upstream attempts | HTTP errors | Timeouts | Reservation breaches | Charged USD |
| ---------------- | ----------------: | ----------: | -------: | -------------------: | ----------: |
| rules            |                 0 |           0 |        0 |                    0 |   $0.000000 |
| critic           |                 0 |           0 |        0 |                    0 |   $0.000000 |
| cheap-llm        |               240 |           0 |        0 |                    0 |   $0.386331 |
| clef             |                 0 |           0 |        0 |                    0 |   $0.000000 |
| clef-flash       |                 0 |           0 |        0 |                    0 |   $0.000000 |
| jev              |               241 |           0 |        0 |                    1 |   $0.009369 |
| openai-decisions |                 1 |           1 |        0 |                    0 |   $0.000480 |

The quality table counts affected cases; this table counts upstream requests. Campaign totals include superseded diagnostic attempts. Charged USD uses the declared budget rates and is not a CLIProxy invoice. No credentials are included in artifacts.

## Recommendation

| Task                    | Preferred arm |              Action threshold | Precision / recall on these fixtures | Reason                                                                                                                         |
| ----------------------- | ------------- | ----------------------------: | -----------------------------------: | ------------------------------------------------------------------------------------------------------------------------------ |
| Context relevance       | Jev           |            P(include) >= 0.69 |                         100% / 76.2% | Best measured precision at the required recall; $0.003340 for three repetitions, p95 408 ms.                                   |
| Brief-update candidates | rules         |      durable policy score = 1 |                          100% / 100% | 120/120 exact cases, including duplicate/conflict questions, with zero model cost.                                             |
| Attention triage        | rules         |    highlight policy score = 1 |                         100% / 87.5% | Best full four-level accuracy, 111/120; no unnecessary highlights and one distinct missed-highlight case repeated three times. |
| Separate work           | rules         | organization policy score = 1 |                         100% / 87.5% | Best exact-choice accuracy, 108/120; zero unnecessary suggestions.                                                             |

These are development recommendations, not validated production defaults. In context selection, explicit owner
references remain mandatory and disabled/archived/superseded candidates remain excluded unless explicitly referenced.
Apply the threshold to each candidate's inclusion probability, then derive `none-relevant` from the final included
set. Jev's raw argmax case accuracy is only 60%; thresholding changes the binary inclusion policy and does not prove
that every candidate in a whole request will be correct. The deterministic relevance arm cannot meet 70% recall
without the degenerate threshold 0, which would include every candidate at only 16.3% precision; do not use it.
Cheap chat at 0.95 gives 84.1% precision / 82.1% recall and has a 6175 ms p95, so it is a weaker inclusion candidate.

If highlight recall is valued above full-level accuracy, Jev at P(highlight) >= 0.97 and cheap chat at 0.80 both
reach 100% precision / 100% recall on this set. Jev's raw argmax produces 12 unnecessary highlight rows, all removed
by the fitted cutoff. Keep deterministic runtime questions, approvals and failures outside this classifier. For
organization, Jev's combined P(suggest-or-reuse) threshold near 0.80 reaches 100% binary precision / recall, but its
exact organization choice is correct only 80% of the time; an action cutoff does not validate the proposed destination.

Rules, cheap chat and Jev scored 423/480 (88.1%), 406/480 (84.6%) and 373/480 (77.7%) exact case rows respectively.
Cheap chat matched rules on brief updates but was worse on attention and organization. Context inclusion is the one
positive-class decision where Jev's fitted probability cutoff makes a useful precision/recall tradeoff.

## Does critic beat model-first?

This run cannot establish a Clef critic advantage: the scoped Workers AI token was absent at every poll. No Clef,
Clef-flash or Clef critic inference occurred. Critic resolved 282/480 rows by rules and left 198 skipped; its 267/282
conditional accuracy and subset thresholds must not be compared with complete model-first arms. Coverage by task
was 81/120 relevance, 72/120 brief, 75/120 attention and 54/120 organization. The five distinct relevance mistakes
inside the supposedly decisive rules subset also show that rules-first routing can lock in wrong negatives.
The robo-harness 11/11 result is prior art, not evidence that this Goblin critic wins.

Clef/Clef-flash thresholds remain unmeasured. The conductor independently confirmed HTTP 403 with the original
Cloudflare token; this lane used only the prescribed scoped-token variable and skipped it when absent. OpenAI
Decisions was attempted through CLIProxy once and returned HTTP 404; the remaining 478 planned cases were skipped.
No alternative credential was sought.

## Execution and spend

The first unused plans were dry runs only. Live v2 completed all three cheap-chat repetitions (240 requests, 480
cases), then stopped on its first Jev response because the provider reports completion tokens for its wire encoding
(224 tokens) while the original typed envelope reserved zero. That response and the terminal breach receipt were
preserved. The corrected v3 manifest reserved 1024 completion tokens for every provider and selected unfinished arms
only, retaining all v2 spend. It completed 240 Jev requests / 480 cases across three repetitions and the one Decisions
route probe. The combined report keeps v2's complete rules/chat rows and v3's typed-arm outcomes, without duplicates.
Prompts, questions, fixture hash and model definitions were identical; both implementation hashes are listed above.

Across both live trials: 482 upstream requests, 430718 accounted input tokens, 77058 completion tokens, zero timeouts,
zero invalid-answer rows, one known diagnostic reservation breach and one HTTP 404. Jev's published-rate spend,
including the diagnostic response, was **$0.009369444**. CLIProxy's actual invoice rate was unavailable: chat was
budgeted conservatively at **$0.386331**, and the rejected Decisions request retains a **$0.000480** input reservation.
The complete append-only ledger therefore charges **$0.396180444**, below the $3 declared budget. This is accounted
spend at the manifest rates; the report does not claim a verified CLIProxy invoice total. Raw payloads, replies,
reservations and both immutable manifests remain in `.local/bench/decisions/` with private permissions.

The initial complete `heavy bun run check` passed with zero lint/Effect/Knip findings, 21 focused regressions now cover
the corrected harness, and the final complete gate is recorded in the lane receipt. All gates are local evidence;
no code was pushed, merged or deployed. Recreate the measured tables with:

```sh
bun run bench:decisions report --run decisions-20261008-v3 --include decisions-20261008-v2
```

This command regenerates metric tables; the recommendation and execution review above are the committed analysis.
Use new independent, less templated owner-reviewed cases before adopting these fitted thresholds.
