import { spawnSync } from 'child_process';
import { existsSync, statSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const SWIFT_SRC = join(ROOT, 'swift', 'EventKitBridge.swift');
const BIN_DIR   = join(ROOT, 'bin');
const BIN_PATH  = join(BIN_DIR, 'eventkit-bridge');

export function buildBridge() {
  if (existsSync(BIN_PATH)) {
    const binMtime = statSync(BIN_PATH).mtimeMs;
    const srcMtime = statSync(SWIFT_SRC).mtimeMs;
    if (binMtime > srcMtime) return; // up to date
  }

  const check = spawnSync('which', ['swiftc'], { encoding: 'utf8' });
  if (check.status !== 0) {
    throw new Error(
      'swiftc not found. Install Xcode Command Line Tools: xcode-select --install'
    );
  }

  mkdirSync(BIN_DIR, { recursive: true });

  process.stderr.write('[calendar-eventkit] Compiling EventKit bridge (first run only)...\n');
  const result = spawnSync(
    'swiftc',
    ['-framework', 'EventKit', '-framework', 'AppKit', '-o', BIN_PATH, SWIFT_SRC],
    { stdio: 'inherit' }
  );

  if (result.status !== 0) {
    throw new Error(`swiftc exited with code ${result.status}`);
  }
  process.stderr.write('[calendar-eventkit] Bridge compiled successfully.\n');
}
