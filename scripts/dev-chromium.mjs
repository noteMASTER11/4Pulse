import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';

const root = process.cwd();
const extensionPath = path.join(root, 'dist', 'chrome');
const profilePath = path.join(root, '.dev', 'chromium-profile');
const target = process.argv[2] || 'popup';

const pages = {
  popup: 'html/popup.html',
  sidebar: 'html/sidebar.html',
  options: 'html/options.html',
};

function findChromium() {
  const configured = process.env.CHROMIUM_PATH;
  const bundled = chromium.executablePath();
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.PROGRAMFILES || '';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] || '';
  const candidates = [
    configured,
    bundled,
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(localAppData, 'Chromium', 'Application', 'chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  return candidates.find(candidate => fs.existsSync(candidate));
}

if (target !== 'all' && !(target in pages)) {
  throw new Error(`Unknown preview target: ${target}. Use popup, sidebar, options or all.`);
}

const executablePath = findChromium();
if (!executablePath) {
  throw new Error('Playwright Chromium not found. Run npm run setup:browser or set CHROMIUM_PATH.');
}

execFileSync(process.execPath, ['scripts/build.mjs', 'chrome'], {
  cwd: root,
  stdio: 'inherit',
});

fs.mkdirSync(profilePath, { recursive: true });

const context = await chromium.launchPersistentContext(profilePath, {
  executablePath,
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

let serviceWorker = context.serviceWorkers()[0];
if (!serviceWorker) {
  serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
}

const extensionId = new URL(serviceWorker.url()).host;
const targets = target === 'all' ? Object.keys(pages) : [target];

for (const name of targets) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${pages[name]}?dev-preview=1`);
  console.log(`Opened ${name}: ${page.url()}`);
}

console.log(`4Pulse dev profile: ${profilePath}`);
console.log('Close the browser or press Ctrl+C to stop.');

if (process.env.DEV_PREVIEW_SMOKE === '1') {
  await new Promise(resolve => setTimeout(resolve, 1000));
  await context.close();
  process.exit(0);
}

const close = async () => {
  await context.close().catch(() => {});
};

process.once('SIGINT', close);
process.once('SIGTERM', close);
await new Promise(resolve => context.once('close', resolve));
