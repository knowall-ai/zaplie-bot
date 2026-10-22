# Automated rewards via Logic Apps

This draft ships a GitHub-specific rewards pilot: **pay a reward when a GitHub
pull request is merged**, delivered as an
Azure Logic App (Consumption) ARM template that each organisation deploys and
customises in the workflow designer (trigger conditions and non-payment steps).

> **Not production-ready:** the endpoint still needs aggregate budget
> enforcement, and a payment with an unknown outcome is held for an operator to
> reconcile by hand rather than reconciled automatically.
> The sample Request trigger also does not yet verify GitHub's webhook signature,
> so `source: "github"` is a payload claim rather than authenticated provenance.
> Keep the PR in draft and do not connect a funded treasury yet.

```
GitHub webhook ──► Logic App (Request trigger)
                     │ condition: action == 'closed' && pull_request.merged == true
                     ▼
                   HTTP POST ► Zaplie POST /api/v1/rewards  (X-Api-Key, Idempotency-Key)
                                 │ validates key + payload
                                 │ claims the Idempotency-Key (a repeat replays the first result)
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

1. In LNbits, create a user named `automation` (lower case) with one wallet.
   The portal backend finds the treasury by that username for its Automations
   and reports pages; set `TREASURY_USERNAME` on the portal backend if you use
   a different name.
2. Fund that wallet (admin top-up).
3. Set `REWARDS_TREASURY_ADMINKEY` to that wallet's **Admin key**.

Payments carry the memo from the automation (e.g. `GitHub: PR #123 merged`)
and show in the recipient's wallet transaction log as sent by "Automation"
(the shared feed resolves senders from teammate wallets, so treasury payments
may display an unattributed sender there — known limitation).

### Idempotency

Every request must carry an `Idempotency-Key` header: 1 to 256 printable ASCII
characters, unique per reward. The template sends GitHub's `X-GitHub-Delivery`
id, which stays the same when GitHub redelivers a webhook or a Logic App run is
resubmitted. A missing key is rejected with
`400 {"error":"Idempotency-Key header is required"}`, a malformed one with
`400 {"error":"Idempotency-Key header is invalid"}`. The key is required, not
derived from the payload, because two genuine rewards can have identical
bodies.

The bot records each key in `bot-reward-ledger.json` under `ZAPLIE_DATA_DIR`
before it pays (see `docs/DEPLOYMENT.adoc`). A repeat of a key gets:

| Earlier outcome | Response to the repeat |
| --- | --- |
| Paid | `200` with the original body and `Idempotency-Replayed: true`. Nothing is paid. |
| Pending (recipient not linked yet) | `202` with the original body and `Idempotency-Replayed: true`. Nothing is queued again. |
| Still being processed | `409 {"status":"processing","error":"reward is already being processed"}` |
| Payment or pending-reward outcome unknown | `409 {"status":"uncertain","error":"payment outcome unknown; needs reconciliation"}` |
| Same key, different reward (source, repo, event or recipient id) | `409 {"error":"Idempotency-Key was already used for a different reward"}` |
| Rejected before taking effect (bad payload, repo not connected, LNbits error before the payment call, or a pending reward the portal refused with a 4xx) | Nothing was recorded, so the repeat is processed normally. |

When the payment call itself fails or returns no payment hash, the reward may
have been paid. The same applies to queuing a pending reward: if the portal
call fails in flight or answers with a 5xx, the portal may have stored it, and
a queued reward is paid once the recipient links GitHub. In both cases the
endpoint answers `500 {"error":"payment outcome unknown"}` and holds the key as
`uncertain`: no retry or redelivery pays or queues it again until an operator
has checked LNbits or the portal's pending rewards and cleared it.

Because of this, the HTTP action's retry policy is enabled (three retries, 30
seconds apart). A retry of a reward that already paid replays the result; a
retry after a failure known to have taken no effect tries again.

A pending reward is recorded in the portal before the ledger marks it pending.
If the bot stops between the two, the key stays `processing` (no money moved)
and the pending entry may later need deduplicating by hand.

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
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"recipient":"octocat","recipientId":"583231","eventType":"githubPrMerged","repo":"octo-org/octo-repo","reason":"GitHub: PR #1 merged","source":"github"}'
```

Each `uuidgen` makes a new reward. To check replay, save the key in a variable
and send the same request twice: the second answer is identical, carries
`Idempotency-Replayed: true` (visible with `curl -i`), and pays nothing.

`repo` must exactly match a repository configured under **Automations →
Connections**. `recipientId` is GitHub's stable numeric user id; the login is
kept only as a display label.

Expected: `{"status":"paid","paymentHash":"...","recipient":"octocat","amountSats":<configured value>}`.
