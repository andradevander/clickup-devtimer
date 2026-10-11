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

describe('runtime localization bundles', () => {
  const bundles = readdirSync(join(root, 'l10n')).filter((file) => file.endsWith('.json'));
  const reference = readJson(join('l10n', 'bundle.l10n.pt-br.json'));

  it.each(bundles)('%s has the same keys as the pt-br bundle', (file) => {
    expect(sortedKeys(readJson(join('l10n', file)))).toEqual(sortedKeys(reference));
  });
});
