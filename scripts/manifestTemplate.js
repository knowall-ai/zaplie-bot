// Placeholder handling for manifest.template.json.
//
// The template carries two placeholder forms and they belong to different
// owners:
//
//   {{NAME}}    resolved by build.js before appPackage/manifest.json is written
//   ${{NAME}}   left untouched for Teams Toolkit to resolve from env/.env.<env>
//
// Values come from the environment and can legitimately contain '$', which
// String.prototype.replace would read as a capture reference ('$&', '$1',
// "$'"). Every substitution therefore goes through a replacer function, which
// inserts the value literally.

const placeholderPattern = name =>
  new RegExp(`(?<!\\$)\\{\\{${name}\\}\\}`, 'g');

// Replace each {{NAME}} with values[NAME]; ${{NAME}} is left for Teams Toolkit.
const substitutePlaceholders = (json, values) =>
  Object.entries(values).reduce(
    (result, [name, value]) =>
      result.replace(placeholderPattern(name), () => value),
    json,
  );

// Any {{NAME}} still present belongs to this script and was never resolved.
const findUnresolvedPlaceholders = json => [
  ...new Set(json.match(/(?<!\$)\{\{[^{}]+\}\}/g) || []),
];

module.exports = { substitutePlaceholders, findUnresolvedPlaceholders };
