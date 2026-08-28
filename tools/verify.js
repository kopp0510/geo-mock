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
const EXPECTED_ASSERTIONS = 7;
const SHOTS = path.join(EXT_DIR, '.screenshots');
const MOVED = { lat: 35.6812, lng: 139.7671, accuracy: 55 };   // 東京車站 —— 刻意挑一組非預設值
// Google Maps 右鍵複製出來的原始格式，位數刻意留滿，確認不會被截斷
const PASTED = '24.262246621321527, 120.62450392661896';
const PASTED_LAT = '24.262246621321527';
const PASTED_LNG = '120.62450392661896';
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

// 純靜態檢查：兩件會靜默回退的政策設定 —— 「查詢跑在 service worker」，以及改寫
// User-Agent 的 DNR 規則。共同點是壞掉不會有症狀：搜尋照樣有結果，要到被 Nominatim
// 封鎖那天才會發現。
//
// 刻意只讀檔比對，不送任何請求：自動化打 Nominatim 正是政策明文禁止的
// （見 tools/CLAUDE.md「為什麼不驗地址搜尋」）。
// 這三支一律回傳 null 表示通過、回傳字串表示哪裡不對，所以能用 || 串起來。
function checkPolicySetup() {
  const mf = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
  return checkServiceWorker(mf) || checkUaRule(mf);
}

// 查詢一旦搬回 popup，「中途關掉 popup → 結果沒進快取 → 下次重送同一個 query」
// 那個洞就回來了，而且照樣有搜尋結果，測不出來。兩個癥狀各查一個。
function checkServiceWorker(mf) {
  const sw = mf.background?.service_worker;
  if (!sw) return 'manifest 沒有註冊 background.service_worker，查詢會退回 popup 裡跑';
  if (!fs.existsSync(path.join(EXT_DIR, sw))) return 'service worker 檔案不存在:' + sw;
  // 比對 script 標籤而不是整檔搜 'geocode.js'：這個專案註解密度很高，
  // 一句提到 geocode.js 的註解就會讓這項變紅，訊息還跟事實相反。
  if (/<script[^>]+src=["']geocode\.js["']/.test(
    fs.readFileSync(path.join(EXT_DIR, 'popup.html'), 'utf8'))) {
    return 'popup.html 直接載入了 geocode.js —— 查詢應該走 service worker';
  }

  // fetch 逾時與 service worker 的壽命是耦合的：Chrome 會終止「fetch 超過 30 秒
  // 還沒回應」的 SW。gate() 的時間戳在 fetch 之前就落地，被砍在中間的話結果
  // 到不了 cachePut —— 下次查同字串重送一次，跟這個 SW 本來要修的洞一模一樣。
  const timeout = fs.readFileSync(path.join(EXT_DIR, 'geocode.js'), 'utf8')
    .match(/const TIMEOUT_MS = (\d+)/);
  if (!timeout) return 'geocode.js 找不到 TIMEOUT_MS，無法確認它短於 SW 的 30 秒上限';
  if (Number(timeout[1]) >= 30000) {
    return `geocode.js 的 TIMEOUT_MS=${timeout[1]} 不得 ≥30000 —— `
      + 'Chrome 會在 fetch 超過 30 秒時終止 service worker';
  }

  return null;
}

// 這條規則是 Nominatim 唯一認得出這個應用的線索（政策硬要求，見 SPEC.md）：
// 規則檔被刪、enabled 被改 false、權限被拿掉、urlFilter 被放寬到整個
// openstreetmap.org、或 UA 的版本號跟 manifest 脫鉤，任何一項都會讓識別失效。
function checkUaRule(mf) {
  if (!(mf.permissions ?? []).some(p => p.startsWith('declarativeNetRequest'))) {
    return 'manifest 少了 declarativeNetRequest 系列權限，規則不會生效';
  }

  const enabled = (mf.declarative_net_request?.rule_resources ?? []).filter(r => r.enabled);
  if (enabled.length !== 1) {
    return `manifest 的 rule_resources 應該剛好一筆 enabled，實際 ${enabled.length} 筆`;
  }

  const rulePath = path.join(EXT_DIR, enabled[0].path);
  if (!fs.existsSync(rulePath)) return '規則檔不存在:' + enabled[0].path;
  const rules = JSON.parse(fs.readFileSync(rulePath, 'utf8'));

  const ua = rules
    .flatMap(r => r.action?.requestHeaders ?? [])
    .find(h => h.header.toLowerCase() === 'user-agent');
  if (!ua) return '規則檔裡沒有改寫 user-agent 的項目';
  if (ua.operation !== 'set') return 'user-agent 的 operation 應該是 set，實際 ' + ua.operation;
  // 版本號是手抄進 rules.json 的，靜態規則讀不到 manifest。這行就是那道同步閘門：
  // 升版只改 manifest 的話，這裡會紅，提醒你 rules.json 也要動。
  if (!ua.value.includes(mf.version)) {
    return `UA「${ua.value}」沒帶上 manifest 的版本 ${mf.version} —— 升版時兩邊要一起改`;
  }

  // 範圍不能放寬：規則若涵蓋整個 openstreetmap.org，使用者自己瀏覽 OSM 時
  // 送出的請求也會被冠上 geo-mock 的名字，被限流的是我們（見 SPEC.md）。
  const tooWide = rules
    .map(r => r.condition?.urlFilter ?? '')
    .filter(f => !f.includes('nominatim.openstreetmap.org'));
  if (tooWide.length) return '規則的 urlFilter 超出 nominatim:' + tooWide.join(', ');

  return null;
}

