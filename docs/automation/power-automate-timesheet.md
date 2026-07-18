# Timesheet rewards with Power Automate

Reward teammates automatically when they complete their weekly timesheet, using a
Power Automate flow and a Zaplie flow API key. No code and no bot changes needed;
this uses the same rewards endpoint as the GitHub Logic App.

## Prerequisites

1. A Zaplie admin creates a flow API key: portal > Automations > "Power Automate
   and Logic Apps" card > Create key. Copy the key when it is shown (it is shown
   only once; revoke it from the same card at any time).
2. The reward amount for the `timesheetWeek` event is configurable under
   Automations > Reward rules ("Timesheet week complete", default 800 sats).
3. The rewards endpoint of the bot must be reachable from Power Automate
   (`https://<bot-host>/api/v1/rewards`). For local development that is your dev
   tunnel URL.

## Build the flow

1. Power Automate > Create > **Automated cloud flow**, and pick the trigger that
   matches where your timesheets live. Common choices:
   - **When a response is submitted** (Microsoft Forms) for a weekly form.
   - **When an item is created or modified** (SharePoint) for a timesheet list.
   - **Recurrence** (weekly) plus a connector query against your timesheet system.
2. Add an **HTTP** action:
   - Method: `POST`
   - URI: `https://<bot-host>/api/v1/rewards`
   - Headers: `Content-Type: application/json` and `x-api-key: <your flow key>`
   - Body:

     ```json
     {
       "recipient": "@{outputs('Get_user_email')}",
       "eventType": "timesheetWeek",
       "reason": "Timesheet completed for week @{formatDateTime(utcNow(), 'yyyy-MM-dd')}",
       "source": "power-automate-timesheet"
     }
     ```

     `recipient` is the teammate's email as known to Zaplie. `eventType`
     `timesheetWeek` resolves the amount from the rule configured in the portal,
     so the flow never decides how much to pay.
3. Turn Secure Inputs on for the HTTP action so the API key does not appear in
   run history.

## What Zaplie enforces server-side

- The API key must be an active portal-issued key (or the env key). Revoking the
  key stops the flow immediately.
- Amounts come from the configured rule and are capped by
  `REWARDS_MAX_AMOUNT_SATS`; a flow cannot pay arbitrary amounts unless it sends
  an explicit `amountSats`, which is subject to the same cap.
- Recipients that are not on Zaplie yet become pending rewards instead of
  failures, so no recognition is lost.

## One-time setup for click-auth flows (custom connector)

Instead of adding an HTTP action with headers in every flow, import
`zaplie-rewards-connector.swagger.json` once (Power Automate > Data > Custom
connectors > Import an OpenAPI file, set your bot host). Creating the first
connection asks for the API key a single time; after that every flow gets a
"Send a reward" action with plain fields (recipient, event type, reason) and
one-click auth, exactly like first-party connectors.
