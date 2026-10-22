@maxLength(20)
@minLength(4)
@description('Used to generate names for all resources in this file')
param resourceBaseName string

@description('Required when create Azure Bot service')
param botAadAppClientId string

@secure()
@description('Required by Bot Framework package in your bot project')
param botAadAppClientSecret string

param webAppSKU string

@maxLength(42)
param botDisplayName string

param serverfarmsName string = resourceBaseName
param webAppName string = resourceBaseName
param location string = resourceGroup().location
param aadAppClientId string
param aadAppTenantId string
param aadAppOauthAuthorityHost string
@secure()
param aadAppClientSecret string

@description('The agent id the Agents Portal knows this deployment by: zaplie for production. Tags the telemetry resources and is the AGENT_ID the bot stamps on every AgentActivity event.')
param agentId string = 'zaplie'

// Telemetry: AgentActivity events (agent-pulse) land in this workspace-based
// Application Insights. The Agents Portal finds the workspace by its agent tag.
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: 'log-${agentId}'
  location: location
  tags: {
    agent: agentId
  }
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${agentId}'
  location: location
  kind: 'web'
  tags: {
    agent: agentId
  }
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

// Compute resources for your Web App
resource serverfarm 'Microsoft.Web/serverfarms@2021-02-01' = {
  kind: 'app'
  location: location
  name: serverfarmsName
  sku: {
    name: webAppSKU
    // Token-exchange deduplication is in-memory, so the plan stays at one
    // instance. The zap-card ledger (src/services/zapLedger.ts) is durable and
    // coordinates processes through a lock file, but only across a shared
    // filesystem - scaling out needs shared storage for ZAPLIE_DATA_DIR.
    capacity: 1
  }
}

// Web App that hosts your bot
resource webApp 'Microsoft.Web/sites@2021-02-01' = {
  kind: 'app'
  location: location
  name: webAppName
  properties: {
    serverFarmId: serverfarm.id
    httpsOnly: true
    siteConfig: {
      alwaysOn: true
      ftpsState: 'FtpsOnly'
    }
  }
}

// Sole source of app settings: this child resource replaces the site's entire
// appSettings collection on deploy, so anything declared inline above is lost.
resource webAppSettings 'Microsoft.Web/sites/config@2021-02-01' = {
  name: '${webAppName}/appsettings'
  properties: {
    WEBSITE_NODE_DEFAULT_VERSION: '~24'
    WEBSITE_RUN_FROM_PACKAGE: '1'
    BOT_ID: botAadAppClientId
    BOT_PASSWORD: botAadAppClientSecret
    BOT_DOMAIN: webApp.properties.defaultHostName
    AAD_APP_CLIENT_ID: aadAppClientId
    AAD_APP_CLIENT_SECRET: aadAppClientSecret
    AAD_APP_TENANT_ID: aadAppTenantId
    AAD_APP_OAUTH_AUTHORITY_HOST: aadAppOauthAuthorityHost
    RUNNING_ON_AZURE: '1'
    NODE_ENV: 'production'
    // The App Service persistent share, outside wwwroot so a clean deploy
    // cannot wipe the zap ledger and reintroduce double payments. %HOME% is
    // deliberate: App Service passes app settings through verbatim, so the bot
    // expands this token itself (src/services/dataDir.ts) and lands on
    // D:\home on older Windows stamps, C:\home on newer ones and /home on
    // Linux - a hard-coded drive letter breaks when the app moves stamp.
    ZAPLIE_DATA_DIR: '%HOME%\\data\\zaplie'
    // agent-pulse: without the connection string the bot emits nothing.
    APPLICATIONINSIGHTS_CONNECTION_STRING: appInsights.properties.ConnectionString
    AGENT_ID: agentId
  }
}

// Register your web service as a bot with the Bot Framework
module azureBotRegistration './botRegistration/azurebot.bicep' = {
  name: 'Azure-Bot-registration'
  params: {
    resourceBaseName: resourceBaseName
    botAadAppClientId: botAadAppClientId
    botAppDomain: webApp.properties.defaultHostName
    botDisplayName: botDisplayName
  }
}

// The output will be persisted in .env.{envName}. Visit https://aka.ms/teamsfx-actions/arm-deploy for more details.
output BOT_AZURE_APP_SERVICE_RESOURCE_ID string = webApp.id
output BOT_DOMAIN string = webApp.properties.defaultHostName
