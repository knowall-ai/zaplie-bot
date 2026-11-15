# AGENTS.md

Guidance for AI coding agents (and new developers) working in this repository.

## What This Project Is

Zaplie (formerly Zapp.ie) is a Microsoft Teams application that enables Bitcoin
micro-transactions ("Zaps" of Sats) for team recognition and rewards, backed by
an [LNbits](https://lnbits.com/) Lightning wallet instance. It has three
deployable components in one repository:

| Component | Location | Stack |
|-----------|----------|-------|
| Teams bot | repo root (`src/`) | Node.js, TypeScript, Bot Framework (`botbuilder`), restify |
| Web app (Teams tabs) | `tabs/` | React 18, Create React App, MSAL, Fluent UI, plus a small Express backend (`tabs/backend/server.js`) |
| Azure Functions | `functions/` | Azure Functions v3 model, TypeScript |

## Architecture in Brief

- **Bot** (`src/index.ts`): restify server on port 3978, `POST /api/messages`
  handled by `CloudAdapter`. `src/teamsBot.ts` extends `TeamsActivityHandler`
  and routes text commands via the `SSOCommandMap` registry
  (`src/commands/SSOCommandMap.ts`). Commands: `send zap`, `show my balance`,
  `show leaderboard`; a `send zap` card pays at most `ZAP_MAX_RECIPIENTS`
  people (default three, Teams' 15-second turn limit). (`withdraw my zaps`
  exists as a stub in `src/commands/withdrawFundsCommand.ts` but is not
  registered or listed in the manifests until withdrawals work — issue #293.) Adaptive card submits arrive
  with `activity.value.action === 'submitZaps'`.
- **Assistant instructions** (`src/services/foundryAgentService.ts`): the
  Foundry agent's instructions are `FIXED_GUARDRAILS` (tool honesty, withdrawals
  not being available yet, untrusted tool output, no performance inference from
  calendar data) plus the admin-authored persona from `GET /api/bot-persona`,
  fenced in a delimited block that only licenses tone and followed by a restated
  precedence rule, so a forged fence cannot remove the rails. `ensureAgent`
  memoizes the upsert on a SHA-256 of the composed instructions, and
  `src/services/fetchBotPersona.ts` caches the persona for 60s, so an admin's
  save reaches the assistant within a minute with no redeploy. That module
  re-validates the fetched text against the same rules as
  `tabs/backend/botPersona.js` (2000 code points, no control characters, no
  U+2028/U+2029 line separators, no forged `--- BEGIN/END PERSONA ---` line) —
  two copies because the packages are separate, kept identical on purpose. The
  fetch fails open to the built-in persona — a portal outage never fails a turn.
- **Middleware** (`src/services/fetchUserMiddleware.ts`): every turn that has
  a sender (the synthetic event of a proactive send has none) resolves the
  Teams member and calls `UserService.ensureUserSetup()`, which adds them to
  Zaplie's people directory through the portal
  (`src/services/peopleDirectory.ts` → `/api/directory/internal/people/ensure`).
  Their **Allowance** wallet (spending budget) is owned by the `zaplie.service`
  LNbits account; their **Private** wallet (received Zaps) is their own, and
  Zaplie knows only where they receive (a Lightning address or an invoice
  key).
- **Copy and languages** (`src/i18n/`): every user-facing bot string is a key
  in `src/i18n/index.ts` with `en` and `es` dictionaries; replies follow the
  Teams client language (`activity.locale`, English fallback). Add new copy
  there, never as a literal in a handler, and throw `UserFacingError(key,
  params)` so the catch can render it in the user's language. Pass the raw
  `activity.locale` to `t` (not the collapsed `Locale`): number parameters
  are formatted for the client's region with `formatNumber`, so never call
  `toLocaleString()` yourself. Command words, wallet names, display names and
  the reward label are not translated. The assistant gets a reply-language
  hint on every turn's input, Spanish or English, never in the agent
  instructions (they are cached by hash); the English one cancels an earlier
  Spanish one, because Foundry replays a conversation's items. The recipient notification stays English: there is no recipient
  activity to read a language from.
- **Recipient notifications** (`src/services/recipientNotifier.ts`): after the
  ledger records a zap as paid and the sender's receipt is updated, the bot
  opens the recipient's personal chat on demand (`createConversationAsync`,
  by AAD object id) and sends a one-line notice. Best effort by contract: it
  returns an outcome and never throws into the payment path. Not awaited by
  the sender's turn (Teams' 15-second response limit); tracked on the bot
  instance so tests can settle it (`settleBackgroundWork`).
