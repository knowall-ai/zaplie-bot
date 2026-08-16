# Bot OAuth connections and the legacy Bot Framework registration

Features that make the bot call Microsoft Graph on behalf of the chatting user
(calendar-based recognition suggestions, and later e-mail) rely on the **Bot
Framework token service**: the user signs in once, the token service stores and
refreshes their token, and the bot retrieves it through an **OAuth connection**
configured on the bot.

This document explains a gotcha every developer hits when enabling these
features against a locally debugged bot, and how to fix it.

## The problem: local-debug bots are legacy registrations

Teams Toolkit's local-debug provisioning registers the bot with the
`botFramework/create` action in `teamsapp.local.yml`. That action creates a
**legacy registration** in the Bot Framework portal (`dev.botframework.com`) —
it is not an Azure resource.

The legacy portal **no longer offers OAuth Connection Settings**. Its settings
page ends at Save/Delete, with a _Migrate_ button at the top. OAuth connections
can only be configured on an **Azure Bot resource**, so a bot registered this
way cannot use the token service at all.

## The fix: migrate the registration to an Azure Bot

Migration is one-way but safe: it keeps the Microsoft App ID, password,
messaging endpoint and configured channels (including Teams), so the running
bot is unaffected. The Azure Bot's F0 tier is free.

1. Open `https://dev.botframework.com/bots/settings?id=<BOT_ID>` and press
   **Migrate**. This opens an Azure _Custom deployment_ pre-filled with the bot.
2. Pick a subscription and resource group, and change the **Sku to F0**.
3. Deploy. Verify with:

   ```bash
   az bot show -g <resource-group> -n <BOT_ID> \
     --query "{appId:properties.msaAppId, endpoint:properties.endpoint}"
   ```

### Keep local debug working after migration

`botFramework/create` manages the legacy registration, which no longer exists
after migration — the next debug session would fail on that step. Replace it in
`teamsapp.local.yml` with an endpoint update against the Azure Bot (dev tunnel
URLs are persistent per machine, so this is usually a no-op):

```yaml
- uses: script
  with:
    run: az bot update -g <resource-group> -n <BOT_ID> --endpoint ${{BOT_ENDPOINT}}/api/messages
```

This requires the Azure CLI to be signed in to the subscription that owns the
bot resource.

## Creating the OAuth connection

With the Azure Bot in place, create the connection the code refers to via
`GRAPH_CONNECTION_NAME`:

```bash
az bot authsetting create -g <resource-group> -n <BOT_ID> \
  --setting-name GraphWorkSignals \
  --client-id <SSO_APP_CLIENT_ID> \
  --client-secret <SSO_APP_CLIENT_SECRET> \
  --service Aadv2 \
  --provider-scope-string "Calendars.ReadBasic People.Read" \
  --parameters clientId=<SSO_APP_CLIENT_ID> clientSecret=<SSO_APP_CLIENT_SECRET> \
      tenantId=<TENANT_ID> tokenExchangeUrl=api://botid-<BOT_ID>
```

Where:

- `<SSO_APP_CLIENT_ID>` is the AAD app used for SSO (`AAD_APP_CLIENT_ID`) — the
  app that exposes `api://botid-<BOT_ID>` and holds the delegated Graph
  permissions. It needs delegated `Calendars.ReadBasic` and `People.Read`.
  `Calendars.ReadBasic` is sufficient because Zaplie does not request event
  bodies, attachments, or extensions.
- `tokenExchangeUrl` must match the SSO app's Application ID URI, or silent
  token exchange in Teams fails and users fall back to the sign-in card.

Then set `GRAPH_CONNECTION_NAME=GraphWorkSignals` in the bot's environment.

## Verifying

1. Start the bot and type `connect calendar` in a 1:1 chat — silent SSO should
   connect without showing a sign-in card (the card appearing means the token
   exchange URL or connection settings are wrong).
2. Ask the agent about recent meetings.
