// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Usage: node tests/visual-exact/run.mjs <outDir> <ruleset> <time,time,...> [mods] [WxH] [settingsJSON] [map file in maps/]
// Expects a dev server at http://localhost:5324 (npx vite --port 5324 --strictPort).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require('/opt/node-tools/node_modules/playwright');
}
const [outDir = '.', ruleset = '1', timesArg = '', mods = '', size = '1366x768', settings = '{}', map = ''] = process.argv.slice(2);
const [w, h] = size.split('x').map(Number);
const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { width: w, height: h } });
page.on('console', m => m.type() === 'error' && console.log('console:', m.text()));
page.on('pageerror', e => console.log('pageerror:', e.message));
const q = new URLSearchParams({
  ruleset,
  mods,
  w: String(w),
  h: String(h),
  settings,
  ...(map ? { map } : {}),
});
await page.goto(`http://localhost:5324/tests/visual-exact/harness.html?${q}`);
await page.waitForSelector('body[data-ready]', { timeout: 30000 });
const objectTimes = await page.evaluate(() => window.harness.objectTimes);
console.log('objects', objectTimes.length, 'first', objectTimes[0]?.start, 'last', objectTimes.at(-1)?.end);
const times = timesArg ? timesArg.split(',').map(Number) : [objectTimes[0].start + 1000];
for (const t of times) {
  await page.evaluate(t => window.harness.renderAt(t), t);
  const file = `${outDir}/r${ruleset}${mods ? '-' + mods : ''}-${w}x${h}-${t}.png`;
  await page.screenshot({ path: file });
  console.log(file);
}
await browser.close();
