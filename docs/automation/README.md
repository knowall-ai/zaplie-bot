# Automated rewards via Logic Apps

This draft ships a GitHub-specific rewards pilot: **pay a reward when a GitHub
pull request is merged**, delivered as an
Azure Logic App (Consumption) ARM template that each organisation deploys and
customises in the workflow designer (trigger conditions and non-payment steps).

> **Not production-ready:** the endpoint still needs durable idempotency,
> aggregate budget enforcement and reconciliation of unknown payment outcomes.
> The sample Request trigger also does not yet verify GitHub's webhook signature,
> so `source: "github"` is a payload claim rather than authenticated provenance.
> Keep the PR in draft and do not connect a funded treasury yet.

```
GitHub webhook ──► Logic App (Request trigger)
                     │ condition: action == 'closed' && pull_request.merged == true
                     ▼
                   HTTP POST ► Zaplie POST /api/v1/rewards  (X-Api-Key)
                                 │ validates key + payload
                                 │ checks repository against the connected allowlist
                                 │ resolves GitHub numeric id → verified identity → LNbits user
                                 │ records an unlinked recipient as pending (no auto-settlement yet)
                                 │ pays from the "Automation" treasury wallet
                                 ▼
                               sats land in the recipient's Private wallet
```

The Logic App uses the generic **Request trigger** instead of the native GitHub
connector on purpose: the connector's pull request trigger is in Preview, its
issue triggers only cover "assigned to me", and it does not support
organisation repositories. A plain webhook covers every GitHub event type.

## 1. Configure the Zaplie bot

Set these environment variables on the bot (alongside the existing LNbits ones):

| Variable | Purpose |
| --- | --- |
| `REWARDS_API_KEY` | Optional environment-managed key accepted in `X-Api-Key`. The endpoint returns 503 only when neither this key nor an active portal-managed key exists. |
| `REWARDS_TREASURY_ADMINKEY` | Admin key of the treasury wallet that pays rewards (see below). |
| `WEBSITE_API_URL` | Base URL of the portal backend API. The bot uses it for reward-rule configuration and verified identity resolution; for example `https://<portal-domain>/api`. |
| `TAB_BACKEND_TOKEN` | Separate shared secret the bot sends to the portal backend. The bot and portal backend must use the same non-placeholder value. |
| `REWARDS_MAX_AMOUNT_SATS` | Optional cap for configured reward rules. Defaults to 10000 (the same ceiling as the interactive zap card). Invalid configured amounts fail closed. |

Generate `REWARDS_API_KEY` and `TAB_BACKEND_TOKEN` independently with e.g.
`openssl rand -hex 32`.

### Treasury wallet

Rewards are paid from a dedicated treasury, never from a teammate's Allowance:

1. In LNbits, create a user named `Automation` with one wallet.
2. Fund that wallet (admin top-up).
3. Set `REWARDS_TREASURY_ADMINKEY` to that wallet's **Admin key**.

Payments carry the memo from the automation (e.g. `GitHub: PR #123 merged`)
and show in the recipient's wallet transaction log as sent by "Automation"
(the shared feed resolves senders from teammate wallets, so treasury payments
may display an unattributed sender there — known limitation).

The HTTP action in the template has its retry policy disabled on purpose:
the endpoint is not idempotent, and a retry after a timed-out-but-executed
payment could pay the same PR twice. This only reduces the duplicate-payment
risk; manual redelivery and an unknown network outcome remain unsafe. Durable
storage keyed by GitHub's `X-GitHub-Delivery` id, plus payment reconciliation,
is required before this flow can provide at-most-once behavior.

## 2. Deploy the Logic App

```bash
az group create --name zaplie-automation --location westeurope

az deployment group create \
  --resource-group zaplie-automation \
  --name github-rewards-logicapp \
  --template-file docs/automation/github-rewards-logicapp.json \
  --parameters \
      zaplieRewardsUrl="https://<bot-domain>/api/v1/rewards" \
      zaplieRewardsApiKey="<REWARDS_API_KEY value>"

# The webhook URL for GitHub comes out of the deployment outputs:
az deployment group show \
  --resource-group zaplie-automation \
  --name github-rewards-logicapp \
  --query properties.outputs.webhookUrl.value -o tsv
```

The API key is a `securestring` template parameter fed into a `SecureString`
workflow parameter, so it is not readable after deployment, and the HTTP action
has **Secure Inputs** enabled so the key never shows up in run history.
Moving the key to Key Vault with a managed identity is a follow-up, not part of
this template.

## 3. Point GitHub at the Logic App

In the repository: **Settings → Webhooks → Add webhook**

- **Payload URL**: the `webhookUrl` deployment output
- **Content type**: `application/json`
- **Events**: "Let me select individual events" → **Pull requests**

GitHub's initial `ping` delivery has no `action` field, so the workflow runs
and takes the empty else-branch — that is expected.

## 4. Customising the flow

The reward amount is not part of the template: it is configured in the portal
under **Automations → Reward rules**, keyed by `eventType`
(the template sends `eventType: "githubPrMerged"`, which the bot resolves
against the portal's `githubPrMergedSats` value). Open the Logic App in the
Azure portal designer to change anything else without touching code: edit the
condition (for example, only PRs into `main`) or add non-payment steps such as a
Teams notification. The endpoint rejects caller-supplied amounts and non-GitHub
sources. Provider-aware flows such as timesheets require a separate identity and
idempotency contract and are intentionally not advertised by this draft.

### Power Pulse is a pending product decision

The current data model records reward events and sats paid. It does not record
authoritative time, money or CO2 savings, so the Automations page must not infer
or display those measurements yet. Before adding Power Pulse, define the source,
unit, ownership, storage and idempotency rules for each measurement and persist
them alongside the automation event.

## Smoke test without Azure

The endpoint can be exercised directly by sending the same request the Logic
App would send (the Logic App is what transforms the raw GitHub event into
this payload — GitHub webhooks cannot target the endpoint directly):

```bash
curl -s -X POST https://<bot-domain>/api/v1/rewards \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $REWARDS_API_KEY" \
  -d '{"recipient":"octocat","recipientId":"583231","eventType":"githubPrMerged","repo":"octo-org/octo-repo","reason":"GitHub: PR #1 merged","source":"github"}'
```

`repo` must exactly match a repository configured under **Automations →
Connections**. `recipientId` is GitHub's stable numeric user id; the login is
kept only as a display label.

Expected: `{"status":"paid","paymentHash":"...","recipient":"octocat","amountSats":<configured value>}`.
