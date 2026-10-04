# Provenance

Vendored from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) at commit
`c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (2026-09-10, package `oxlint-plugin-anti-slop` 0.1.2), MIT
(`LICENSE`, Copyright (c) 2026 Dillon Mulroy). The upstream model is "copy `src/` into your repository"; there is no
npm release.

- Trimmed 2026-10-04 to the rules `oxlint.config.ts` enables and the shared helpers they import. Rule files are
  otherwise byte-identical to upstream; the two `index.ts` files list only the kept rules.
- Not copied: `scripts/`, `skills/`, `package.json`, the lockfile and the tests.
- Upstream builds against `@oxlint/plugins` 1.78.0; here it runs on the repository's pin (see `tools/package.json`).
- Ignored by oxlint, oxfmt, knip and jscpd and excluded from `tools/tsconfig.json`: it is upstream code.

Update: review the upstream diff at a specific commit, copy the kept rules again and refresh the hashes below.

## SHA-256 of the copied files

```
4b7916dcc0510a2adfd5d4f5210e1520e2b2df1a70e1d0aeebdea1457a7910a8  ./effect/index.ts
41434abb14bdb73760a2dfa4121b9e037f3ca741b0530c4f04d36f3a9e1041fd  ./effect/rules/no-manual-effect-error-tag.ts
f1e7c36b878f872b3cd4482e751bede505aafc21dabf93353a16e1c305bdb0bb  ./effect/rules/no-manual-tag-comparison.ts
91e65bc7ebba81eda53c049fb3a07e03982a20476546cb9b4f3cbe2e66297d1c  ./effect/shared/tagged-values.ts
edcecc8515a5eca3b1d657fe058e6c0cda05baab94f1aed1ea370a62fe0d9b91  ./index.ts
10ed33bf340d6d63dc0633dfc917a346b369b6aa41fe20734aefc6a3fb75ba17  ./LICENSE
72f8e981520f94adac0ffbdab8f8e84e5f2a4595f14e4a6471be917a85a20a15  ./rules/no-chained-type-assertions.ts
e29ba7d9ba4a5aed971002840bf434beef93393f60a589e55b72c203dde4c8db  ./rules/no-module-mocking.ts
f7920a332106252d6a24cdc917a2c1a433eb438792996ccceb5a25cd6e591dbb  ./rules/no-reflect-apply.ts
95c5aa0f8e23b10d9345b1776082e08704ec6590298176a8ede8dfdb6e7cb56f  ./rules/no-reflect-get.ts
63f2c07cc42b8ad60a7e868efbd7b29e462b9ba960fbd07bbc8f590ef9e3f879  ./rules/no-widen-then-assert.ts
c8ed9f50f1c6e3592b77165dd8847d187ee9b0ef955d50f8099498d3139aa27c  ./rules/require-safety-comment-for-type-assertion.ts
d1b7bd13ca714bf20bec15e835ed0526316b7274e06bd9a582cf623c09ac1d40  ./shared/reflect-method.ts
e38d41eeada854dbd02285e84e065d10e69460695e06e53fbe8662c963ae7eb4  ./shared/scope.ts
```
