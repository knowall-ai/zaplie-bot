const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Load optional development defaults, then overlay the active Teams
// environment. Process variables win so CI can build without local .env files.
const envFilePath = path.join(__dirname, '.', 'env', '.env.dev');
let envConfig = fs.existsSync(envFilePath)
  ? dotenv.parse(fs.readFileSync(envFilePath))
  : {};

const activeEnv = process.env.TEAMSFX_ENV;
if (activeEnv && activeEnv !== 'dev') {
  const activeEnvPath = path.join(__dirname, '.', 'env', `.env.${activeEnv}`);
  if (fs.existsSync(activeEnvPath)) {
    envConfig = {
      ...envConfig,
      ...dotenv.parse(fs.readFileSync(activeEnvPath)),
    };
  }
}

envConfig = {
  ...envConfig,
  ...process.env,
};

const contentUrl = envConfig.TAB_ENDPOINT || envConfig.CONTENT_URL;
const websiteUrl = envConfig.TAB_ENDPOINT || envConfig.WEBSITE_URL;

// Check for missing environment variables
if (!contentUrl || !websiteUrl) {
  console.error(
    'Error: configure TAB_ENDPOINT, or both CONTENT_URL and WEBSITE_URL.',
  );
  process.exit(1);
}

try {
  // Read the template file
  const templatePath = path.join(__dirname, 'manifest.template.json');
  const template = fs.readFileSync(templatePath, 'utf8');

  // Parse the template to a JSON object
  const manifest = JSON.parse(template);

  // Teams requires a numeric, monotonically increasing version. Releases can
  // override the source version explicitly; normal local builds stay stable.
  const newVersion = envConfig.APP_VERSION || manifest.version;
  if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
    const source = envConfig.APP_VERSION
      ? 'APP_VERSION'
      : 'manifest.template.json';
    throw new Error(
      `Version from ${source} must use numeric major.minor.patch format.`,
    );
  }

  // Update the version number in the manifest
  manifest.version = newVersion;

  // Replace placeholders with environment variables
  const updatedManifest = JSON.stringify(manifest, null, 2)
    .replace(/{{CONTENT_URL}}/g, contentUrl)
    .replace(/{{WEBSITE_URL}}/g, websiteUrl);

  // Write the final manifest.json file
  const outputPath = path.join(__dirname, 'appPackage', 'manifest.json');
  fs.writeFileSync(outputPath, updatedManifest, 'utf8');

  console.log('manifest.json has been generated successfully.');
} catch (error) {
  // Log the message only: manifest inputs are environment-derived and may
  // contain secrets, so they must never reach build logs.
  console.error(`Error generating manifest.json: ${error.message}`);
  process.exit(1);
}
