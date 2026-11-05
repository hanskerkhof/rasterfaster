// Boundary rule: src/library must not import from src/app, and src/app must reach the library only through '@rasterfaster/library'.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';

const root = resolve(import.meta.dirname, '../src');
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);
const importRe = /(?:from|import)\s*\(?\s*'([^']+)'/g;
const problems = [];

for (const file of walk(join(root, 'library'))) {
  for (const [, spec] of readFileSync(file, 'utf8').matchAll(importRe)) {
    if (spec.startsWith('@rasterfaster/library')) problems.push(`${relative(root, file)}: imports its own barrel ('${spec}'), use a relative path`);
    if (spec.startsWith('.') && !resolve(dirname(file), spec).startsWith(join(root, 'library'))) problems.push(`${relative(root, file)}: '${spec}' reaches outside the library`);
  }
}
for (const file of walk(join(root, 'app'))) {
  for (const [, spec] of readFileSync(file, 'utf8').matchAll(importRe)) {
    if (spec.startsWith('.') && resolve(dirname(file), spec).startsWith(join(root, 'library'))) problems.push(`${relative(root, file)}: '${spec}' is a deep import, use '@rasterfaster/library'`);
    if (spec.startsWith('@rasterfaster/library/')) problems.push(`${relative(root, file)}: '${spec}' is a deep import, use '@rasterfaster/library'`);
  }
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('library boundaries ok');
