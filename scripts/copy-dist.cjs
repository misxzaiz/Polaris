/**
 * Copy the frontend dist/ directory into src-tauri/dist-web/ for MSI bundling.
 *
 * Tauri's bundle.resources only accepts paths relative to src-tauri/.
 * The ../dist path is unreliable with MSI/WiX, so we copy dist/ into
 * src-tauri/dist-web/ before the Rust build step.
 *
 * This script is called by beforeBuildCommand in tauri.conf.json.
 */

const fs = require('fs');
const path = require('path');

const src = path.resolve(__dirname, '..', 'dist');
const dest = path.resolve(__dirname, '..', 'src-tauri', 'dist-web');

if (!fs.existsSync(src)) {
  console.error('[copy-dist] Error: dist/ directory not found. Run vite build first.');
  process.exit(1);
}

fs.cpSync(src, dest, { recursive: true, force: true });

// Verify the copy succeeded
if (!fs.existsSync(path.join(dest, 'index.html'))) {
  console.error('[copy-dist] Error: index.html missing after copy. dist/ may be incomplete.');
  process.exit(1);
}

console.log('[copy-dist] Copied dist/ -> src-tauri/dist-web/');
