const fs = require('fs');
const path = require('path');

// Read environment variables
const contentUrl = process.env.CONTENT_URL;
const websiteUrl = process.env.WEBSITE_URL;

// Check for missing environment variables
if (!contentUrl || !websiteUrl) {
  console.error('Error: CONTENT_URL and WEBSITE_URL environment variables must be set.');
  process.exit(1);
}

try {
  // Read the template file
  const templatePath = path.join(__dirname, 'manifest.template.json');
  const template = fs.readFileSync(templatePath, 'utf8');

  // Replace placeholders with environment variables
  const manifest = template
    .replace(/{{CONTENT_URL}}/g, contentUrl)
    .replace(/{{WEBSITE_URL}}/g, websiteUrl);

  // Write the final manifest.json file
  const outputPath = path.join(__dirname, 'appPackage','manifest.json');
  fs.writeFileSync(outputPath, manifest, 'utf8');

  console.log('manifest.json has been generated successfully.');
} catch (error) {
  console.error('Error generating manifest.json:', error);
  process.exit(1);
}