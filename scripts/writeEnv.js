const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const env = process.env.TEAMSFX_ENV || 'local';

// TEAMSFX_ENV names a file inside env/, so keep it to a plain environment
// name — a value with separators or '..' would write outside that folder.
if (!/^[A-Za-z0-9_-]+$/.test(env)) {
  console.error(
    'Error: TEAMSFX_ENV is not a valid environment name (letters, digits, ' +
      'underscore and hyphen only).',
  );
  process.exit(1);
}

const envFilePath = path.join(__dirname, '..', 'env', '.env.dev');
const envOutputPath = path.join(__dirname, '..', 'env', `.env.${env}`);

// env/.env.dev is gitignored, so a clean checkout (or CI) may not have it.
// Read it when it exists and let process variables win, so values supplied by
// the environment still reach the generated file.
const fileConfig = fs.existsSync(envFilePath)
  ? dotenv.parse(fs.readFileSync(envFilePath))
  : {};
// NOTE: process.env wins, and whatever lands in selectedVars is written to
// env/.env.<TEAMSFX_ENV>. That file can therefore contain real credentials —
// .gitignore covers every env/.env.* for exactly this reason.
const envConfig = { ...fileConfig, ...process.env };

const hostnameOf = value => {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
};

// The tab URL the Entra manifest's SPA redirects point at.
//
// Locally it is only ever the tunnel value: falling back to CONTENT_URL here
// would persist a TAB_ENDPOINT that build.js then uses for the website URLs
// too, collapsing CONTENT_URL and WEBSITE_URL onto one value. A deployed
// environment has no tunnel, so it uses CONTENT_URL — build.js ignores
// TAB_ENDPOINT outside the local environment, so nothing collapses there.
const tabEndpoint =
  env === 'local' ? envConfig.TAB_ENDPOINT : envConfig.CONTENT_URL;

// Select specific variables to write
const selectedVars = {
  LNBITS_NODE_URL: envConfig.LNBITS_NODE_URL,
  LNBITS_USERNAME: envConfig.LNBITS_USERNAME,
  LNBITS_PASSWORD: envConfig.LNBITS_PASSWORD,
  LNBITS_ADMINKEY: envConfig.LNBITS_ADMINKEY,
  LNBITS_POINTS_LABEL: envConfig.LNBITS_POINTS_LABEL,
  LEADERBOARD_WINDOW_DAYS: envConfig.LEADERBOARD_WINDOW_DAYS,
  LEADERBOARD_TOP_N: envConfig.LEADERBOARD_TOP_N,
  PORTAL_URL: envConfig.PORTAL_URL,
  ZAPLIE_DATA_DIR: envConfig.ZAPLIE_DATA_DIR,
  WEBSITE_URL: envConfig.WEBSITE_URL,
  CONTENT_URL: envConfig.CONTENT_URL,
  // A local debug session overwrites both with the port 3000 tunnel before
  // provisioning.
  TAB_ENDPOINT: tabEndpoint,
  TAB_DOMAIN:
    (env === 'local' && envConfig.TAB_DOMAIN) ||
    hostnameOf(tabEndpoint || envConfig.CONTENT_URL),
  FOUNDRY_PROJECT_ENDPOINT: envConfig.FOUNDRY_PROJECT_ENDPOINT,
  FOUNDRY_MODEL: envConfig.FOUNDRY_MODEL,
  GRAPH_CONNECTION_NAME: envConfig.GRAPH_CONNECTION_NAME,
};

// Function to append selected variables to the appropriate environment files
const appendEnvFile = (filePath, vars) => {
  // Read existing content of the .env.local file
  let existingEnv = {};
  if (fs.existsSync(filePath)) {
    existingEnv = dotenv.parse(fs.readFileSync(filePath));
  }

  // Filter out variables that already exist or have no value in the source
  // (dotenv.parse yields '' for blank entries, not undefined)
  const newVars = Object.entries(vars).filter(
    ([key, value]) => value && !existingEnv[key],
  );

  if (newVars.length > 0) {
    const envFileContent =
      '\n' + newVars.map(([key, value]) => `${key}=${value}`).join('\n') + '\n';

    fs.appendFileSync(filePath, envFileContent, 'utf8');
    console.log(`${filePath} appended successfully.`);
  } else {
    console.log('No new variables to append.');
  }
};

// Append to .env.local
appendEnvFile(envOutputPath, {
  LNBITS_NODE_URL: selectedVars.LNBITS_NODE_URL,
  LNBITS_USERNAME: selectedVars.LNBITS_USERNAME,
  LNBITS_PASSWORD: selectedVars.LNBITS_PASSWORD,
  LNBITS_ADMINKEY: selectedVars.LNBITS_ADMINKEY,
  LNBITS_POINTS_LABEL: selectedVars.LNBITS_POINTS_LABEL,
  LEADERBOARD_WINDOW_DAYS: selectedVars.LEADERBOARD_WINDOW_DAYS,
  LEADERBOARD_TOP_N: selectedVars.LEADERBOARD_TOP_N,
  PORTAL_URL: selectedVars.PORTAL_URL,
  ZAPLIE_DATA_DIR: selectedVars.ZAPLIE_DATA_DIR,
  WEBSITE_URL: selectedVars.WEBSITE_URL,
  CONTENT_URL: selectedVars.CONTENT_URL,
  TAB_ENDPOINT: selectedVars.TAB_ENDPOINT,
  TAB_DOMAIN: selectedVars.TAB_DOMAIN,
  FOUNDRY_PROJECT_ENDPOINT: selectedVars.FOUNDRY_PROJECT_ENDPOINT,
  FOUNDRY_MODEL: selectedVars.FOUNDRY_MODEL,
  GRAPH_CONNECTION_NAME: selectedVars.GRAPH_CONNECTION_NAME,
});
