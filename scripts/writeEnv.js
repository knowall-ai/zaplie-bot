const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const env = process.env.TEAMSFX_ENV || 'local';

const envFilePath = path.join(__dirname, '..', 'env', '.env.dev');
const envOutputPath = path.join(__dirname, '..', 'env', `.env.${env}`);

// Load environment variables from .env.dev
const envConfig = dotenv.parse(fs.readFileSync(envFilePath));

// Select specific variables to write
const selectedVars = {
  LNBITS_NODE_URL: envConfig.LNBITS_NODE_URL,
  LNBITS_USERNAME: envConfig.LNBITS_USERNAME,
  LNBITS_PASSWORD: envConfig.LNBITS_PASSWORD,
  LNBITS_ADMINKEY: envConfig.LNBITS_ADMINKEY,
  WEBSITE_URL: envConfig.WEBSITE_URL,
  CONTENT_URL: envConfig.CONTENT_URL,
};

// Function to append selected variables to the appropriate environment files
const appendEnvFile = (filePath, vars) => {
  // Read existing content of the .env.local file
  let existingEnv = {};
  if (fs.existsSync(filePath)) {
    existingEnv = dotenv.parse(fs.readFileSync(filePath));
  }

  // Filter out variables that already exist
  const newVars = Object.entries(vars).filter(([key]) => !existingEnv[key]);

  if (newVars.length > 0) {
    const envFileContent = '\n' + newVars
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n';

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
  WEBSITE_URL: selectedVars.WEBSITE_URL,
  CONTENT_URL: selectedVars.CONTENT_URL,
});