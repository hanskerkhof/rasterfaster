#!/usr/bin/env node
// Usage: npm run bump:version -- 0.2.0   (then: update ../../CHANGELOG.md, ng build, commit)
import { execFileSync } from 'node:child_process';
import { syncVersionMetadata } from './version-metadata.mjs';

const next = process.argv[2];
if (!next || !/^\d+\.\d+\.\d+$/.test(next)) {
  console.error('Usage: npm run bump:version -- <X.Y.Z>');
  process.exit(1);
}
execFileSync('npm', ['version', next, '--no-git-tag-version'], { cwd: process.cwd(), stdio: 'inherit' });
syncVersionMetadata(process.cwd());
console.log(`Frontend version bumped to ${next}`);
