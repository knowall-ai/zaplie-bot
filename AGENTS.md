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
  `show leaderboard`, `withdraw my zaps` (stub). Adaptive card submits arrive
  with `activity.value.action === 'submitZaps'`.
- **Middleware** (`src/services/fetchUserMiddleware.ts`): every turn resolves
  the Teams member and calls `UserService.ensureUserSetup()`, which creates the
  LNbits user (keyed by AAD object id) and ensures each user has an
  **Allowance** wallet (spending budget) and a **Private** wallet (received
  Zaps).
- **LNbits integration**: `src/services/lnbitsService.ts` (bot),
  `tabs/src/services/lnbitsServiceLocal.ts` (browser), and
  `functions/services/lnbitsService.ts` (request-scoped) are three parallel
  clients for the LNbits REST API (`/api/v1/*`, `/usermanager/api/v1/*`).
  Auth is either `X-Api-Key` (admin/invoice key) or a Bearer token from
  `POST /api/v1/auth`. A Zap = `createInvoice` on the receiver's Private wallet
  then `payInvoice` from the sender's Allowance wallet.
- **Tabs app**: routes `/feed`, `/users`, `/rewards`, `/wallet`, `/settings`
  (MSAL-guarded via `RequireAuth`), plus `/login`, `/auth-start`, `/auth-end`.
  `tabs/backend/server.js` is a tiny Express API that persists the renamable
  reward label ("Sats") to `tabs/backend/data.json` and serves the production
  build.
- **Functions** (`getUsers`, `showUsers`, `sendZap`): anonymous HTTP triggers
  that take LNbits credentials per-request (Basic auth + `siteURL`/`adminkey`
  query params) — used for automation/Copilot scenarios.

Full details: `docs/SOLUTION_DESIGN.adoc`. Requirements catalogue:
`docs/requirements.yaml`.

## Build, Run, Test

Use **npm** (not pnpm/yarn). Node 18 is the supported runtime (CI builds on 20;
if you hit MSAL issues on Node 20 see the override note in README.md).

### Bot (repo root)

```bash
npm install
npm run dev      # hot reload via nodemon + ts-node (inspector on 9239)
npm run build    # tsc --build  → lib/
npm start        # node ./lib/src/index.js
```

There is no root-level `npm test` (the script exits with an error). The Jest
suite that exists is run directly:

```bash
npx jest src/services/lnbitsService.test.ts
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
  `LNBITS_PASSWORD`, `LNBITS_ADMINKEY`, `LNBITS_INITIAL_ALLOWANCE`
- **Tabs**: `REACT_APP_LNBITS_NODE_URL`, `REACT_APP_AAD_CLIENT_ID`,
  `REACT_APP_TENANT_ID`, and related `REACT_APP_LNBITS_*` keys
  (`tabs/.env.development`)
- Environments live in `env/` (`.env.local`, `.env.dev`); `dotenv-flow` loads
  them. `scripts/writeEnv.js` and `build.js` generate derived files
  (`.localConfigs`, `appPackage/manifest.json` — both gitignored).

## Known Gotchas (do not "fix" silently — raise or ticket them)

- Root `jest.config.ts` has no ts-jest transform configured; the root `test`
  script is intentionally unwired.
- `src/setupProxy.js` references `NBITS_NODE_URL` (missing `L`) — likely dead
  code.
- The reward-name API uses a placeholder shared secret (`your-secret-token`)
  across `tabs/src/apiService.tsx`, `tabs/backend/authMiddleware.js`, and
  `src/services/fetchRewardsName.ts`.
- Bot conversation state uses `MemoryStorage` — lost on restart, not
  multi-instance safe.
- The GitHub Actions workflows (`.github/workflows/`) build only `tabs/` and
  deploy to the `zappie-dev` App Service (slot per PR / `testing`); the bot is
  deployed via `teamsapp deploy`, not CI.

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
production credentials at all times. Vulnerability reports: see `SECURITY.md`.