// 造一個「只有 inject.js、沒有 bridge.js」的擴充變體，用來複現
// 「設定永遠送不到」這個失敗模式（bridge 的 storage 讀取出錯、或擴充在
// 頁面載入途中被 reload）。修好之前，這個情境會讓呼叫端永久懸掛。
function makeNoBridgeVariant() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-mock-nobridge-'));
  const mf = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));

  // 白名單，不是「複製整份再刪掉不要的」。變體目錄只放 inject.js，
  // 任何指向其他檔案的欄位（icons、options_ui、action.default_popup）
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
    // ── 靜態檢查：不開瀏覽器、不送請求 ──────────────────────
    const setupProblem = checkPolicySetup();
    console.log('政策相關設定        : ' + (setupProblem || '完整'));
    results.push(['Nominatim 政策相關設定沒有壞掉（靜態）', setupProblem === null]);

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

      // 3a) 貼上欄：Google Maps 的「緯度, 經度」一整串要能拆進兩個數字欄
      await ext.fill('#paste', PASTED);
      const split = await ext.evaluate(() => ({
        lat: document.getElementById('lat').value,
        lng: document.getElementById('lng').value,
      }));
      console.log('貼上座標拆解後      : ' + JSON.stringify(split));
      results.push(['貼上「緯度, 經度」會拆進兩欄',
        split.lat === PASTED_LAT && split.lng === PASTED_LNG]);

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

      // 5) Popup 開關關掉 → 不再覆寫。前四項全在測「開啟」狀態，
      //    enabled: false 這條路徑到這裡才第一次被驗到。
      await ext.goto(`chrome-extension://${extId}/popup.html`);
      // 開關的 CSS transition 是 .15s。不等它跑完就截圖，拍到的是過渡中間狀態 ——
      // 開關看起來還在關閉位，但實際上 checked 已經是 true，截圖會誤導讀的人。
      const SETTLE = 250;
      await ext.waitForTimeout(SETTLE);
      await ext.screenshot({ path: path.join(SHOTS, 'popup-on.png') });

      await ext.uncheck('#enabled');
      // 比對文字而非 class：popup.js 的 fail() 也會把 class 設成 'state off'，
      // 只看 class 的話「存檔成功」與「存檔失敗」都會讓這個等待通過。
      await ext.waitForFunction(
        () => document.getElementById('state').textContent === '未覆寫，走真實定位');
      await ext.waitForTimeout(SETTLE);
      await ext.screenshot({ path: path.join(SHOTS, 'popup-off.png') });

      // inject.js 只在「真的覆寫了」時印這行，而 announced 每次頁面載入都重置，
      // 所以 reload 後這行的有無是乾淨訊號。比對座標數值會漏掉一種迴歸：
      // 停用分支誤送 GEO_MOCK_DEFAULTS（enabled:true、台北 101）——
      // 那時 overridden 是 true 但座標不是 MOVED，只比 MOVED 會綠燈放行。
      const logs = [];
      page.on('console', m => logs.push(m.text()));
      await page.goto(url);
      const off = await page.evaluate(() => new Promise(res => {
        navigator.geolocation.getCurrentPosition(
          p => res({ overridden: true, lat: p.coords.latitude, lng: p.coords.longitude }),
          e => res({ overridden: false, code: e.code }),
          { timeout: 3000 }
        );
      }));
      console.log('關掉開關後          : ' + JSON.stringify(off));
      // 斷言「拿不到我們設的座標」而不是「一定要 error」——
      // 真實定位在別的環境可能真的成功，那不算失敗。
      // 注意：這一項把 storage 的 enabled 留在 false，profile 也還在用。
      // 之後要在 browser a 這個區塊裡加測試，記得它跑在「已停用」的狀態下。
      const overrodeAnything = logs.some(t => t.includes('定位已覆寫為'));
      results.push(['關掉開關後不再覆寫',
        !overrodeAnything && !(off.overridden && sameCoords(off, MOVED))]);
    } finally {
      await cleanup(a);
    }

    // ── 失敗情境：設定永遠送不到，排隊必須有出口 ──────────────
    noBridgeDir = makeNoBridgeVariant();
    const b = await launch(chromium, executablePath, noBridgeDir);
    try {
      // 先確認變體真的載入。變體 manifest 若指向目錄裡不存在的檔案（options.html、
      // popup.html），Chrome 會整個拒絕載入 —— 那樣 inject.js 根本沒注入，
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
  let allOk = results.length === EXPECTED_ASSERTIONS;
  for (const [name, ok] of results) {
    console.log((ok ? '✓ PASS' : '✗ FAIL') + '  ' + name);
    if (!ok) allOk = false;
  }
  if (results.length < EXPECTED_ASSERTIONS) console.log('✗ 有測試未跑完（見上方例外）');
  process.exit(allOk ? 0 : 1);
})();
