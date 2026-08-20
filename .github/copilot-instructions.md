# Copilot instructions — Zaplie

Guidance for GitHub Copilot when reviewing pull requests in this repository.
Architecture, build commands and conventions live in [AGENTS.md](../AGENTS.md);
this file covers what to check in review.

**Real money moves through this system.** Zaps are Bitcoin sats paid over
Lightning via LNbits. Treat LNbits keys and Entra (AAD) secrets as production
credentials at all times, and treat payment-path bugs as high severity.

## Pull request hygiene

Check these on every pull request and raise any that fail:

1. **Base branch is `main`.** A PR targeting another feature or fix branch
   (a stacked PR) is the single most common problem here. If the base is not
   `main`, say so and ask why. Stacking is acceptable only when the PR genuinely
   depends on unmerged work *and* the description states that dependency — if
   the base branch never lands, the change silently never ships.
2. **A linked issue.** The description should reference the issue it closes
   (`Fixes #123`). Flag its absence.
3. **Screenshots or video for UI changes.** Any change to `tabs/` components,
   adaptive cards or styling needs visual evidence in the PR. Flag its absence
   rather than approving and asking later.
4. **Documentation updated in the same PR.** If the change alters architecture,
   deployment, configuration or testing behaviour, the relevant AsciiDoc under
   `docs/` must change with it — not in a later sweep. Docs going stale because
   the update was deferred is a recurring problem. Be specific about which file
   looks out of date.

Also flag: unresolved merge conflicts, and a diff far larger than the stated
purpose (a "verify X" PR carrying hundreds of unrelated CSS lines needs an
explanation).

## Dependency and Dependabot pull requests

- **Never suggest pushing a commit to a Dependabot branch.** Dependabot
  force-pushes on rebase, so any fix made there is lost. Required fixes land on
  `main` (or a dedicated PR); the bump then rebases on top.
- **Distinguish a version bump from a breaking migration in disguise.** If the
  new major removes or replaces an API the repo uses, it is a migration needing
  its own tracked work — recommend closing the PR and adding a Dependabot
  `ignore` rule so it is not regenerated.
- **Type packages track the runtime, they do not lead it.** `@types/node` should
  match the deployed Node version, not jump ahead of it.
- **Keep the bump narrowly scoped.** Pre-existing problems in the same file
  belong in a separate maintenance PR.

## Do not treat green CI as proof

CI does not build every subproject equally. Before relying on a green check,
confirm CI actually exercises the code that changed — a change that stops a
component booting can still show all-green if no job builds it. When you find
that gap, flag it as a separate issue worth raising rather than staying silent.

## Verify before asserting

- **Check the repo's real baseline before flagging a version concern.** This
  repo runs **Node 24** (`engines.node` in the root `package.json`, `node-version:
  24.x` in CI). Claims that a dependency needs a newer Node than the repo has
  are almost always based on a stale assumption — check first.
- Prefer a claim you can point to evidence for. Say plainly when something is a
  possibility rather than a confirmed defect.
- **Mark severity explicitly.** Separate "this is fatal, do not merge" from
  "this is a cleanup worth doing later". Both are useful; conflating them is not.

## Security

- **Fail closed.** Auth and config that cannot be resolved must return an error,
  never fall back to a permissive default. A hardcoded fallback API key or shared
  secret is always a blocking finding.
- **No credentials in browser bundles.** Anything reaching `tabs/` at build time
  is public. Privileged LNbits operations belong behind the backend proxy.
- **`.env.*.example` files carry dev-only, public-safe placeholders**, and must
  never invite real values to be filled in.
- **Secret removal must sweep the whole tracked tree**, not just the files in the
  diff — including fixtures, Postman collections and commented-out blocks. A
  partial redaction is a real miss.
- Runtime output containing personal data (logs with user IPs) must be gitignored.
- Validate caller-supplied input on any API: reject unknown keys, non-integers,
  negatives and values beyond the configured cap.

## Zaplie domain rules

- Each user has an **Allowance** wallet (their budget to give away) and a
  **Private** wallet (what they receive). A zap invoices the receiver's Private
  wallet and pays from the sender's Allowance wallet.
- **The Private wallet is private.** Members may use it for their own payments.
  Do not surface its balance or rank users by what lands in it.
- **Leaderboards measure zaps sent OUT of Allowance wallets**, using the metadata
  attached to those payments — never receipts into Private wallets.
- Scheduled top-ups are the LNbits **allowance extension's** job. Prefer the
  extension and a proper lightning address per wallet over reimplementing that
  logic in the bot.
- Assume users may later direct zaps to an **external, self-custodial** wallet.
  Flag designs that hardcode the assumption that funds stay inside LNbits.

## Correctness and tests

- Tests must exercise real logic against a mocked network boundary. A suite that
  mocks the module under test proves nothing.
- Scope UI tests with test IDs rather than DOM order, and import shared constants
  from source instead of duplicating literals that can drift.
- Parse numbers strictly (explicit radix, integer and range checks) before acting.
- `await` async values before placing them in an object or response.
- Cleanup must be deterministic and bounded: await `close()`, use `try`/`finally`,
  and add a timeout backstop for anything that may never become ready.
- When matching responses on an async channel, match the specific subscription or
  request id — not just the message type.

## UI and design

- **No stock photography.** It gets removed every time.
- New UI should be checked against the Figma reference for layout, colour and
  hierarchy — functionally correct is not sufficient.
- Be precise about spacing, alignment, contrast and redundant controls; these
  are noticed and called out.
- Accessibility is part of review: decorative icons `aria-hidden`, accessible
  names matching the visible label, hover affordances also reachable by keyboard
  focus with a visible ring, `rel="noopener noreferrer"` on every
  `target="_blank"`, and respect for `prefers-reduced-motion`.
- Custom click handlers must still let Cmd/Ctrl/Shift and middle clicks open a
  new tab.

## Housekeeping

- Delete dead code and unused helpers rather than leaving a misleading no-op.
  Prefix a genuinely unused parameter with `_` and comment why.
- Fix comments that contradict the code; do not leave stale references to files
  or conventions that no longer exist.
- When a PR's scope is narrowed, record what was left behind as a tracked
  follow-up instead of dropping it silently.
- Ask about data provenance and the access-control model for new features: where
  is this stored, and who counts as an administrator?
