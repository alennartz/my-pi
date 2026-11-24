#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const myPiRoot = resolve(import.meta.dirname, '..');
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
