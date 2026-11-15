# Automated rewards: GitHub pull requests

Zaplie pays a reward when a pull request is merged in a connected repository.
GitHub calls the bot directly through a signed webhook. The bot checks the
signature, works out the amount from the admin's settings, checks the period
budget, and pays from a dedicated treasury wallet.

Nothing pays until an admin has set an amount and a budget. Every amount, level
bonus, per-person base and budget is a setting; there are no built-in amounts.

```
GitHub (repository webhook, "Pull requests")
   │  X-Hub-Signature-256 = HMAC-SHA256(raw body, GITHUB_WEBHOOK_SECRET)
   ▼
Zaplie bot  POST /api/v1/github/webhook
   │ 503 if GITHUB_WEBHOOK_SECRET is unset; 401 on a missing or wrong signature
   │ only pull_request / closed / merged: true earns a reward (others: 204)
   │ idempotency key = the signed pull request id (one reward per PR)
   │ repository must be connected under Automations → Connections (else 403)
   │ GitHub numeric id → verified identity → LNbits user (unlinked: pending)
   │ amount = person's base override, else the org base, + highest level bonus
   │ amount ≤ REWARDS_MAX_AMOUNT_SATS, and fits the period budget (else 402)
   ▼
pays from the "Automation" treasury wallet → recipient's Private wallet
```

## 1. Configure the bot

Set these on the bot App Service, alongside the existing LNbits settings. Names
only here; values live in App Service settings and nowhere else.

| Variable | Purpose |
| --- | --- |
| `GITHUB_WEBHOOK_SECRET` | Shared secret GitHub signs each delivery with. Generate with `openssl rand -hex 32` and paste the same value into every repository webhook. Unset: the webhook answers 503 and pays nothing. |
| `ZAPLIE_TREASURY_NWC` (portal backend) | NWC connection of the treasury wallet that pays rewards (see below). The bot asks the portal to pay and holds no treasury credential. |
| `WEBSITE_API_URL` | Base URL of the portal backend API, including `/api` (for example `https://<portal-domain>/api`). The bot reads amounts, policy and identities from it. |
| `TAB_BACKEND_TOKEN` | Shared secret the bot sends to the portal backend. Must be a real value, the same on both apps, or every reward fails before payment. |
| `REWARDS_MAX_AMOUNT_SATS` | Ceiling for one reward (base plus bonus). Defaults to 10000. Set it on the bot and the portal backend. A malformed value fails closed. |
| `REWARDS_BUDGET_PERIOD`, `REWARDS_BUDGET_CAP_SATS`, `REWARDS_BUDGET_TIMEZONE` | Optional. Each one that is set overrides the portal's budget field of the same name (`week` or `month`; a positive whole number of sats; an IANA zone such as `Europe/London`). |
| `REWARDS_API_KEY` | Optional. Only for other callers of `POST /api/v1/rewards` (section 5); GitHub does not use it. |

### Treasury wallet

Rewards are paid from a dedicated treasury, never from a teammate's Allowance:

1. In LNbits, signed in as `zaplie.service`, create a wallet named
   `Treasury` (the existing `Zaplie` wallet may be reused). Do not name it
   `Allowance`.
2. Fund it with **one budget period at most**. The bot's budget ledger is the
   first limit; the wallet balance is the second, independent one.
3. On that wallet create an NWC connection (*NWC Provider*): permissions pay,
   invoice, lookup, history, balance and info; budget = one budget period.
   Set `ZAPLIE_TREASURY_NWC` on the portal backend to its connection string.
   Rewards go only to directory members, at their registered Lightning
   address.

Payments carry the memo `GitHub: PR #<n> merged - <title>` and show as sent by
"Automation" in the recipient's transaction log.

## 2. Configure the portal

In the portal, open **Automations**. Only a `Zaplie.Admin` can edit; everyone
else sees the values read-only.

