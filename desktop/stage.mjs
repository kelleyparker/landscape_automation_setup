#!/usr/bin/env node
/**
 * Copies the web build into the Electron app folder.
 *
 * electron-builder's `files` globs cannot reach outside the app directory, so
 * the built game is staged into `desktop/game/` first. Runs before every start
 * and every packaging target, so the desktop shell can never quietly ship a
 * stale bundle - which would otherwise be invisible until someone reported a
 * bug that was fixed weeks earlier.
 */
import { cp, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dist');
const GAME = path.join(HERE, 'game');

try {
  await access(path.join(DIST, 'index.html'));
} catch {
  console.error(
    '\n  No web build found at ' + DIST +
    '\n  Run `npm run build` in the project root first.\n'
  );
  process.exit(1);
}

await rm(GAME, { recursive: true, force: true });
await cp(DIST, GAME, { recursive: true });
console.log('staged ' + path.relative(process.cwd(), DIST) + ' -> ' + path.relative(process.cwd(), GAME));
