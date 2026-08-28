#!/usr/bin/env node
// geo-mock 驗證腳本 —— 開真實瀏覽器載入未封裝擴充，斷言定位覆寫確實生效。
//
// 跑法：  node tools/verify.js
// 需要：  playwright（刻意不列為專案相依，見 resolvePlaywright）
//        Chrome for Testing（Chrome stable 自 151 起忽略 --load-extension）
//
// 可用環境變數覆寫：
//   CHROME_BIN      Chrome for Testing 執行檔路徑
//   PLAYWRIGHT_DIR  含 playwright 的 node_modules 目錄
//   PORT            測試頁的本機埠（預設 0，讓 OS 自己配）

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EXT_DIR = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const PORT = Number(process.env.PORT) || 0;
const SHOTS = path.join(EXT_DIR, '.screenshots');
const MOVED = { lat: 35.6812, lng: 139.7671, accuracy: 55 };   // 東京車站 —— 刻意挑一組非預設值
const EXPECT = require(path.join(EXT_DIR, 'defaults.js'));   // 與擴充共用同一份預設值

function fail(msg) {
  console.error('\n✗ ' + msg + '\n');
  process.exit(1);
}

// 三項座標斷言共用。got 可能是 undefined（陷阱 1 那項讀的是頁面上的 window.__early，
// 沒排隊成功時就沒有這個值），所以先擋掉再比。
function sameCoords(got, want) {
  return !!got
    && Math.abs(got.lat - want.lat) < 1e-6
    && Math.abs(got.lng - want.lng) < 1e-6;
}

// playwright 刻意不列為專案相依（SPEC：不引入 build 工具）。
// 依序找：環境變數 → 一般解析 → npx 快取。
function resolvePlaywright() {
  if (process.env.PLAYWRIGHT_DIR) {
    try { return require(path.join(process.env.PLAYWRIGHT_DIR, 'playwright')); }
    catch { /* 指定的路徑不對就往下找 */ }
  }
  try { return require('playwright'); } catch { /* 繼續找 */ }
  try {
    const npx = path.join(os.homedir(), '.npm', '_npx');
    for (const h of fs.readdirSync(npx)) {
      const p = path.join(npx, h, 'node_modules', 'playwright');
      if (fs.existsSync(p)) return require(p);
    }
  } catch { /* 找不到就往下報錯 */ }
  fail('找不到 playwright。設 PLAYWRIGHT_DIR，或先跑一次 npx playwright --version 讓它進快取。');
}

// Chrome stable（151 實測）已忽略 --load-extension，--disable-features 逃生口也失效，
// 因此一律用 Chrome for Testing。playwright 下載的 chromium 就是這個建置。
function resolveChrome() {
  if (process.env.CHROME_BIN) {
    if (!fs.existsSync(process.env.CHROME_BIN)) {
      fail('CHROME_BIN 指向的檔案不存在:' + process.env.CHROME_BIN);
    }
    return process.env.CHROME_BIN;
  }
  const cache = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
    : path.join(os.homedir(), '.cache', 'ms-playwright');

  let builds = [];
  try {
    builds = fs.readdirSync(cache)
      .filter(d => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));   // 版本號大的優先
  } catch { /* 沒有這個目錄就是沒裝，下面統一報錯 */ }

  const app = ['Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'];
  for (const b of builds) {
    for (const c of [
      path.join(cache, b, 'chrome-mac-arm64', ...app),
      path.join(cache, b, 'chrome-mac', ...app),
      path.join(cache, b, 'chrome-linux', 'chrome'),
      path.join(cache, b, 'chrome-win', 'chrome.exe'),
    ]) {
      if (fs.existsSync(c)) return c;
    }
  }
  fail('找不到 Chrome for Testing（找過 ' + cache + '）。\n' +
       '  設 CHROME_BIN 指向它，或跑 npx playwright install chromium 下載。\n' +
       '  （不能用系統的 Chrome stable：自 151 起已忽略 --load-extension）');
}