1. **Connections**: add each repository (`owner/repo`) that should earn
   rewards. A delivery from any other repository is refused with 403.
2. **Reward rules**: set the amount for "pull request merged". Until it is set
   the card reads "Not set: pays nothing unless a person has an override",
   and a reward for anyone without an override answers 503.
3. **Reward policy → Budget**: weekly or monthly, the cap in sats, and the
   time zone the period follows. Until a budget is set (here or in the
   `REWARDS_BUDGET_*` settings) every reward answers 503.
4. **Reward policy → Level bonuses** (optional): a label prefix (for example
   `reward:`) and levels with a bonus each (for example `L1`, `L2`, `L3`).
5. **Reward policy → Per-person base** (optional): a different base amount
   for a named person.

Every value is checked in the browser and again by the server: positive whole
sats only, and the largest base plus the largest bonus must stay within
`REWARDS_MAX_AMOUNT_SATS`.

Each teammate links GitHub once under **Settings → Connect GitHub**. A reward
for someone who has not linked yet is held as pending in the portal and is not
paid automatically; an operator pays it by hand.

## 3. Add the webhook to each repository

In the repository: **Settings → Webhooks → Add webhook**

- **Payload URL**: `https://<bot-domain>/api/v1/github/webhook`
- **Content type**: `application/json` (form-encoded deliveries are refused
  with 415)
- **Secret**: the `GITHUB_WEBHOOK_SECRET` value
- **Events**: "Let me select individual events" → **Pull requests** only

GitHub sends a `ping` first; the bot answers 204. Try it on a test repository
with a small amount before connecting the real ones.

If the repository still has a webhook to the legacy Logic App, **remove it in
the same change**. Both paths send the same idempotency key
(`github:pull_request:<id>:merged`), so a merge one path has paid replays on
the other and is never paid twice; but the Logic App's trigger verifies
nothing, so it must not stay in front of a funded treasury.

## 4. How the amount is decided

For a merged pull request by a linked teammate:

1. **Base**: that person's per-person base for the event if one is set,
   otherwise the org amount from Reward rules. Neither set: 503, nothing paid.
2. **Bonus**: the labels on the pull request when it merged are compared with
   `<prefix><level>` for each configured level (case-insensitive, as GitHub
   compares labels). The highest matching bonus is added. Bonuses are never
   summed, and labels that match no level are ignored.
3. **Cap**: base plus bonus must be at most `REWARDS_MAX_AMOUNT_SATS`, or
   nothing is paid.
4. **Budget**: for a linked author, the amount is reserved in the current
   period (ISO week, Monday to Sunday, or calendar month, in the configured
   time zone). The period is taken when the bot processes the delivery, not from the merge time, so a
   late or redelivered merge counts in the period it arrives in. If it would
   take the period over the cap the answer is 402 and nothing is paid.

An unlinked author gets the org base plus the bonus, held as pending. Pending
rewards do not count against the budget: nothing pays them automatically, so
they would only shrink the period for linked people. They never reserve, so
one is still queued when the period is near or over its cap, and queued
pending sats are not bounded by the cap. A pending write with an unknown
outcome holds no budget either; its key stays `uncertain` (409 on every
repeat) so it cannot be queued twice.

Two merges earn nothing and answer 200 `{"status":"not-rewarded"}`:

- **Bot authors** (GitHub `type: Bot`, or a login ending in `[bot]`, such as
  Dependabot). They have no Zaplie person to pay.
- **Self-merges**: the person who merged the pull request (`merged_by`, by
  GitHub numeric id) is its author. Auto-merge counts as the person who
  enabled it, so an author turning on auto-merge for their own pull request is
  a self-merge. On a repository with a merge queue the merge is attributed to
  `github-merge-queue[bot]`, so the bot cannot tell who queued it: the
  self-merge guard does not apply there, and required reviews in branch
  protection must stand in for it.

