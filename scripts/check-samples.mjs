#!/usr/bin/env node
// Build-time check: every piano sample referenced by lib/piano-samples.ts must
// exist on disk under public/piano/ (we self-host, so "the URL resolves" means
// the static file is present and non-trivial). Run before shipping:
//
//   node scripts/check-samples.mjs   (also: npm run check:samples)
//
// Exits non-zero if any sample is missing or suspiciously small, so a dropped
// file can never silently degrade the demo to the oscillator fallback.

import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestSrc = readFileSync(join(root, "lib/piano-samples.ts"), "utf8");

// Pull the sample stems out of the SAMPLE_NAMES array in the manifest so this
// check always tracks the real source of truth.
const block = manifestSrc.match(/SAMPLE_NAMES\s*=\s*\[([\s\S]*?)\]/);
if (!block) {
  console.error("check-samples: could not find SAMPLE_NAMES in lib/piano-samples.ts");
  process.exit(1);
}
const names = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
if (names.length === 0) {
  console.error("check-samples: SAMPLE_NAMES is empty");
  process.exit(1);
}

const MIN_BYTES = 2048; // real recordings are tens of KB; smaller == error page
let bad = 0;
for (const name of names) {
  const file = join(root, "public/piano", `${name}.mp3`);
  try {
    const { size } = statSync(file);
    if (size < MIN_BYTES) {
      console.error(`MISSING/EMPTY  ${name}.mp3  (${size} bytes)`);
      bad++;
    }
  } catch {
    console.error(`MISSING        ${name}.mp3`);
    bad++;
  }
}

if (bad > 0) {
  console.error(`\ncheck-samples: ${bad}/${names.length} sample(s) failed.`);
  process.exit(1);
}
console.log(`check-samples: all ${names.length} piano samples present under public/piano/.`);