function startServer() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript' };
  const server = http.createServer((req, res) => {
    const name = path.basename(new URL(req.url, 'http://x').pathname) || 'test.html';
    const file = path.join(FIXTURES, name);
    if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    // 沒有這個 handler 的話，埠被占用時噴的是 node:net 的內部堆疊，
    // 而不是本檔其他地方那種說得清楚的訊息。
    server.on('error', e => reject(new Error('測試用 http server 起不來:' + e.message)));
    server.listen(PORT, () => resolve(server));
  });
}

// 造一個「只有 inject.js、沒有 bridge.js」的擴充變體，用來複現
// 「設定永遠送不到」這個失敗模式（bridge 的 storage 讀取出錯、或擴充在
// 頁面載入途中被 reload）。修好之前，這個情境會讓呼叫端永久懸掛。
function makeNoBridgeVariant() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-mock-nobridge-'));
  const mf = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));

  // 白名單，不是「複製整份再刪掉不要的」。變體目錄只放 inject.js，
  // 任何指向其他檔案的欄位（icons、options_ui、之後的 action.default_popup）
  // 都會讓 Chrome 在載入時彈「無法載入擴充功能」的錯誤視窗。
  // 黑名單寫法每次 manifest 加新欄位都會再犯一次，所以這裡只列出變體真正需要的。
  const variant = {
    manifest_version: mf.manifest_version,
    name: mf.name + ' (no bridge)',
    version: mf.version,
    minimum_chrome_version: mf.minimum_chrome_version,
    content_scripts: mf.content_scripts.filter(cs => cs.js.includes('inject.js')),
  };

  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(variant, null, 2));
  fs.copyFileSync(path.join(EXT_DIR, 'inject.js'), path.join(dir, 'inject.js'));
  return dir;
}

// 讀 chrome://extensions 上已載入的擴充 id。
// 這個擴充沒有 service worker，shadow DOM 是拿 id 最現成的路徑；
// 回傳空陣列 = 擴充根本沒載入（manifest 指向不存在的檔案時，Chrome 會整個拒絕載入
// 並彈錯誤視窗，但自動化流程裡看不到那個視窗，只會表現成 content script 沒生效）。
async function loadedExtensionIds(page) {
  await page.goto('chrome://extensions');
  return page.evaluate(() => {
    const mgr = document.querySelector('extensions-manager');
    const list = mgr && mgr.shadowRoot && mgr.shadowRoot.querySelector('extensions-item-list');
    const items = list && list.shadowRoot
      ? list.shadowRoot.querySelectorAll('extensions-item') : [];
    return Array.from(items).map(i => i.id);
  });
}

async function launch(chromium, executablePath, extDir) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-mock-profile-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: false,          // MV3 擴充在舊 headless 下不載入
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  return { ctx, profile };
}

async function cleanup({ ctx, profile }) {
  // 瀏覽器崩潰時 ctx.close() 會拋，不能讓它擋住後面的清理，
  // 否則程序不退出、/tmp 還留下一堆 profile 目錄。
  try { await ctx.close(); } catch { /* 已經關了或崩了 */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 同上 */ }
}

