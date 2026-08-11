# Automated rewards via Logic Apps

Zaplie exposes a generic rewards endpoint that external automations call to pay
sats for events your organisation cares about. This folder ships the first
flow: **pay a reward when a GitHub pull request is merged**, delivered as an
Azure Logic App (Consumption) ARM template that each organisation deploys and
customises in the workflow designer (trigger conditions, amounts, extra steps).

```text
GitHub webhook --> Logic App (Request trigger)
                    | condition: action == 'closed' && pull_request.merged == true
                    v
                  HTTP POST --> Zaplie POST /api/v1/rewards (X-Api-Key)
                                  | validates key + payload
                                  | resolves recipientId (stable GitHub numeric id)
                                  | through the identity graph
                                  |
                                  +-- linked --> pays from the Automation treasury
                                  |               to the recipient's Private wallet
                                  |
                                  `-- unlinked -> records a pending reward for later
```

The Logic App uses the generic **Request trigger** instead of the native GitHub
connector on purpose: the connector's pull request trigger is in Preview, its
issue triggers only cover "assigned to me", and it does not support
organisation repositories. A plain webhook covers every GitHub event type.

## 1. Configure the Zaplie bot

Set these environment variables on the bot (alongside the existing LNbits ones):

| Variable | Purpose |
| --- | --- |
| `REWARDS_API_KEY` | Shared secret the automation must send in `X-Api-Key`. Endpoint returns 503 when unset. |
| `REWARDS_TREASURY_ADMINKEY` | Admin key of the treasury wallet that pays rewards (see below). |
| `WEBSITE_API_URL` | Base URL of the tabs backend API used for identity resolution, pending rewards, and reward-amount configuration. |
| `REWARDS_MAX_AMOUNT_SATS` | Optional per-reward cap. Defaults to 10000 (the same ceiling as the interactive zap card). Requests above it are rejected with 400, whether the amount came from the caller or from the portal config. |

Generate the API key with e.g. `openssl rand -hex 32`.

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
payment would pay the same PR twice. GitHub only redelivers webhooks
manually, so with retries off each merged PR produces at most one payment
attempt. An idempotency key (GitHub's `X-GitHub-Delivery` id) is the planned
follow-up for at-most-once guarantees across redeliveries.

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
under **Settings → Admin → Automation Reward Amounts**, keyed by `eventType`
(the template sends `eventType: "githubPrMerged"`, which the bot resolves
against the portal's `githubPrMergedSats` value). Open the Logic App in the
Azure portal designer to change anything else without touching code: edit the
condition (e.g. only PRs into `main`, or reward issue closers instead), or add
steps (Teams notification, approval). The HTTP action body also accepts an
explicit `amountSats` field as an override of the configured amount, for flows
that want to decide the amount themselves. Any event source that can POST
JSON can drive the same Zaplie endpoint — GitHub is just the first flow.

## Smoke test without Azure

The endpoint can be exercised directly by sending the same request the Logic
App would send (the Logic App is what transforms the raw GitHub event into
this payload — GitHub webhooks cannot target the endpoint directly):

```bash
curl -s -X POST https://<bot-domain>/api/v1/rewards \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $REWARDS_API_KEY" \
  -d '{"recipient":"octocat","recipientId":"583231","eventType":"githubPrMerged","reason":"GitHub: PR #1 merged","source":"github"}'
```

When that GitHub id is linked, expect
`{"status":"paid","paymentHash":"...","recipient":"octocat","amountSats":<configured value>}`.
When it is not linked, expect a `pending` response and a pending-reward record;
Zaplie never guesses from the login label.
