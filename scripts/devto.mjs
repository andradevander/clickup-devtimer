#!/usr/bin/env node
// dev.to publishing helper with two human approval gates.
//
//   node scripts/devto.mjs check                    verify the API key, print the dev.to username
//   node scripts/devto.mjs draft <file> [--dry-run]  create/update an UNPUBLISHED draft (needs approved: true)
//   node scripts/devto.mjs publish <file> [--dry-run] publish the existing draft (needs approved: true + devto_id)
//
// The API key is read from DEV_TO_API_KEY (environment or the gitignored .env file).
// It is only ever placed in the request header and is never printed or written anywhere.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://dev.to/api';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TAG_RE = /^[a-z0-9]+$/;

class CliError extends Error {}

// ---------- .env / key ----------

async function loadApiKey() {
  if (process.env.DEV_TO_API_KEY) return process.env.DEV_TO_API_KEY.trim();
  let text;
  try {
    text = await readFile(resolve(ROOT, '.env'), 'utf8');
  } catch {
    throw new CliError(
      'DEV_TO_API_KEY not found: create a .env file at the repo root with DEV_TO_API_KEY=...',
    );
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?DEV_TO_API_KEY\s*=\s*(.*)$/.exec(line);
    if (m) {
      const value = m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
      if (value) return value;
    }
  }
  throw new CliError('DEV_TO_API_KEY is missing or empty in .env');
}

// ---------- front matter ----------

function parseValue(raw) {
  const v = raw.trim();
  if (v === '') return '';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (v.startsWith('[') && v.endsWith(']')) {
    return v
      .slice(1, -1)
      .split(',')
      .map((s) => unquote(s.trim()))
      .filter(Boolean);
  }
  return unquote(v);
}

function unquote(s) {
  return s.replace(/^(['"])(.*)\1$/, '$2');
}

export function parsePost(text) {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const normalized = noBom.replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!m) throw new CliError('File must start with a front matter block delimited by --- lines');
  const data = {};
  const lines = m[1].split('\n');
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) throw new CliError(`Unsupported front matter line: "${line}" (use simple "key: value")`);
    data[kv[1]] = parseValue(kv[2]);
  }
  return { data, lines, body: normalized.slice(m[0].length).replace(/^\n+/, '') };
}

function serializeValue(v) {
  return typeof v === 'string' && /[:#[\]{}]|^\s|\s$/.test(v) ? JSON.stringify(v) : String(v);
}

/** Rewrites (or appends) the given keys in the front matter, keeping every other line untouched. */
export function updateFrontMatter(text, updates) {
  const { lines, body } = parsePost(text);
  const pending = new Map(Object.entries(updates));
  const out = lines.map((line) => {
    const key = /^([A-Za-z_][\w-]*)\s*:/.exec(line)?.[1];
    if (key && pending.has(key)) {
      const v = pending.get(key);
      pending.delete(key);
      return `${key}: ${serializeValue(v)}`;
    }
    return line;
  });
  for (const [k, v] of pending) out.push(`${k}: ${serializeValue(v)}`);
  return `---\n${out.join('\n')}\n---\n\n${body}`;
}

// ---------- article payload ----------

function normalizeTags(tags) {
  if (tags === undefined || tags === null || tags === '') return [];
  const list = Array.isArray(tags) ? tags : String(tags).split(',');
  return list.map((t) => String(t).trim()).filter(Boolean);
}

export function buildArticle(data, body, { published }) {
  const errors = [];
  if (!data.title || typeof data.title !== 'string') errors.push('title is required');
  const tags = normalizeTags(data.tags);
  if (tags.length > 4) errors.push(`dev.to allows at most 4 tags (got ${tags.length})`);
  for (const t of tags) {
    if (!TAG_RE.test(t)) errors.push(`invalid tag "${t}": dev.to tags must be lowercase alphanumeric only`);
  }
  if (!body.trim()) errors.push('post body is empty');
  if (errors.length) throw new CliError(`Invalid post:\n  - ${errors.join('\n  - ')}`);

  const article = { title: data.title, body_markdown: body, published, tags };
  if (data.description) article.description = data.description;
  if (data.canonical_url) article.canonical_url = data.canonical_url;
  if (data.cover_image) article.main_image = data.cover_image;
  if (data.series) article.series = data.series;
  // Local-only keys (approved, devto_id, devto_url) are intentionally never copied into the payload.
  return article;
}

// ---------- HTTP ----------

async function request(method, path, apiKey, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'api-key': apiKey,
      accept: 'application/vnd.forem.api-v1+json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) throw new CliError(describeHttpError(res, json, text));
  return json;
}

function describeHttpError(res, json, text) {
  const detail = (json && (json.error || json.message)) || text.slice(0, 300) || res.statusText;
  switch (res.status) {
    case 401:
      return `401 Unauthorized: the DEV_TO_API_KEY was rejected. Generate a new key at https://dev.to/settings/extensions.`;
    case 403:
      return `403 Forbidden: ${detail}`;
    case 404:
      return `404 Not Found: the article does not exist or does not belong to this account (${detail}).`;
    case 422:
      return `422 Unprocessable Entity: dev.to rejected the article: ${detail}`;
    case 429: {
      const retry = res.headers.get('retry-after');
      return `429 Too Many Requests: dev.to rate limit hit${retry ? `, retry after ${retry}s` : ''}. Wait and try again.`;
    }
    default:
      return `HTTP ${res.status} ${res.statusText}: ${detail}`;
  }
}

function printDryRun(method, path, body) {
  console.log('[dry-run] Nothing was sent. Request that would be made:');
  console.log(`${method} ${API}${path}`);
  console.log('headers: api-key: <redacted>, accept: application/vnd.forem.api-v1+json');
  console.log(JSON.stringify(body, null, 2));
}

// ---------- commands ----------

async function loadPost(file) {
  if (!file) throw new CliError('Missing <file> argument');
  const path = resolve(process.cwd(), file);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new CliError(`Cannot read ${path}`);
  }
  return { path, text, ...parsePost(text) };
}

