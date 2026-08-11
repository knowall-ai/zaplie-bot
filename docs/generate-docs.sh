#!/bin/bash

# Generate PDF documentation for Zaplie
# This script generates the main technical solution document

echo "Zaplie - Documentation Generator"
echo "================================"
echo ""

# Check if asciidoctor-pdf is installed
if ! command -v asciidoctor-pdf &> /dev/null; then
    echo "Error: asciidoctor-pdf is not installed"
    echo "Please install it with: sudo gem install asciidoctor-pdf asciidoctor-diagram"
    exit 1
fi

# Change to docs directory
cd "$(dirname "$0")"

# Set puppeteer to run without sandbox (required on Ubuntu 23.10+)
export PUPPETEER_ARGS='--no-sandbox --disable-setuid-sandbox'

# Generate Technical Solution Document
echo "Generating Technical Solution Document..."
asciidoctor-pdf -r asciidoctor-diagram \
    -a pdf-theme=knowall \
    -a pdf-themesdir=themes \
    -a pdf-fontsdir=themes \
    -a mermaid-puppeteer-config=puppeteer-config.json \
    TECHNICAL_SOLUTION_DOCUMENT.adoc \
    -o TECHNICAL_SOLUTION_DOCUMENT.pdf

if [ $? -eq 0 ]; then
    echo "✓ Technical Solution Document generated successfully (TECHNICAL_SOLUTION_DOCUMENT.pdf)"
else
    echo "✗ Error generating Technical Solution Document"
    exit 1
fi

echo ""
echo "Documentation generation complete!"
echo "Generated files:"
echo "  - docs/TECHNICAL_SOLUTION_DOCUMENT.pdf"
