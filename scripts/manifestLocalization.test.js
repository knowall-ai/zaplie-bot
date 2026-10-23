// Pins the Teams manifest localisation: the template declares Spanish, the
// Spanish file exists and every key in it points at a real string in the
// template. Command titles are deliberately not localised, because the words
// Teams inserts when a user picks a command must match what the bot parses.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { findUnresolvedPlaceholders } = require('./manifestTemplate');

const root = path.join(__dirname, '..');
const template = JSON.parse(
  fs.readFileSync(path.join(root, 'manifest.template.json'), 'utf8'),
);

// Resolves a localisation key such as "bots[0].commandLists[0].commands[1].description"
// against the template object.
const resolve = (object, key) =>
  key
    .split('.')
    .flatMap(part => part.split(/[[\]]/).filter(Boolean))
    .reduce(
      (value, part) =>
        value === undefined
          ? undefined
          : value[/^\d+$/.test(part) ? Number(part) : part],
      object,
    );

test('the template declares English by default and Spanish as an extra language', () => {
  const info = template.localizationInfo;
  assert.ok(info, 'localizationInfo missing from manifest.template.json');
  assert.strictEqual(info.defaultLanguageTag, 'en');
  assert.deepStrictEqual(
    info.additionalLanguages.map(language => language.languageTag),
    ['es'],
  );
});

test('every declared language file exists in appPackage and is valid JSON', () => {
  for (const language of template.localizationInfo.additionalLanguages) {
    const file = path.join(root, 'appPackage', language.file);
    assert.ok(fs.existsSync(file), `${language.file} missing from appPackage/`);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')));
  }
});

test('every Spanish key targets a string that exists in the template', () => {
  const es = JSON.parse(
    fs.readFileSync(path.join(root, 'appPackage', 'es.json'), 'utf8'),
  );
  for (const [key, value] of Object.entries(es)) {
    if (key === '$schema') continue;
    const original = resolve(template, key);
    assert.strictEqual(
      typeof original,
      'string',
      `${key} does not point at a string in manifest.template.json`,
    );
    assert.ok(
      typeof value === 'string' && value.trim() !== '',
      `${key} is empty`,
    );
  }
});

test('the Spanish file carries name.short, which the Teams schema requires', () => {
  const es = JSON.parse(
    fs.readFileSync(path.join(root, 'appPackage', 'es.json'), 'utf8'),
  );
  // Mirrors the template so Teams Toolkit substitutes the environment suffix
  // in the localised name exactly as it does in manifest.json.
  assert.strictEqual(es['name.short'], template.name.short);
});

test('command titles are left in English so the bot still matches them', () => {
  const es = JSON.parse(
    fs.readFileSync(path.join(root, 'appPackage', 'es.json'), 'utf8'),
  );
  const titles = Object.keys(es).filter(key =>
    /commands\[\d+\]\.title$/.test(key),
  );
  assert.deepStrictEqual(titles, []);
});

test('the Spanish file uses only ${{NAME}} placeholders, the form Teams Toolkit resolves in localisation files', () => {
  // build.js never reads es.json, so a {{NAME}} here would be resolved by
  // nobody and ship literally; Teams Toolkit's resolver only matches ${{NAME}}.
  const raw = fs.readFileSync(path.join(root, 'appPackage', 'es.json'), 'utf8');
  assert.deepStrictEqual(findUnresolvedPlaceholders(raw), []);
  // Every toolkit placeholder in es.json must also be one the template uses,
  // so the same env/.env.<env> value satisfies both files.
  const templateRaw = fs.readFileSync(
    path.join(root, 'manifest.template.json'),
    'utf8',
  );
  const toolkitVars = text =>
    new Set(text.match(/\$\{\{ *[A-Za-z_][A-Za-z0-9_]* *\}\}/g) || []);
  const templateVars = toolkitVars(templateRaw);
  for (const placeholder of toolkitVars(raw)) {
    assert.ok(
      templateVars.has(placeholder),
      `${placeholder} is not used in manifest.template.json`,
    );
  }
});