(async () => {
  const { chromium } = resolvePlaywright();
  const executablePath = resolveChrome();
  console.log('擴充目錄 : ' + EXT_DIR);
  console.log('瀏覽器   : ' + executablePath + '\n');

  const server = await startServer();
  const url = `http://localhost:${server.address().port}/test.html`;
  const results = [];
  let noBridgeDir = '';

  try {
    // ── 正常情境：擴充完整載入 ──────────────────────────────
    const a = await launch(chromium, executablePath, EXT_DIR);
    try {
      const page = await a.ctx.newPage();
      await page.goto(url);

      // 1) 頁面載入後才要定位，此時設定早已送達
      const pos = await page.evaluate(() => new Promise((res, rej) => {
        navigator.geolocation.getCurrentPosition(
          p => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
          e => rej(new Error('geolocation error code=' + e.code + ' ' + e.message)),
          { timeout: 5000 }
        );
      }));
      console.log('載入後呼叫          : ' + JSON.stringify(pos));
      results.push(['定位覆寫生效', sameCoords(pos, EXPECT)]);

      // 2) 陷阱 1：頁面在設定送達前搶先呼叫，必須被排隊後補回
      const early = await page.evaluate(() => ({ pos: window.__early, err: window.__earlyErr }));
      console.log('document_start 搶先 : ' + JSON.stringify(early));
      results.push(['設定未達時的請求排隊（陷阱 1）', sameCoords(early.pos, EXPECT)]);

      // 3) Options 頁：改存一組非預設座標，content script 必須讀到新值
      const ext = await a.ctx.newPage();
      const ids = await loadedExtensionIds(ext);
      if (!ids.length) {
        throw new Error('讀不到 extension id —— 可能是擴充沒載入，'
          + '也可能是 Chrome 改了 chrome://extensions 的 shadow DOM 結構');
      }
      const extId = ids[0];

      await ext.goto(`chrome-extension://${extId}/options.html`);
      await ext.fill('#lat', String(MOVED.lat));
      await ext.fill('#lng', String(MOVED.lng));
      await ext.fill('#accuracy', String(MOVED.accuracy));
      await ext.click('button[type=submit]');
      await ext.waitForFunction(() => document.getElementById('status').className === 'ok');
      fs.mkdirSync(SHOTS, { recursive: true });
      await ext.screenshot({ path: path.join(SHOTS, 'options.png') });

      await page.goto(url);
      const after = await page.evaluate(() => new Promise((res, rej) => {
        navigator.geolocation.getCurrentPosition(
          p => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
          e => rej(new Error('geolocation error code=' + e.code)),
          { timeout: 5000 }
        );
      }));
      console.log('Options 存檔後      : ' + JSON.stringify(after));
      // 連 accuracy 一起驗，否則它在某一環被吃掉（例如 set 只寫兩個 key）四項仍全綠
      results.push(['Options 頁存的座標會生效',
        sameCoords(after, MOVED) && after.acc === MOVED.accuracy]);
    } finally {
      await cleanup(a);
    }

    // ── 失敗情境：設定永遠送不到，排隊必須有出口 ──────────────
    noBridgeDir = makeNoBridgeVariant();
    const b = await launch(chromium, executablePath, noBridgeDir);
    try {
      // 先確認變體真的載入。變體 manifest 若指向目錄裡不存在的檔案（options.html、
      // 之後的 popup.html），Chrome 會整個拒絕載入 —— 那樣 inject.js 根本沒注入，
      // getCurrentPosition 走的是原生、照樣會回應，這一項就會「因為錯的理由」PASS。
      const probe = await b.ctx.newPage();
      const variantIds = await loadedExtensionIds(probe);
      await probe.close();
      if (!variantIds.length) {
        throw new Error('no-bridge 變體沒載入成功 —— 檢查 makeNoBridgeVariant 的白名單'
          + '是否漏了某個指向檔案的 manifest 欄位');
      }

      const page = await b.ctx.newPage();
      await page.goto(url);
      // 呼叫端帶 timeout: 1000。修好之前這裡兩個 callback 都不會被呼叫，
      // settled 會停在 false —— 也就是「loading 轉不停、console 一片乾淨」。
      const settled = await page.evaluate(() => new Promise(res => {
        const t0 = Date.now();
        let done = false;
        navigator.geolocation.getCurrentPosition(
          () => { done = true; res({ via: 'success', ms: Date.now() - t0 }); },
          e => { done = true; res({ via: 'error(code=' + e.code + ')', ms: Date.now() - t0 }); },
          { timeout: 1000 }
        );
        setTimeout(() => { if (!done) res(null); }, 8000);   // null = 永久懸掛
      }));
      console.log('無 bridge（設定不來）: ' + JSON.stringify(settled));
      results.push(['設定永不到達時仍會回應，不永久懸掛', settled !== null]);
    } finally {
      await cleanup(b);
    }
  } catch (e) {
    console.log('\n例外: ' + e.message);
  } finally {
    try { server.close(); } catch { /* 已關 */ }
    if (noBridgeDir) { try { fs.rmSync(noBridgeDir, { recursive: true, force: true }); } catch { /* 同上 */ } }
  }

  console.log('');
  let allOk = results.length === 4;
  for (const [name, ok] of results) {
    console.log((ok ? '✓ PASS' : '✗ FAIL') + '  ' + name);
    if (!ok) allOk = false;
  }
  if (results.length < 4) console.log('✗ 有測試未跑完（見上方例外）');
  process.exit(allOk ? 0 : 1);
})();
