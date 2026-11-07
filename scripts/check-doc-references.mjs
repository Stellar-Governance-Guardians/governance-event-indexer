#!/usr/bin/env node
/**
 * No phantom references (charter, evidence rule 7).
 *
 * Scans README.md and every Markdown file under docs/ for:
 *   - `scripts/...` paths,
 *   - `.github/workflows/...` paths,
 *   - `npm run <name>` invocations,
 *   - relative Markdown link targets,
 * and fails when any of them does not exist in this repository.
 *
 * Offline and deterministic: no network, no package install.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const failures = [];
const checked = new Set();

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

const files = [join(root, 'README.md'), ...walk(join(root, 'docs')), ...walk(join(root, 'demo'))].filter(
  (file) => existsSync(file),
);

const scripts = existsSync(join(root, 'package.json'))
  ? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {}
  : {};

const CANDIDATES = [
  { pattern: /scripts\/[A-Za-z0-9._/-]+/g, kind: 'script' },
  { pattern: /\.github\/workflows\/[A-Za-z0-9._/-]+/g, kind: 'workflow' },
];

function trim(candidate) {
  return candidate.replace(/[.,;:)]+$/, '');
}

function checkPath(kind, target, file) {
  const clean = trim(target);
  if (clean === 'scripts/' || clean.endsWith('/')) return;
  checked.add(`${kind}:${clean}`);
  const repoRelative = existsSync(join(root, clean));
  const fileRelative = existsSync(resolve(dirname(file), clean));
  if (!repoRelative && !fileRelative) {
    failures.push(`${relative(root, file)}: missing ${kind} "${clean}"`);
  }
}

for (const file of files) {
  const text = readFileSync(file, 'utf8');

  for (const { pattern, kind } of CANDIDATES) {
    for (const match of text.matchAll(pattern)) checkPath(kind, match[0], file);
  }

  for (const match of text.matchAll(/npm run ([A-Za-z0-9:._-]+)/g)) {
    const name = trim(match[1]);
    checked.add(`npm:${name}`);
    if (scripts[name] === undefined) {
      failures.push(`${relative(root, file)}: npm script "${name}" is not in package.json`);
    }
  }

  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (
      target === '' ||
      target.startsWith('#') ||
      target.startsWith('http://') ||
      target.startsWith('https://') ||
      target.startsWith('mailto:') ||
      target.includes('<') ||
      target.includes('{{')
    ) {
      continue;
    }
    checkPath('link', target.split('#')[0], file);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`check-doc-references: ${failures.length} phantom reference(s)`);
  process.exit(1);
}
console.log(`check-doc-references: ok (${checked.size} references across ${files.length} files)`);
