#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const myPiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sdkRoot = resolve(myPiRoot, '../pimote/packages/sdk');

if (!existsSync(resolve(sdkRoot, 'package.json'))) {
  console.error(`Pimote SDK checkout not found at ${sdkRoot}`);
  process.exitCode = 1;
} else {
  execFileSync('npm', ['run', 'build'], { cwd: sdkRoot, stdio: 'inherit' });
  execFileSync('npm', ['link'], { cwd: sdkRoot, stdio: 'inherit' });
  execFileSync('npm', ['link', '@pimote/sdk'], { cwd: myPiRoot, stdio: 'inherit' });
  console.log('my-pi now resolves @pimote/sdk from the local Pimote checkout.');
}