function requireApproved(data, path) {
  if (data.approved !== true) {
    throw new CliError(
      `Refusing: ${path} is not approved. A human must review the file and set "approved: true" in its front matter.`,
    );
  }
}

function parseId(data) {
  if (data.devto_id === undefined || data.devto_id === null || data.devto_id === '') return undefined;
  const id = Number(data.devto_id);
  if (!Number.isInteger(id) || id <= 0) throw new CliError(`Invalid devto_id: ${String(data.devto_id)}`);
  return id;
}

async function cmdCheck() {
  const key = await loadApiKey();
  const me = await request('GET', '/users/me', key);
  console.log(`OK: authenticated as @${me.username}`);
}

async function cmdDraft(file, dryRun) {
  const post = await loadPost(file);
  requireApproved(post.data, post.path);
  const id = parseId(post.data);
  const payload = { article: buildArticle(post.data, post.body, { published: false }) };
  const [method, path] = id ? ['PUT', `/articles/${id}`] : ['POST', '/articles'];
  if (dryRun) return printDryRun(method, path, payload);

  const key = await loadApiKey();
  const res = await request(method, path, key, payload);
  if (res.published) {
    console.warn('Warning: this article is already PUBLISHED on dev.to; its content was updated live.');
  }
  await writeFile(post.path, updateFrontMatter(post.text, { devto_id: res.id, devto_url: res.url }), 'utf8');
  console.log(`${id ? 'Updated' : 'Created'} dev.to draft #${res.id} (unpublished).`);
  console.log(`Preview it (only you can see it): ${res.url}`);
  console.log(`Edit it on dev.to: https://dev.to/${res.user?.username ?? '<you>'}/${res.slug}/edit`);
  console.log(`Wrote devto_id and devto_url to ${post.path}`);
}

async function cmdPublish(file, dryRun) {
  const post = await loadPost(file);
  requireApproved(post.data, post.path);
  const id = parseId(post.data);
  if (!id)
    throw new CliError(`Refusing: ${post.path} has no devto_id. Run "draft" first and preview the draft.`);
  const path = `/articles/${id}`;
  const payload = { article: { published: true } };
  if (dryRun) return printDryRun('PUT', path, payload);

  const key = await loadApiKey();
  const res = await request('PUT', path, key, payload);
  await writeFile(post.path, updateFrontMatter(post.text, { devto_url: res.url }), 'utf8');
  console.log(`Published dev.to article #${res.id}.`);
  console.log(`Public URL: ${res.url}`);
}

const USAGE = `Usage:
  node scripts/devto.mjs check
  node scripts/devto.mjs draft <file> [--dry-run]
  node scripts/devto.mjs publish <file> [--dry-run]`;

async function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const [command, file] = argv.filter((a) => a !== '--dry-run');
  switch (command) {
    case 'check':
      return cmdCheck();
    case 'draft':
      return cmdDraft(file, dryRun);
    case 'publish':
      return cmdPublish(file, dryRun);
    default:
      console.log(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    // Error messages never include the API key (it only lives in the request header).
    console.error(
      err instanceof CliError ? `Error: ${err.message}` : `Unexpected error: ${err?.message ?? err}`,
    );
    process.exitCode = 1;
  });
}
