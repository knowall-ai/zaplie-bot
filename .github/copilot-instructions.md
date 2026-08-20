# Copilot instructions — Zaplie

Guidance for AI reviewers working in this repository.

Architecture, build commands and conventions are in [AGENTS.md](../AGENTS.md).
Organisation-wide review standards — base branch, documentation, screenshots,
linked issues, dependency-bot handling — live centrally in
[`knowall-ai/coderabbit`](https://github.com/knowall-ai/coderabbit) and are not
repeated here. **This file covers only what is specific to Zaplie.**

## Real money moves through this system

Zaps are Bitcoin sats paid over Lightning via LNbits. Treat LNbits keys and
Entra (AAD) secrets as production credentials at all times, and treat anything
on the payment path as high severity.

- **Fail closed.** Auth or config that cannot be resolved must return an error,
  never fall back to a permissive default. A hardcoded fallback API key or
  shared secret is always a blocking finding.
- **Nothing privileged in the browser bundle.** Anything reaching `tabs/` at
  build time is public. Privileged LNbits operations belong behind the backend
  proxy in `tabs/backend/`.
- **`.env.*.example` files** carry dev-only, public-safe placeholders, and must
  never invite real values to be filled in.
- **Secret removal must sweep the whole tracked tree** — including fixtures,
  Postman collections and commented-out blocks — not just the files in the diff.

## Wallet semantics

Each user has two LNbits wallets, and conflating them is the most common
domain error here:

- an **Allowance** wallet — their budget to give away, and
- a **Private** wallet — what they receive.

A zap creates an invoice on the receiver's Private wallet and pays it from the
sender's Allowance wallet.

- **The Private wallet is private.** Members may use it for their own payments.
  Do not surface its balance or rank users by what lands in it.
- **Leaderboards measure zaps sent OUT of Allowance wallets**, using the
  metadata attached to those payments — never receipts into Private wallets.
- **Scheduled top-ups belong to the LNbits allowance extension**, not the bot.
  Prefer the extension and a lightning address per wallet over reimplementing
  that logic here.
- Assume users may later direct zaps to an **external, self-custodial** wallet.
  Flag designs that hardcode the assumption that funds stay inside LNbits.

## Repository baseline

- **Node 24** is the supported runtime (`engines.node` in the root
  `package.json`; CI runs `node-version: 24.x`). Version concerns raised against
  Node 16/18/20 are stale — check the declared baseline before flagging one.
- Three deployable components share this repo: the bot (`src/`), the Teams tabs
  app (`tabs/`) and Azure Functions (`functions/`). CI does not build all of
  them equally, so a green run does not prove the component you changed still
  builds.
