# Contributing

Thanks for considering a contribution. This project is small and the
contribution surface is deliberately narrow — most changes should fall
into one of: a new tool, a bug fix to an existing tool, a description
clarification, or a doc update.

## Before you open a PR

Run the same gates CI will run. They're fast (under a minute combined):

```sh
npm run typecheck      # tsc --noEmit
npm run lint           # Biome lint
npm run format:check   # Biome format check (run `npm run format` to fix)
npm test               # vitest (337 tests, all mocked, no token needed)
npm run build          # tsup — catches bundler-time regressions
```

`npm run check` runs Biome's combined lint+format check. `npm run format`
writes formatting fixes in-place.

CI (`.github/workflows/ci.yml`) runs all of the above plus
`npm audit --audit-level=high` on every PR.

## Coding style

There's no separate style guide — Biome enforces the rules
mechanically. The config (`biome.json`) is short and worth a skim.
What matters when reading existing code:

- **2-space indent, double quotes, trailing commas, semicolons,
  100-col lines.** Run `npm run format` and stop thinking about it.
- **`process.env["VAR"]` (bracket access), not `process.env.VAR`.**
  Sidesteps TS's index-signature complaints; `useLiteralKeys` is off
  in the lint config so both forms pass, but the codebase is uniformly
  bracket-access. Match that.
- **Comments explain *why*, not *what*.** Most files have a top-of-file
  comment block that names the file's role; per-section comments call
  out non-obvious decisions (Capsule quirks, security gates, refactor
  trade-offs). When something needed a long-form explanation it usually
  belongs in [NOTES-ON-CAPSULE-API.md](NOTES-ON-CAPSULE-API.md) or
  [DESIGN.md](DESIGN.md), not inline.
- **No emojis in source unless explicitly user-facing.**
- **No new top-level deps without a clear reason.** The dep tree is
  tiny on purpose (5 runtime deps); a new one needs a paragraph in the
  PR description.

## Where to look

- [HOWTO.md](HOWTO.md) — task-oriented procedures (run tests, add a
  tool, debug, cut a release).
- [DESIGN.md](DESIGN.md) — what's intentionally *not* implemented and
  why; read this before proposing a sweeping change.
- [NOTES-ON-CAPSULE-API.md](NOTES-ON-CAPSULE-API.md) — Capsule v2 API
  quirks catalogued from production verification. If your PR works
  around a Capsule behaviour, append a section here.
- [IDEAS.md](IDEAS.md) — features that might land later; pick from
  here if you're looking for something to do.

## PR description

Short is fine, but please cover:

- What changed and why
- What you tested (commands, scenarios)
- For new tools: an example call and the Capsule endpoint it hits
- For doc-only changes: nothing extra needed

The `🤖 Generated with Claude Code` trailer is welcome on PRs that
were drafted with an LLM — it's just a label, not a quality signal.

## License

By contributing you agree your contribution is licensed under the
[Apache License 2.0](LICENSE), same as the rest of the project.
