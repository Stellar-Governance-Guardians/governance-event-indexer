import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pin = JSON.parse(readFileSync(join(root, 'parser.lock'), 'utf8'));
const archive = join(root, 'vendor', `sgg-parser-wasm-${pin.version}.tgz`);
const actual = createHash('sha256').update(readFileSync(archive)).digest('hex');
if (actual !== pin.sha256) {
  throw new Error(`parser WASM sha256 mismatch: expected ${pin.sha256}, got ${actual}`);
}

mkdirSync(join(root, '.tmp'), { recursive: true });
const temp = mkdtempSync(join(root, '.tmp', 'parser-wasm-'));
const extracted = join(temp, `sgg-parser-wasm-${pin.version}`, 'nodejs');
const output = join(root, 'generated', 'parser', 'nodejs');
try {
  execFileSync('tar', ['-xzf', archive, '-C', temp], { stdio: 'inherit' });
  mkdirSync(output, { recursive: true });
  for (const file of ['package.json', 'sgp_parser_wasm.js', 'sgp_parser_wasm_bg.wasm', 'sgp_parser_wasm.d.ts']) {
    cpSync(join(extracted, file), join(output, file));
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
