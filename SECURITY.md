# Security Policy

This repo is a set of local CLI code examples — there's no hosted service,
no server this repo runs, and no data store here to compromise. The main
attack surface is the code itself (dependency vulnerabilities, unsafe
handling of the API keys you provide) rather than a live deployment.

If you're looking for the security policy of the live Modelglass API, MCP
server, or site that these examples call into, that's a separate,
proprietary repo — email **scott@modelglass.com.au** for that too, the
process below covers both.

## Supported versions

| Version | Supported |
|---------|-----------|
| `main` (current) | ✅ |
| any tagged release | — none yet |

Only the `main` branch is supported. There are no tagged releases, so fixes
land on `main`.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Email **`scott@modelglass.com.au`** with:

- a description of the issue and its impact,
- steps to reproduce (or a proof of concept),
- the affected example/file.

We will **acknowledge your report within 48 hours** and aim to ship a fix for
**critical issues within 14 days**. We'll keep you updated on progress and
credit you on request once the fix is released.

## Scope

**In scope:**

- Unsafe handling of credentials — an example that logs, writes to disk, or
  transmits your `MODELGLASS_API_KEY` / `ANTHROPIC_API_KEY` anywhere other
  than the real Modelglass API or Anthropic API it's built against.
- A genuine, exploitable vulnerability in this repo's own code (not a
  dependency's, unless it's reachable through how this repo uses it).
- Anything that would let a malicious input (a prompt, a shot list, a model
  slug) cause unintended file writes, command execution, or network calls
  outside the example's documented behavior.

**Out of scope:**

- The live Modelglass API, MCP server, or site's own security — those are a
  separate, proprietary repo; report the same way (email above), we'll route
  it internally.
- Vulnerabilities in third-party dependencies with no realistic exploit path
  through how this repo actually calls them — a bare `npm audit` finding
  isn't automatically a report, though a genuinely reachable one is welcome.
- "This example could theoretically run up your API bill if misused" — every
  example is opt-in, run manually, and documents what it costs (or doesn't
  cost) in its own README; that's expected behavior, not a vulnerability.

## Known, intentional non-issues

- **API keys are read from environment variables, never hardcoded or
  committed.** Every example expects `MODELGLASS_API_KEY` (and
  `ANTHROPIC_API_KEY` where noted) as env vars — if you see one hardcoded
  anywhere, that actually is a bug, report it.
- **`package.json` is marked `private: true` deliberately** — nothing here
  is published to npm, so there's no package-registry supply-chain surface
  to worry about beyond this repo's own `dependencies`/`devDependencies`.
