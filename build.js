const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Read environment variables from .env.dev file
const envFilePath = path.join(__dirname, '.', 'env', '.env.dev');
const envConfig = dotenv.parse(fs.readFileSync(envFilePath));
const contentUrl = envConfig.CONTENT_URL;
const websiteUrl = envConfig.WEBSITE_URL;

// Check for missing environment variables
if (!contentUrl || !websiteUrl) {
  console.error('Error: CONTENT_URL and WEBSITE_URL environment variables added to your envirfonment file.');
  process.exit(1);
}

try {
  // Read the template file
  const templatePath = path.join(__dirname, 'manifest.template.json');
  const template = fs.readFileSync(templatePath, 'utf8');

  // Parse the template to a JSON object
  const manifest = JSON.parse(template);

  // Extract the current version
  const currentVersion = manifest.version;

  // Split the version into its components
  const versionParts = currentVersion.split('.').map(Number);

  // Increment the patch version (the last number) only for Test and Prod environments
  const environment = envConfig.ENVIRONMENT;
  if (environment === 'Test' || environment === 'Prod') {
    versionParts[2] += 1;
  }

  // Join the version parts back into a string
  const newVersion = versionParts.join('.');

  // Update the version number in the manifest
  manifest.version = newVersion;

  // Replace placeholders with environment variables
  const updatedManifest = JSON.stringify(manifest, null, 2)
    .replace(/{{CONTENT_URL}}/g, contentUrl)
    .replace(/{{WEBSITE_URL}}/g, websiteUrl);

  // Write the final manifest.json file
  const outputPath = path.join(__dirname, 'appPackage', 'manifest.json');
  fs.writeFileSync(outputPath, updatedManifest, 'utf8');

  console.log(`manifest.json has been generated successfully with version ${newVersion}.`);
} catch (error) {
  console.error('Error generating manifest.json:', error);
  process.exit(1);
}