Labels must be on the pull request **before** it merges. A label added later
changes nothing: the reward for that pull request has already been decided,
and a redelivery replays it. Anyone with triage rights can add a label; that
is accepted for staff use and should be revisited before customers use it.

### Responses

| Situation | Response | Paid? |
| --- | --- | --- |
| `GITHUB_WEBHOOK_SECRET` unset | 503 | No |
| Signature missing, malformed or wrong | 401 | No |
| Not a JSON content type | 415 | No |
| Body over 1 MB | 413 | No |
| `ping`, any other event, or a PR closed without merging | 204 | No |
| Merge more than 30 days old (replay protection) | 422 | No |
| Merge with no positive numeric `merged_by.id` | 400 | No |
| Bot author, or the author merged it themselves | 200 `{"status":"not-rewarded",...}` | No |
| Repository not connected | 403 | No |
| No amount or no budget configured | 503 | No |
| Over the period budget (linked author) | 402 | No |
| Paid | 200 `{"status":"paid",...}` | Yes |
| Author has not linked GitHub | 202 `{"status":"pending",...}` | Held |
| The same pull request again (GitHub redelivery, or a resent capture) | The first answer, with `Idempotency-Replayed: true` | No |
| Payment outcome unknown | 500, then 409 `uncertain` on every repeat | Maybe: reconcile |

A 402 releases the reward's key. Redelivering it from GitHub (**Settings →
Webhooks → Recent deliveries → Redeliver**) in a later period pays it; that is
a person's decision, never automatic.

### Idempotency

The webhook's idempotency key is the pull request's own id, from the signed
body (`github:pull_request:<id>:merged`). It is deliberately not
`X-GitHub-Delivery`: that header is not covered by the signature, so a
captured request resent under a new delivery id must still replay rather than
pay. The legacy Logic App template sends the same key, so the two paths share
one ledger entry per merge. A merge older than 30 days is refused so a replay
can never outlive the reward ledger's 90-day record.

The bot records each key in `bot-reward-ledger.json`, and each budget
reservation in `bot-reward-budget.json`, both under `ZAPLIE_DATA_DIR` (see
`docs/DEPLOYMENT.adoc`). A reward whose payment outcome is unknown stays
`uncertain` and blocks every repeat until an operator reconciles it; it is
never cleared or retried automatically.

## 5. The rewards API (other callers)

`POST /api/v1/rewards` runs the same pipeline for callers that are not GitHub,
such as a smoke test. It takes `X-Api-Key` (`REWARDS_API_KEY` or a key created
under **Automations → Reward API keys**) and a caller-chosen `Idempotency-Key`
(1 to 256 printable ASCII characters, unique per reward):

```bash
curl -s -X POST https://<bot-domain>/api/v1/rewards \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $REWARDS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"recipient":"octocat","recipientId":"583231","eventType":"githubPrMerged","repo":"octo-org/octo-repo","reason":"GitHub: PR #1 merged","source":"github","labels":["reward:L1"]}'
```

| Field | Meaning |
| --- | --- |
| `recipient` | Display label (the GitHub login). |
| `recipientId` | GitHub's stable numeric user id; the identity graph is keyed on it. |
| `eventType` | `githubPrMerged`, `githubIssueClosed` or `githubReviewSubmitted`. |
| `repo` | `owner/repo`, exactly as connected under Automations. |
| `reason` | Invoice memo. |
| `source` | `github`. |
| `labels` | Optional: up to 50 printable ASCII strings of 1 to 50 characters. |

`amountSats` is refused: the amount always comes from the settings. Each new
`Idempotency-Key` is a new reward and counts against the budget. Sending the
same key twice replays the first answer with `Idempotency-Replayed: true`.

This path has no bot-author or self-merge guard: its body carries neither the
author's type nor `merged_by`, so the caller must apply them. It is being
retired for the signed webhook.

## Legacy: the Logic App template