- **Wallets (least privilege, `docs/LNBITS_MIGRATION.adoc`)**: Zaplie never
  logs in to the wallet backend (LNbits) and never calls its admin API; tests
  in both packages fail if a source file does. It spends only over Nostr
  Wallet Connect: each person's Allowance wallet and the Treasury is an NWC
  connection with a budget (`tabs/backend/nwcWallet.js`), encrypted in
  `people.json` / `ZAPLIE_TREASURY_NWC`. The Fund keeps its admin key for the
  LNbits allowance extension only. The portal backend owns the people
  directory (`peopleStore.js`, `walletDirectory.js`, `directoryRoutes.js`),
  Zaplie's own zap records (`zapRecordStore.js`, which the feed and
  leaderboards read, since NWC carries no LNbits `extra`), the wallet gateway
  (`walletGateway.js`, `/api/wallet`) and onboarding (`walletProvisioner.js`
  + `lnbitsProvisioner.js`: a short-lived LNbits token pasted for one admin
  request, never stored). The bot holds no wallet credential at all:
  `src/services/peopleDirectory.ts` asks the portal to pay zaps and rewards.
  **Payment policy:** an Allowance wallet pays only another directory member,
  resolved server-side from their Entra id to their registered Lightning
  address; never a client-supplied invoice or address, never the sender.
  `functions/services/lnbitsService.ts` is legacy (#438).
- **Tabs app**: routes `/feed`, `/users`, `/rewards`, `/wallet`, `/settings`
  (MSAL-guarded via `RequireAuth`, which also adds the signed-in person to
  the directory through `POST /api/wallet/users/me` on first use outside
  Teams; the Wallet page registers where they receive, and Settings lets a
  Zaplie.Admin link Allowance wallets), plus `/login`, `/auth-start`, `/auth-end`. A
  second build of the same source serves `https://getzapl.ie/portal/`
  (`PUBLIC_URL=/portal`).
  `tabs/backend/server.js` is a tiny Express API that persists the renamable
  reward label ("Sats", validated by `tabs/backend/rewardName.js`) to
  `tabs/backend/data.json` and serves the production build.
- **Functions** (`getUsers`, `showUsers`, `sendZap`): anonymous HTTP triggers
  that take LNbits credentials per-request (Basic auth + `siteURL`/`adminkey`
  query params) — used for automation/Copilot scenarios.

Full details: `docs/SOLUTION_DESIGN.adoc`. Requirements catalogue:
`docs/requirements.yaml`.

## Build, Run, Test

Use **npm** (not pnpm/yarn). Node 24 is the supported runtime (declared in
`package.json` `engines`; CI builds on Node 24).

### Bot (repo root)

```bash
npm install
npm run dev      # hot reload via nodemon + ts-node (inspector on 9239)
npm run build    # tsc --build  → lib/
npm start        # node ./lib/src/index.js
npm test         # jest with ts-jest; collects coverage and enforces the floors
npm run coverage:ratchet   # coverage must not drop below .coverage-baseline.json
```

### Web app (`tabs/`)

```bash
cd tabs
npm install
npm start        # concurrently: Express backend (port 5000) + CRA dev server (port 3000)
npm run client   # CRA dev server only
npm run server   # Express backend only
npm run build    # production build → tabs/build/
npm test         # react-scripts test (watch mode; use CI=true npm test -- --watchAll=false for one-shot)
npm run test:backend   # node:test suite for the Express backend (runs in CI)
```

### Azure Functions (`functions/`)

```bash
cd functions
npm install
npm run build    # tsc → ../dist
npm start        # func start (requires Azure Functions Core Tools)
```

### Teams app (Teams Toolkit / TeamsFx CLI)

```bash
teamsapp provision --env local   # or --env dev
teamsapp deploy --env local
teamsapp preview --env local
```

Local bot testing needs a dev tunnel:
`devtunnel host -p 3978 --protocol http --allow-anonymous`, then set
`BOT_DOMAIN`/`BOT_ENDPOINT` in `env/.env.local`.

## Linting and Formatting

There is no ESLint/Prettier configuration wired up at present (the tabs app
inherits CRA's built-in `react-app` ESLint preset during `npm start`/`build`).
Match the existing style:

- 2-space indentation, single quotes, trailing commas
- Components: PascalCase (`WalletInfoCard`), functions/variables: camelCase,
  constants: UPPER_SNAKE_CASE
- `.tsx` for React components, `.ts` elsewhere
- Prefer simple, concise solutions; avoid `any`; keep components functional
  (hooks, no class components)

## Environment Configuration

Never commit secrets. Key variables (see `docs/DEPLOYMENT.adoc` for the full
table):

- **Bot**: `BOT_ID`, `BOT_PASSWORD`, `BOT_DOMAIN`, `AAD_APP_CLIENT_ID`,
  `AAD_APP_TENANT_ID`, `TAB_BACKEND_TOKEN` + `WEBSITE_API_URL` (the people
  directory, which also pays). No wallet setting at all: the portal backend
  holds `ZAPLIE_TREASURY_NWC`, `ALLOWANCE_FUND_ADMINKEY`, `ZAPLIE_STORE_KEY`
  and `LNBITS_URL`,
  `LEADERBOARD_WINDOW_DAYS` (1 to 365; also the assistant's default window),
  `LEADERBOARD_TOP_N` (1 to 100; values outside either range fail closed),
  `ZAP_MAX_RECIPIENTS` (1 or more, default 3; a malformed value stops the
  bot at startup),
  plus
  `APPLICATIONINSIGHTS_CONNECTION_STRING` and `AGENT_ID` for the Agents Portal
  telemetry (`src/services/pulse.ts`; titles and subjects are fixed strings,
  never names or zap messages)
- **Tabs**: `REACT_APP_LNBITS_NODE_URL`, `REACT_APP_AAD_CLIENT_ID`,
  `REACT_APP_TENANT_ID`, and related `REACT_APP_LNBITS_*` keys
  (`tabs/.env.development`). For the browser portal on getzapl.ie the build
  also takes `PUBLIC_URL=/portal` and `REACT_APP_API_BASE_URL` (see
  `tabs/src/services/appLocation.ts` and `docs/DEPLOYMENT.adoc`)
- Environments live in `env/` (`.env.local`, `.env.dev`); `dotenv-flow` loads
  them. `scripts/writeEnv.js` and `build.js` generate derived files
  (`.localConfigs`, `appPackage/manifest.json` — both gitignored).

## Known Gotchas (do not "fix" silently — raise or ticket them)

- `src/setupProxy.js` references `NBITS_NODE_URL` (missing `L`) — likely dead
  code.
- The reward-name API has two halves with different access: `GET
  /api/reward-name` is open (the portal reads the label before sign-in) and
  `POST /api/reward-name` needs a verified MSAL ID token with the
  `Zaplie.Admin` role; neither takes the shared `TAB_BACKEND_TOKEN`. The name
  is validated by `tabs/backend/rewardName.js` (1 to 32 code points, one line,
  no control characters or U+2028/U+2029) on the write, which also refuses
  any body key besides `newRewardName`, and the read serves
  `sats` instead of any stored value that breaks those rules.
  `tabs/src/apiService.tsx` (`updateRewardName`, `MAX_REWARD_NAME_LENGTH`)
  keeps a copy of the rules so Settings can explain a refusal before sending;
  two copies because the packages are separate, kept identical on purpose.
  The bot does not read this API: its label comes from `LNBITS_POINTS_LABEL`.
- Bot conversation state uses `MemoryStorage`: it is lost on restart and not
  multi-instance safe.
- The zap-card ledger (`src/services/zapLedger.ts`) and the automation reward
  ledger (`src/services/rewardLedger.ts`) are JSON files under
  `ZAPLIE_DATA_DIR` that share the lock and atomic-write code in
  `src/services/ledgerFile.ts`. A record left `processing`, `unknown` or
  `uncertain` blocks that payment until an operator reconciles it with LNbits
  (`docs/DEPLOYMENT.adoc`); never clear one just to let a retry through.
  At startup only, each ledger removes its own `.lock` once it is older than
  `ZAPLIE_LEDGER_STALE_LOCK_MS` (default 30 s, `0` off) and never touches a
  record; at runtime a held lock is never evicted.
  `POST /api/v1/rewards` (`src/rewardsRoute.ts`) requires an
  `Idempotency-Key` header and replays the first result for a repeat.
- GitHub calls `POST /api/v1/github/webhook` (`src/githubWebhookRoute.ts`)
  directly, verified with `X-Hub-Signature-256` under `GITHUB_WEBHOOK_SECRET`
  and mounted before `express.json()` because the signature covers the raw
  body. Both routes run `processReward` (`src/services/processReward.ts`):
  parse, reserve the key, repo allowlist, recipient, amount, budget, pay,
  settle. The amount comes only from the portal's settings
  (`GET /api/reward-policy`: saved amounts, level bonuses by PR label,
  per-person bases); an unset amount or budget is a 503, never a default.
  The period budget is enforced by `src/services/rewardBudget.ts`
  (`bot-reward-budget.json`). The Logic App template under `docs/automation/`
  is legacy.
- The GitHub Actions workflows (`.github/workflows/`) build only `tabs/` and
  deploy to the `zappie-dev` App Service (slot per PR / `testing`); the bot is
  deployed via `teamsapp deploy`, not CI.
- People are Zaplie's, not LNbits': `people.json` under `ZAPLIE_DATA_DIR`
  on the portal backend. Losing it (or `ZAPLIE_STORE_KEY`) loses the
  Allowance NWC connections, not the sats: the wallets still exist under
  `zaplie.service` and can be re-linked from Settings. Back it up with the
  rest of the data directory.

## Documentation

- Technical docs are AsciiDoc under `docs/` (`SOLUTION_DESIGN.adoc`,
  `TESTING.adoc`, `DEPLOYMENT.adoc`, …). Compile the branded PDF with
  `bash docs/generate-docs.sh` (requires `asciidoctor-pdf`); the PDF itself is
  gitignored.
- Update the relevant `.adoc` when you change architecture, deployment, or
  testing behaviour.
- Methodology/backlog structure follows
  [T-Minus-15](https://github.com/BenGWeeks/T-Minus-15).

## Security

Real money moves through this system. Treat LNbits keys and AAD secrets as
production credentials at all times. Never serialise a `Wallet` object into
LNbits payment `extra`, logs or Teams messages; project it with
`toPaymentExtraWallet` from `src/services/paymentExtra.ts`. Vulnerability
reports: see `SECURITY.md`.

Any id that reaches an LNbits URL (user, wallet, invoice) goes through
`encodeURIComponent`, and ids from a Teams card or other client input are
checked against the plain-id pattern first (`normalizeRecipientIds` in
`src/commands/zapRecipient.ts`, `USER_ID_PATTERN` in the portal gateway).
Those calls carry the portal's internal token or reach wallets, so a raw
`../` would let a client steer them to another endpoint.

User-typed amounts are parsed with `parseSatsAmount`
(`src/utils/satsAmount.ts`), never `Number()` or `parseInt` alone; env
ceilings with `positiveIntFromEnv` (including `ZAP_MAX_RECIPIENTS`).
