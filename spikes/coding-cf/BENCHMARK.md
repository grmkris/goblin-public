# Coding runner benchmark — 2026-10-09

Fixture base: `322e22853e4c2b1350d9511e1f489b21b474277e`. Docker and Cloudflare used the same immutable manifest `sha256:2e0c01dfc2f826e38f84f129de7bcdd72f7f6c724b80899f0ec1080683c775a2`. Image size: 2,997,303,383 bytes. The frozen Hello World overlay was `56c63968be5635ac6c65602f65176b51933c1947027f8c9bf6c0d5171d358bc0`.

Each backend completed 20 cold and 20 warm verifies. Cold samples also completed 20 fixed executions and closes. Native verification used host compilers; its fixed execution used the same disposable Docker image. Warm checks reused one lease after an unmeasured warm-up. Compiler and dependency installation caches were prebuilt in the image/snapshot; no package install ran during verification.

| Backend    | Verify cold P50/P95 (ms) | Verify warm P50/P95 (ms) | Lease create P50/P95 (ms) | Fixed execute P50/P95 (ms) | Close P50/P95 (ms) |
| ---------- | -----------------------: | -----------------------: | ------------------------: | -------------------------: | -----------------: |
| native     |            6,035 / 8,312 |            2,971 / 3,231 |                     0 / 1 |              1,348 / 1,415 |             3 / 10 |
| docker     |          13,397 / 13,865 |           9,505 / 10,002 |                 626 / 721 |              1,312 / 1,453 |          261 / 329 |
| cloudflare |          11,682 / 12,269 |            5,134 / 5,453 |                     0 / 0 |              2,126 / 2,320 |          344 / 546 |

Lease create measures factory construction and, for Docker, container startup to socket health. Native compiler initialization and Cloudflare container startup occur inside the first verify; they are included in cold verify latency. Fixed execute is an end-to-end disposable execution call. Close measures the awaited cleanup request, not an independent provider inventory audit.

Docker limits: one CPU, 3 GiB RAM, 256 pids, no network, UID 1000, read-only root, dropped capabilities, no-new-privileges, private socket mount and bounded executable state/execution tmpfs. Cloudflare used standard-2 and `enableInternet=false`; native used the shared Netcup host. CPU allocations differ and other heavy jobs ran on the box. These numbers do not establish equal-capacity performance or provider cost.

Docker stats sampled 247 observations. Peaks: 106.87% CPU, 1,048,051,712 bytes memory, 64 pids. Sampled peaks are lower bounds, not kernel high-water marks. Native host and Cloudflare resource peaks were not measured.

Parity passed on the invalid edit, correction and two warm checks, with identical revisions and normalized diagnostics. The invalid edit had two diagnostics; every corrected check had zero. All three operator execution receipts returned `Hello, world!\n`, empty stderr and exit 0. An earlier parity attempt was rejected during a corrected check; a complete repeat passed.

Actual Docker isolation proved DNS and outbound TCP denial, UID 1000 and resource flags, no configured runner credential in the environment, and disposable execution cleanup. Cleanup also passed after malformed input, verify timeout and simulated host restart. Live sessions survived reconciliation; duplicate leases were refused; closing an obsolete lease preserved its replacement. No labelled comparison or isolation container remained afterwards.

Private mode-600 receipts: `.local/coding-cf-spike/{benchmark-three,comparison-three,isolation,image-receipt}.json`. They contain timings, identities and bounded results, not overlay source or credentials. Local Docker/native proof, actual Cloudflare provider proof and the isolated CF dev deployment are separate from CI, deployed Goblin chat acceptance, browser and production evidence.