`github-rewards-logicapp.json` is the earlier pilot: a Logic App Request
trigger that forwarded GitHub events to `POST /api/v1/rewards`. Its trigger
does not verify GitHub's signature, so its `source: "github"` is a claim, not
proof. It is kept for reference only. **Do not deploy it in front of a funded
treasury**; use the signed webhook above.

## Power Pulse is a pending product decision

The data model records reward events and sats paid. It does not record
authoritative time, money or CO2 savings, so the Automations page must not
infer or display those measurements yet. Before adding Power Pulse, define the
source, unit, ownership, storage and idempotency rules for each measurement and
persist them alongside the automation event.

# Weekly allowances: the LNbits allowance extension

Every person's Allowance wallet is topped up on a schedule by the LNbits
[allowance extension](https://github.com/BenGWeeks/allowance), paying from a
"Fund" wallet. Zaplie never pays: the portal backend only keeps one schedule
per person in the extension (named `zaplie:<oid>`) and one pay link per
Allowance wallet (Lightning address `zaplie-<first 12 hex of the oid>@<LNbits
host>`). See `docs/SOLUTION_DESIGN.adoc`, "Weekly allowances".

Nothing is created or paid until an admin stores an **enabled** policy with an
amount, period, anchor, time and time zone. There are no built-in amounts or
schedules. A disabled policy pauses every Zaplie schedule on the next sync.

## Prerequisites (once)

In LNbits (super user):

1. Install the allowance extension and note its version.
2. Enable it for the **Zaplie** account, and create a wallet named `Fund` on
   that account. Never name it `Allowance` or `Private`, and never use a wallet
   that belongs to a person; the sync refuses both.
3. Enable **LNURLp** for every person's LNbits user, and add it to the default
   extensions for new users. A person without it is skipped (the pay link is
   refused) and the rest of the run carries on.
4. Fund the `Fund` wallet with at least one period (amount × people). Apply is
   refused below one period unless `--allow-underfunded` is given, and warns
   below two.

On the portal App Service, set (names only; values live in App Service
settings):

| Setting | Purpose |
| --- | --- |
| `ALLOWANCE_FUND_ADMINKEY` | Admin key of the `Fund` wallet. Comma-separated for more than one Fund wallet (100 schedules each). Unset: preview only, apply refused. |
| `LNBITS_PUBLIC_HOST` | The public LNbits host the extension pays over HTTPS, for example `bank.knowall.ai`. Defaults to the host of `LNBITS_URL`. |
| `ALLOWANCE_MAX_AMOUNT_SATS` | Optional ceiling per person per period (default 100000). |
| `ALLOWANCE_SYNC_INTERVAL_MINUTES` | Optional. How often the automatic sync runs (default 360; `0` turns it off). |
| `ALLOWANCE_SYNC_DISABLED` | Optional. `true` stops the automatic sync. |

## From the portal

Open **Automations → Weekly allowances**. Everyone signed in sees the
policy, the Fund balance, the extension's health and the last run. Only a
`Zaplie.Admin` can edit:

1. Fill in the policy and **Save policy**. Saving changes nothing in LNbits.
2. **Preview sync** lists every change (pay links, schedules, drift, skips)
   with the **total per period** and any warning or block.
3. **Apply N changes** applies exactly that preview: the server refuses it
   (409) if its own plan now has a different total, and the preview must be
   run again. An underfunded Fund needs the explicit tick to go ahead, and so
   does a mass delete of leavers ("These people have left LNbits"). An
   incomplete LNbits user list cannot be overridden: preview again later.
   While another sync holds the lock (the CLI or the automatic one), preview
   and apply answer 409 `busy`; try again when it finishes.

After that the portal keeps the schedules in step every
`ALLOWANCE_SYNC_INTERVAL_MINUTES` (new people get theirs) for as long as the
policy is the one an admin applied. The first automatic run is one full
interval after the backend starts (six hours by default), not at start, so do
not wait for it after a deploy: preview and apply by hand. A changed policy
waits for an admin to preview and apply it; turning the policy off is applied
automatically, since it only pauses schedules. The automatic sync never
applies over a block and never overwrites a hand edit unless the policy's
`overwriteDrift` says so. It takes the same lock as the CLI, so there is no
need to stop it (`ALLOWANCE_SYNC_DISABLED`) while you run the CLI. An
unreadable or corrupt `data.json` stops the automatic sync and the portal's
allowance routes with `policy-invalid` (nothing is written); it never reads as
a disabled policy, so it never pauses the schedules.

## Running the sync from the command line (the fallback)

Run it on the portal App Service (Linux, SSH console), so it reads the same
`data.json` and writes the same `allowance-sync.json` as the portal:

```bash
cd /home/site/wwwroot      # the deployed tabs/ folder
# If `printenv LNBITS_NODE_URL` prints nothing in this shell, load the app
# settings it needs from the app process (prints nothing):
while IFS= read -r line; do export "$line"; done < <(tr '\0' '\n' < /proc/1/environ | grep -E '^(LNBITS_|ALLOWANCE_|ZAPLIE_DATA_DIR=)')
```

1. Write the policy agreed with the Product Owner to a file. Every value is a
   decision, none is a default (weekday 0 is Sunday, 5 is Friday):

   ```json
   {
     "enabled": true,
     "amountSats": <sats per person per period>,
     "period": "weekly",
     "anchorWeekday": <0-6>,
     "anchorTime": "<HH:mm>",
     "timezone": "<IANA zone, e.g. Europe/London>",
     "memo": "<shown to the payer; never 'Weekly Allowance cleared'>"
   }
   ```

2. Store it (validated; no LNbits call), then check it:

   ```bash
   node backend/scripts/allowance-sync.js --set-policy /tmp/allowance-policy.json
   node backend/scripts/allowance-sync.js --show-policy
   ```

3. Preview. Nothing in LNbits changes. Review the table, the Fund balance and
   the **total per period** with the Product Owner:

   ```bash
   node backend/scripts/allowance-sync.js
   ```

4. Apply, echoing the previewed total. A different total (people or the policy
   changed since the preview) is refused: preview again.

   ```bash
   node backend/scripts/allowance-sync.js --apply --confirm-total <total per period>
   ```

5. Run the preview again: every line should be `noop`.

One sync runs at a time, across the CLI and the portal:
`allowance-sync.lock` in the data directory names the run holding it (pid,
host, time). While another run holds it, the CLI prints `allowance sync not
started: another allowance sync is already running ...` and exits with code 3;
run it again when that one finishes. A lock left by a process that died is
taken over after 30 minutes.

To stop all allowances, set `"enabled": false` with `--set-policy`, preview,
and apply with the total the preview shows (0 unless hand-edited schedules
remain active): every Zaplie schedule is paused, none is deleted. Turning it
back on never pays a missed period: a paused schedule whose next payment date
has passed is recreated from the next anchor (`recreate reactivate-overdue`),
and one still ahead is reactivated in place.

To leave someone out, add their Entra object id to `excludedOids`; their
schedule is deleted on the next apply.

Two blockers protect against deleting schedules by mistake. `BLOCKED: LNbits
returned fewer users than it announced` (`people-incomplete`): the user list
came back short, so nobody missing from it is treated as a leaver; preview
again later. `BLOCKED: ... leaver schedules would be deleted` (`mass-delete`):
more than max(5, 10%) of the schedules would go as leavers. Check that those
people really left LNbits; only then apply with `--allow-mass-delete`.

`drift` lines are schedules someone changed by hand in the extension; they are
reported, not overwritten. `--overwrite-drift` puts them back to the policy.
`paused` lines are schedules paused by hand, and stay paused unless
overwritten. Each apply appends one line per change to `allowance-audit.jsonl`
in the data directory; no key is ever printed or stored.
