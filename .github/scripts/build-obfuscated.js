#!/usr/bin/env node
// Builds the root index.html (minified+mangled) from src/index.html.
//
// - Reads src/index.html.
// - Finds every inline <script>...</script> block that does NOT have a
//   src= attribute (CDN <script src="..."> tags are left completely
//   untouched).
// - Runs each inline script's contents through terser with a conservative,
//   semantics-preserving config (mangle names, no unsafe compress options,
//   keep console.* calls, strip comments).
// - Reassembles the HTML with the minified script contents in place and
//   writes it to the repo root index.html, prefixed with an auto-generated
//   header comment.
// - Exits non-zero (and never writes a partial/corrupt file) if any script
//   block fails to minify.

const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

const SRC_PATH = path.join(__dirname, '..', '..', 'src', 'index.html');
const OUT_PATH = path.join(__dirname, '..', '..', 'index.html');

const HEADER_COMMENT = `<!--
  AUTO-GENERATED FILE — DO NOT EDIT DIRECTLY.
  This is a minified/mangled build of src/index.html, produced by
  .github/workflows/build-obfuscated.yml on every push to src/index.html.
  Edit src/index.html instead — this file will be regenerated automatically.
-->
`;

// Matches an opening <script ...> tag without a src= attribute, its body,
// and the closing </script> tag. Mirrors the repo's own validation regex
// (see CLAUDE.md) but captures the opening tag separately so we can keep
// its attributes exactly as they were.
const SCRIPT_BLOCK_RE = /<script((?:(?!src=)[^>])*)>([\s\S]*?)<\/script>/gi;

async function main() {
  const html = fs.readFileSync(SRC_PATH, 'utf8');

  const matches = [...html.matchAll(SCRIPT_BLOCK_RE)];

  let result = '';
  let lastIndex = 0;
  let blockIndex = 0;
  const failures = [];

  for (const match of matches) {
    const [fullMatch, openAttrs, scriptCode] = match;
    const matchStart = match.index;

    // Append everything between the previous match and this one, untouched.
    result += html.slice(lastIndex, matchStart);

    const openTag = `<script${openAttrs}>`;
    const approxLine = html.slice(0, matchStart).split('\n').length;

    if (!scriptCode.trim()) {
      // Empty inline script block — nothing to minify, keep as-is.
      result += fullMatch;
      lastIndex = matchStart + fullMatch.length;
      blockIndex++;
      continue;
    }

    try {
      const minified = await minify(scriptCode, {
        mangle: true,
        compress: {
          unsafe: false,
          drop_console: false,
        },
        format: { comments: false },
      });
      if (minified.error) throw minified.error;
      if (typeof minified.code !== 'string') {
        throw new Error('terser produced no output code');
      }
      result += openTag + minified.code + '</script>';
    } catch (err) {
      failures.push({ blockIndex, approxLine, message: err && err.message ? err.message : String(err) });
      // Keep placeholder so we don't lose position tracking; we'll bail
      // out before writing anything anyway once failures.length > 0.
      result += fullMatch;
    }

    lastIndex = matchStart + fullMatch.length;
    blockIndex++;
  }

  result += html.slice(lastIndex);

  if (failures.length > 0) {
    console.error(`Build failed: ${failures.length} script block(s) failed to minify:`);
    for (const f of failures) {
      console.error(`  - script block #${f.blockIndex} (approx. line ${f.approxLine}): ${f.message}`);
    }
    process.exit(1);
  }

  const finalHtml = result.replace(/^<!DOCTYPE html>/i, (m) => `${m}\n${HEADER_COMMENT}`);

  fs.writeFileSync(OUT_PATH, finalHtml, 'utf8');
  console.log(`Wrote ${OUT_PATH} (${finalHtml.length} bytes) from ${SRC_PATH} (${html.length} bytes), ${matches.length} inline script block(s) processed.`);
}

main().catch((err) => {
  console.error('Build script crashed:', err);
  process.exit(1);
});
