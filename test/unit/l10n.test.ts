import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8')) as Record<string, unknown>;
}

function sortedKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort();
}

describe('manifest localization', () => {
  const manifestText = readFileSync(join(root, 'package.json'), 'utf8');
  const nls = readJson('package.nls.json');
  const placeholders = [...manifestText.matchAll(/"%([^%"]+)%"/g)].map((match) => match[1]);

  it('defines every %placeholder% used in package.json', () => {
    const missing = placeholders.filter((key) => key !== undefined && !(key in nls));
    expect(missing).toEqual([]);
  });

  it('has no unused keys in package.nls.json', () => {
    const unused = Object.keys(nls).filter((key) => !placeholders.includes(key));
    expect(unused).toEqual([]);
  });

  const translations = readdirSync(root).filter((file) => /^package\.nls\..+\.json$/.test(file));

  it.each(translations)('%s has the same keys as package.nls.json', (file) => {
    expect(sortedKeys(readJson(file))).toEqual(sortedKeys(nls));
  });
});

/** Every string literal passed to `vscode.l10n.t(...)` or its `t(...)` alias in `src/`. */
function localizedStrings(): string[] {
  const files = readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' }).filter((file) =>
    file.endsWith('.ts'),
  );
  const call = /(?:vscode\.l10n\.t|\bt)\(\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g;
  const keys = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(join(root, 'src', file), 'utf8').matchAll(call)) {
      const literal = match[1] ?? '';
      // Turn the TypeScript literal into its runtime value (handles \' and \").
      keys.add(literal.slice(1, -1).replace(/\\(.)/g, '$1'));
    }
  }
  return [...keys].sort();
}

describe('runtime localization bundles', () => {
  const bundles = readdirSync(join(root, 'l10n')).filter((file) => file.endsWith('.json'));
  const reference = readJson(join('l10n', 'bundle.l10n.pt-br.json'));
  const used = localizedStrings();

  it('finds the localized strings in the source', () => {
    expect(used.length).toBeGreaterThan(0);
  });

  it('translates every localized string', () => {
    expect(used.filter((key) => !(key in reference))).toEqual([]);
  });

  it('has no unused translations', () => {
    expect(Object.keys(reference).filter((key) => !used.includes(key))).toEqual([]);
  });

  it('keeps the {n} placeholders of every translation', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort();
    const mismatched = Object.entries(reference).filter(
      ([key, value]) => JSON.stringify(placeholders(key)) !== JSON.stringify(placeholders(String(value))),
    );
    expect(mismatched).toEqual([]);
  });

  it.each(bundles)('%s has the same keys as the pt-br bundle', (file) => {
    expect(sortedKeys(readJson(join('l10n', file)))).toEqual(sortedKeys(reference));
  });
});
