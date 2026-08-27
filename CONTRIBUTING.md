# Contributing to modelglass-router-examples

Thanks for your interest in contributing. Unlike the main Modelglass registry
(proprietary, all rights reserved), **this repo is MIT-licensed and genuinely
meant to be cloned, read, and adapted** — that's the whole point of it. See
[`LICENSE`](./LICENSE).

## What this repo is (and isn't)

Each top-level directory is a small, self-contained worked example of
building on the live [Modelglass](https://modelglass.com.au) pricing and
capability feed — read [`README.md`](./README.md) for the full list. These
are code examples meant to be read and adapted, not hosted demos or a
library you install — there's nothing published to npm, and `package.json`
is marked `private`.

## How to contribute

**Bug reports and fixes** — if an example is broken, out of date against the
live feed's current shape, or has a genuine bug, open an issue or a PR.
Include the exact command you ran and what happened.

**New examples** — before starting a new example, open an issue describing
what it would demonstrate. Not every idea fits: existing examples
deliberately don't do model selection/routing logic (that's the caller's
concern) or make actual generation/compositing calls (see the README's
"What's not here" section) — a new example should hold to the same
discipline, not reintroduce either.

**Docs fixes** — typos, unclear setup steps, broken links — small PRs
welcome, no need to open an issue first.

### Before opening a PR

```bash
npm install
npx tsc --noEmit   # typecheck every example
npm test           # run every example's test suite (node:test)
```

Both run in CI (`.github/workflows/validate.yml`) on every PR — a PR that
fails either won't be merged.

### PR checklist

- [ ] `npx tsc --noEmit` and `npm test` both pass locally
- [ ] If you added or changed an example, its own `README.md` documents the
      new/changed behavior
- [ ] No secrets, API keys, or `.env` files committed — every example reads
      credentials from environment variables, never hardcodes them

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md) — please
read it before participating in issues, PRs, or discussions.

## Security issues

Found a security vulnerability rather than a bug? Don't open a public issue
— see [`SECURITY.md`](./SECURITY.md) instead.

## Questions

Open an issue, or email **scott@modelglass.com.au**.
