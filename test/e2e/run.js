/* E2E-прогон: поднимает локальный сервер, собирает копию расширения под localhost,
 * запускает headless Firefox через web-ext, ждёт скачивания ZIP и гасит браузер.
 *
 * Запуск: node test/e2e/run.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { startServer } = require('./server');

const ROOT = path.join(__dirname, '..', '..');
const EXT = path.join(__dirname, 'ext');
const DOWNLOADS = path.join(__dirname, 'downloads');
const FIREFOX = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildExt() {
  fs.rmSync(EXT, { recursive: true, force: true });
  fs.mkdirSync(EXT, { recursive: true });
  const files = ['manifest.json', 'background.js', 'page-hook.js', 'common.js', 'extract.js', 'dom.js', 'content.js', 'README.md'];
  for (const f of files) fs.copyFileSync(path.join(ROOT, f), path.join(EXT, f));
  fs.copyFileSync(path.join(__dirname, 'autorun.js'), path.join(EXT, 'autorun.js'));

  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  const host = ['http://127.0.0.1/*', 'http://localhost/*'];
  manifest.host_permissions = host;
  manifest.content_scripts[0].matches = host;
  manifest.content_scripts[1].matches = host;
  manifest.content_scripts.push({ matches: host, js: ['autorun.js'], run_at: 'document_idle' });
  fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return EXT;
}

function findZip() {
  if (!fs.existsSync(DOWNLOADS)) return null;
  const zips = fs.readdirSync(DOWNLOADS).filter((f) => f.toLowerCase().endsWith('.zip'));
  if (!zips.length) return null;
  zips.sort();
  return path.join(DOWNLOADS, zips[zips.length - 1]);
}

(async () => {
  fs.rmSync(DOWNLOADS, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOADS, { recursive: true });

  const ext = buildExt();
  const server = await startServer();

  // отдельный профиль с настройками загрузок: надёжнее, чем --pref
  const profile = path.join(__dirname, 'profile');
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  const userJs = [
    'user_pref("browser.download.folderList", 2);',
    'user_pref("browser.download.dir", "' + DOWNLOADS.replace(/\\/g, '\\\\') + '");',
    'user_pref("browser.download.useDownloadDir", true);',
    'user_pref("browser.download.always_ask_before_handling_new_types", false);',
    'user_pref("browser.download.manager.showWhenStarting", false);',
    'user_pref("browser.helperApps.neverAsk.saveToDisk", "application/zip,application/x-zip-compressed");'
  ].join('\n');
  fs.writeFileSync(path.join(profile, 'user.js'), userJs);
  console.log('[e2e] сервер на http://127.0.0.1:8765/page.html');

  const args = [
    '--yes', 'web-ext@8', 'run',
    '--source-dir', ext,
    '--firefox', '"' + FIREFOX + '"',
    '--args=-headless',
    '--no-reload',
    '--start-url', 'http://127.0.0.1:8765/page.html',
    '--firefox-profile', profile,
    '--keep-profile-changes'
  ];

  const child = spawn('npx', args, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  let zip = null;
  for (let i = 0; i < 50; i++) {
    await sleep(1000);
    zip = findZip();
    if (zip) break;
  }

  try { execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) {}
  try { execSync('taskkill /IM firefox.exe /F', { stdio: 'ignore' }); } catch (e) {}
  server.close();

  if (!zip) {
    console.log('[e2e] FAIL: ZIP не появился');
    console.log(out.slice(-4000));
    process.exit(1);
  }
  console.log('[e2e] OK: ' + zip + ' (' + fs.statSync(zip).size + ' байт)');
  process.exit(0);
})();
