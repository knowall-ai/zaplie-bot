import fs from 'fs';
import path from 'path';

// jsdom does no layout, so guard the two rules that broke the Add people
// dialog in a real browser: a .textBox outside a row once grew to its
// 220px flex-basis in height, and the Show button inherited the app-wide
// `button { width: 100% }` and covered the token field.
const css = fs.readFileSync(path.join(__dirname, 'setting.module.css'), 'utf8');

const declarations = (selector: string): Record<string, string> => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`No rule for ${selector}`);
  return Object.fromEntries(
    match[1]
      .split(';')
      .map(line => line.replace(/\/\*[\s\S]*?\*\//g, '').trim())
      .filter(line => line.includes(':') && !line.startsWith('composes'))
      .map(line => {
        const at = line.indexOf(':');
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }),
  );
};

describe('setting.module.css layout contract', () => {
  test('a .textBox is single-line and full width by default', () => {
    const rule = declarations('.textBox');
    expect(rule.flex).toBe('none');
    expect(rule.width).toBe('100%');
  });

  test('only a .textBox inside .inputRow grows along the row', () => {
    expect(declarations('.inputRow > .textBox').flex).toBe('1 1 220px');
    const growing = css.match(/flex:\s*1 1 220px/g) || [];
    expect(growing).toHaveLength(1);
  });

  test('a secret field is [input flex 1][auto-width button] on one line', () => {
    expect(declarations('.secretField').display).toBe('flex');
    expect(declarations('.secretField > .textBox').flex).toBe('1 1 auto');
    const button = declarations('.revealButton');
    expect(button.width).toBe('auto');
    expect(button.flex).toBe('none');
    expect(button.position).toBeUndefined();
  });
});
