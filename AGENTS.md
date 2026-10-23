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
  `show leaderboard`. (`withdraw my zaps` exists as a stub in
  `src/commands/withdrawFundsCommand.ts` but is not registered or listed in the
  manifests until withdrawals work — issue #293.) Adaptive card submits arrive
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
  Teams member and calls `UserService.ensureUserSetup()`, which creates the
  LNbits user (keyed by AAD object id) and ensures each user has an
  **Allowance** wallet (spending budget) and a **Private** wallet (received
  Zaps).
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
  returns an outcome and never throws into the payment path.
- **LNbits integration**: `src/services/lnbitsService.ts` (bot),
  `tabs/src/services/lnbits/` (browser: `auth`, `cache`, `users`, `wallets`,
  `payments`, `rewards`), and
  `functions/services/lnbitsService.ts` (request-scoped) are three parallel
  clients for the LNbits REST API (`/api/v1/*`, `/users/api/v1/*`).
  Auth is either `X-Api-Key` (admin/invoice key) or a Bearer token from
  `POST /api/v1/auth`. A Zap = `createInvoice` on the receiver's Private wallet
  then `payInvoice` from the sender's Allowance wallet. The payment `extra`
  carries `{ id, name, user, displayName }` per wallet, built by
  `src/services/paymentExtra.ts`, never a `Wallet` object (which holds keys);
  the automation reward's `from` is `{ displayName }` only, because the bot
  holds the treasury wallet's admin key, not its wallet object.
- **Tabs app**: routes `/feed`, `/users`, `/rewards`, `/wallet`, `/settings`
  (MSAL-guarded via `RequireAuth`, which also provisions the signed-in
  person's LNbits user and wallets through `POST /api/lnbits/users/me` on
  first use outside Teams), plus `/login`, `/auth-start`, `/auth-end`. A
  second build of the same source serves `https://getzapl.ie/portal/`
  (`PUBLIC_URL=/portal`).
  `tabs/backend/server.js` is a tiny Express API that persists the renamable
  reward label ("Sats") to `tabs/backend/data.json` and serves the production
  build.
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
  `AAD_APP_TENANT_ID`, `LNBITS_NODE_URL`, `LNBITS_USERNAME`,
  `LNBITS_PASSWORD`, `LNBITS_ADMINKEY`, `LNBITS_INITIAL_ALLOWANCE`,
  `LEADERBOARD_WINDOW_DAYS` (1 to 365; also the assistant's default window),
  `LEADERBOARD_TOP_N` (1 to 100; values outside either range fail closed),
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
- The reward-name API uses a placeholder shared secret (`your-secret-token`)
  across `tabs/src/apiService.tsx`, `tabs/backend/authMiddleware.js`, and
  `src/services/fetchRewardsName.ts`.
- Bot conversation state uses `MemoryStorage`: it is lost on restart and not
  multi-instance safe.
- The zap-card ledger (`src/services/zapLedger.ts`) and the automation reward
  ledger (`src/services/rewardLedger.ts`) are JSON files under
  `ZAPLIE_DATA_DIR` that share the lock and atomic-write code in
  `src/services/ledgerFile.ts`. A record left `processing`, `unknown` or
  `uncertain` blocks that payment until an operator reconciles it with LNbits
  (`docs/DEPLOYMENT.adoc`); never clear one just to let a retry through.
  `POST /api/v1/rewards` (`src/rewardsRoute.ts`) requires an
  `Idempotency-Key` header and replays the first result for a repeat.
- The GitHub Actions workflows (`.github/workflows/`) build only `tabs/` and
  deploy to the `zappie-dev` App Service (slot per PR / `testing`); the bot is
  deployed via `teamsapp deploy`, not CI.
- `getUsers` pages the LNbits Users API (`sortby=id`, 100 per request, until
  `total` is reached or a page comes back empty). LNbits 1.6 returns ten
  accounts per request by default, orders nothing unless `sortby` is set, and
  reports `total: 0` once `offset` is past the end, so do not assume the
  default response contains the complete list.

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
Those calls carry the LNbits admin token, so a raw `../` would let a client
steer them to any LNbits endpoint.
