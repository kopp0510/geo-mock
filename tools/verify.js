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
const EXPECTED_ASSERTIONS = 11;
const SHOTS = path.join(EXT_DIR, '.screenshots');
const MOVED = { lat: 35.6812, lng: 139.7671, accuracy: 55 };   // 東京車站 —— 刻意挑一組非預設值
const LIVE = { lat: 48.8584, lng: 2.2945, accuracy: 12 };      // 巴黎鐵塔 —— 驗即時推送用的第二組
const JITTER_RADIUS = 100;                                     // 公尺，驗 jitter 用
const JITTER_SAMPLES = 8;
const SECRET_PLACE = { label: '祕密地點', lat: 12.34, lng: 56.78 };   // 驗它不會外流
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
  return checkServiceWorker(mf) || checkUaRule(mf) || checkLocales(mf);
}

// 語系相關的靜態檢查。同樣是壞掉不會有症狀那一類：漏譯的 key 會 fallback 成
// 英文，畫面上看不出是漏了還是刻意不譯。
function checkLocales(mf) {
  const tables = require(path.join(EXT_DIR, 'i18n.js')).STRINGS;
  const langs = Object.keys(tables);
  if (langs.length < 2) return 'i18n.js 的字串表少於兩種語言';

  const [base, ...rest] = langs;
  for (const lang of rest) {
    const missing = Object.keys(tables[base]).filter(k => !(k in tables[lang]));
    const extra = Object.keys(tables[lang]).filter(k => !(k in tables[base]));
    if (missing.length || extra.length) {
      return `字串表 ${lang} 與 ${base} 的 key 對不上 —— `
        + `${lang} 缺: ${missing.join(', ') || '無'}；多: ${extra.join(', ') || '無'}`;
    }
  }

  // manifest 的 name 不能用 __MSG_...__：makeNoBridgeVariant 會把 name 抄進變體的
  // manifest，而變體目錄沒有 _locales，Chrome 會整個拒絕載入 —— 最後一項會用
  // 「變體沒載入」的理由失敗，跟真正的問題差了十萬八千里。
  if (String(mf.name).startsWith('__MSG_')) {
    return 'manifest 的 name 不能用 __MSG_ 佔位（no-bridge 變體會抄走它，見 tools/CLAUDE.md）';
  }
  if (mf.default_locale) {
    const dir = path.join(EXT_DIR, '_locales', mf.default_locale, 'messages.json');
    if (!fs.existsSync(dir)) {
      return `default_locale 是 ${mf.default_locale}，但 ${dir} 不存在 —— Chrome 會拒絕載入整個擴充`;
    }
  }
  return null;
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
    // 1) 靜態檢查：不開瀏覽器、不送請求
    const setupProblem = checkPolicySetup();
    console.log('靜態設定檢查        : ' + (setupProblem || '完整'));
    results.push(['政策設定與語系字串表都沒壞掉（靜態）', setupProblem === null]);

    // ── 正常情境：擴充完整載入 ──────────────────────────────
    const a = await launch(chromium, executablePath, EXT_DIR);
    try {
      const page = await a.ctx.newPage();
      await page.goto(url);

      // 2) 頁面載入後才要定位，此時設定早已送達
      const pos = await page.evaluate(() => new Promise((res, rej) => {
        navigator.geolocation.getCurrentPosition(
          p => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
          e => rej(new Error('geolocation error code=' + e.code + ' ' + e.message)),
          { timeout: 5000 }
        );
      }));
      console.log('載入後呼叫          : ' + JSON.stringify(pos));
      results.push(['定位覆寫生效', sameCoords(pos, EXPECT)]);

      // 3) 陷阱 1：頁面在設定送達前搶先呼叫，必須被排隊後補回
      const early = await page.evaluate(() => ({ pos: window.__early, err: window.__earlyErr }));
      console.log('document_start 搶先 : ' + JSON.stringify(early));
      results.push(['設定未達時的請求排隊（陷阱 1）', sameCoords(early.pos, EXPECT)]);

      // 4、5) Options 頁：貼上欄要能拆解，存檔後 content script 要讀到新值
      const ext = await a.ctx.newPage();
      const ids = await loadedExtensionIds(ext);
      if (!ids.length) {
        throw new Error('讀不到 extension id —— 可能是擴充沒載入，'
          + '也可能是 Chrome 改了 chrome://extensions 的 shadow DOM 結構');
      }
      const extId = ids[0];

      await ext.goto(`chrome-extension://${extId}/options.html`);

      await ext.waitForFunction(() => document.getElementById('lat').value !== '');

      // 4) 貼上欄：Google Maps 的「緯度, 經度」一整串要能拆進兩個數字欄
      await ext.fill('#paste', PASTED);
      const split = await ext.evaluate(() => ({
        lat: document.getElementById('lat').value,
        lng: document.getElementById('lng').value,
      }));
      console.log('貼上座標拆解後      : ' + JSON.stringify(split));
      results.push(['貼上「緯度, 經度」會拆進兩欄',
        split.lat === PASTED_LAT && split.lng === PASTED_LNG]);

      // 5) 存一組非預設座標，重新載入測試頁後要讀到新值
      await ext.fill('#lat', String(MOVED.lat));
      await ext.fill('#lng', String(MOVED.lng));
      await ext.fill('#accuracy', String(MOVED.accuracy));
      // 先把 status 清掉再送出。不清的話它早在上面貼上欄那步就已經是 'ok'，
      // 下面那個等待會立刻通過，根本沒等到 storage 真的寫完。
      await ext.evaluate(() => { document.getElementById('status').className = ''; });
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

      // 6) 即時推送：改完設定不重整分頁也要生效（SPEC 第二版第 6 項）
      //
      // 在測試頁種一個哨兵，最後連它一起斷言。這一項唯一在測的就是「沒有重整」，
      // 而那件事本來只靠註解拜託後人別加 page.goto —— 有人為了修 flake 加回去，
      // 這項會繼續綠燈同時完全停止測試它宣稱要測的東西。哨兵讓那個提醒變成檢查。
      const mark = await page.evaluate(() => {
        window.__noReload = Math.random();
        return window.__noReload;
      });

      await ext.goto(`chrome-extension://${extId}/options.html`);
      await ext.fill('#lat', String(LIVE.lat));
      await ext.fill('#lng', String(LIVE.lng));
      await ext.fill('#accuracy', String(LIVE.accuracy));
      await ext.click('button[type=submit]');
      await ext.waitForFunction(() => document.getElementById('status').className === 'ok');

      // 刻意不 page.goto —— 測試頁維持上一次載入的狀態。重整過就測不到
      // 「不重整也生效」這件事了，那正是這一項唯一在測的東西。
      const pushed = await page.evaluate(async (want) => {
        const ASK_TIMEOUT_MS = 3000;    // 單次 getCurrentPosition 的上限
        const DEADLINE_MS = 3000;       // 整段輪詢的上限（與上面同值但意義不同，別合併）
        const POLL_MS = 50;
        const ask = () => new Promise(res => navigator.geolocation.getCurrentPosition(
          p => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
          () => res(null),
          { timeout: ASK_TIMEOUT_MS }
        ));
        // 推送是非同步的（storage.onChanged → bridge → CustomEvent → inject），
        // 輪詢到拿到新值為止，逾時就把最後一次的結果交出去讓斷言判定。
        const t0 = Date.now();
        let last = null;
        // deadline 檢查放在迴圈開頭：放在 ask() 之後的話，最後一次 ask 還能再花
        // ASK_TIMEOUT_MS，實際上限會變成兩者相加。
        while (Date.now() - t0 <= DEADLINE_MS) {
          last = await ask();
          if (last && Math.abs(last.lat - want.lat) < 1e-6) return { ...last, ms: Date.now() - t0 };
          await new Promise(r => setTimeout(r, POLL_MS));
        }
        return last;   // 逾時就把最後一次的結果交出去讓斷言判定
      }, LIVE);
      const survived = await page.evaluate(() => window.__noReload);
      console.log('改設定後（未重整）  : ' + JSON.stringify(pushed)
        + (survived === mark ? '' : '  ← 分頁被重整過，這項已失去意義'));
      results.push(['改設定不重整分頁也生效',
        survived === mark && sameCoords(pushed, LIVE) && pushed.acc === LIVE.accuracy]);

      // 7) jitter 模式：以設定的座標為中心抖動（SPEC 第二版第 7 項）
      await ext.goto(`chrome-extension://${extId}/options.html`);
      // 等 options.js 那個非同步 get 把欄位回填完再動手。搶在它前面填的話，
      // 回填會把值蓋回舊的 —— 第 5、6 項撞到這個會紅燈（座標對不上），
      // 但這一項只會**靜默變弱**：半徑被蓋回 50，斷言仍在驗 max <= 100，恆真。
      await ext.waitForFunction(() => document.getElementById('jitterRadius').value !== '');
      await ext.fill('#jitterRadius', String(JITTER_RADIUS));
      await ext.evaluate(() => { document.getElementById('status').className = ''; });
      await ext.click('button[type=submit]');
      await ext.waitForFunction(() => document.getElementById('status').className === 'ok');
      await ext.goto(`chrome-extension://${extId}/popup.html`);
      await ext.waitForFunction(() => !document.getElementById('modeJitter').disabled);
      await ext.check('#modeJitter');

      // 一樣不重整測試頁 —— 模式切換也要靠即時推送過去
      const jitter = await page.evaluate(async ({ center, n }) => {
        const ASK_TIMEOUT_MS = 3000;    // 單次 getCurrentPosition 的上限
        const DEADLINE_MS = 3000;       // 等模式推送到達的上限（與上面同值但意義不同，別合併）
        const POLL_MS = 50;
        const ask = () => new Promise(res => navigator.geolocation.getCurrentPosition(
          p => res({ lat: p.coords.latitude, lng: p.coords.longitude }),
          () => res(null),
          { timeout: ASK_TIMEOUT_MS }
        ));
        // 小範圍用平面近似算距離就夠，差幾公分不影響這個斷言
        const metersFrom = (p) => {
          const METERS_PER_DEGREE = 111320;
          const dy = (p.lat - center.lat) * METERS_PER_DEGREE;
          const dx = (p.lng - center.lng) * METERS_PER_DEGREE * Math.cos((center.lat * Math.PI) / 180);
          return Math.hypot(dx, dy);
        };

        // 等模式推送到達：抖起來之後座標就不再正好等於中心點
        const t0 = Date.now();
        let on = false;
        while (!on && Date.now() - t0 < DEADLINE_MS) {
          const p = await ask();
          if (p && metersFrom(p) > 0) on = true;
          else await new Promise(r => setTimeout(r, POLL_MS));
        }

        const samples = [];
        for (let i = 0; i < n; i++) samples.push(await ask());
        if (samples.some(p => !p)) return { on, failed: true };
        return {
          on,
          max: Math.max(...samples.map(metersFrom)),
          distinct: new Set(samples.map(p => `${p.lat},${p.lng}`)).size,
        };
      }, { center: LIVE, n: JITTER_SAMPLES });
      console.log('jitter 取樣            : ' + JSON.stringify(jitter));
      // 四件事一起驗：真的抖了、沒抖出半徑、抖得夠開、每次都不一樣。
      //   ·「每次不一樣」少了的話，「只在切換模式時抖一次然後固定住」會綠燈
      //   ·「抖得夠開」（下界）少了的話，半徑被誤設成更小的值也會綠燈 ——
      //     8 個圓盤均勻樣本全落在半徑一半內的機率是 0.25^8 ≈ 1.5e-5，不會 flake
      results.push(['jitter 以設定座標為中心抖動',
        jitter.on && !jitter.failed
        && jitter.max <= JITTER_RADIUS && jitter.max > JITTER_RADIUS / 2
        && jitter.distinct >= 2]);

      // 改回 fixed，下一項才是在測「開關關掉」而不是順便測到模式。
      // 要等 callback —— 不等的話這個寫入可能在下一行導航時掉了，
      // 註解宣稱的事就沒真的成立（第 8 項看的是 console 痕跡，不會因此變紅）。
      await ext.evaluate(() => new Promise(r => chrome.storage.local.set({ mode: 'fixed' }, r)));

      // 8) 推送的內容不含已存地點。
      //
      // 這個 CustomEvent 頁面自己的 JS 監聽得到（CLAUDE.md「已知限制」），
      // 所以推送內容必須只有 inject.js 真正要用的那幾個鍵。少了 bridge.js 的
      // pick() 過濾，使用者自己命名的地點簿連同精確座標會被每個網站讀走 ——
      // 而且功能完全正常，沒有任何症狀，只有這一項擋得住那種回退。
      await page.evaluate(() => {
        window.__pushed = [];
        document.addEventListener('geo-mock:settings', (e) => window.__pushed.push(e.detail));
      });

      // 上一項收尾那個 set({ mode: 'fixed' }) 的推送可能還在路上（storage.onChanged
      // → bridge 重讀 storage → dispatch 是好幾個 tick 之後的事，await 那個 set 的
      // callback 等不到它）。不歸零的話它會被算成「places 觸發的推送」——
      // 實測會偶發地把這一項弄紅。
      await page.waitForTimeout(500);
      await page.evaluate(() => { window.__pushed.length = 0; });

      // 存一個地點：places 在 NOT_WATCHED 裡，這個寫入不該觸發任何推送
      await ext.evaluate((place) => new Promise(r =>
        chrome.storage.local.set({ places: [place] }, r)), SECRET_PLACE);
      await page.waitForTimeout(500);
      const pushedByPlaces = await page.evaluate(() => window.__pushed.length);

      // 再改一個真的該推送的鍵，看那則推送裡有什麼
      await ext.evaluate(() => new Promise(r => chrome.storage.local.set({ accuracy: 33 }, r)));
      await page.waitForFunction(() => window.__pushed.length > 0, { timeout: 3000 })
        .catch(() => { /* 沒推送的話下面的斷言自然會紅 */ });
      const leak = await page.evaluate(() => window.__pushed.at(-1) || '');
      let pushedKeys = [];
      try { pushedKeys = Object.keys(JSON.parse(leak).settings || {}); } catch { /* 下面會紅 */ }
      console.log('推送內容的鍵        : ' + JSON.stringify(pushedKeys)
        + `  places 變動觸發的推送次數: ${pushedByPlaces}`);
      results.push(['推送內容不含已存地點',
        pushedByPlaces === 0
        && pushedKeys.length > 0 && !pushedKeys.includes('places')
        && !leak.includes(SECRET_PLACE.label)]);

      // 9) watchPosition / clearWatch（SPEC 第三版第 8 項）
      //
      // 這裡驗的是三件在 getCurrentPosition 上不會出現的事：id 必須**同步**回傳
      // （陷阱 2）、固定模式送一次就安靜（座標不變，真正的 watchPosition 只在
      // 位置變化時回呼）、jitter 模式持續送。
      const countTicks = () => page.evaluate(() => window.__watch.length);

      const watchIdType = await page.evaluate(() => {
        window.__watch = [];
        window.__watchId = navigator.geolocation.watchPosition((p) => {
          window.__watch.push({ lat: p.coords.latitude, lng: p.coords.longitude });
        });
        return typeof window.__watchId;   // 回傳的當下就得是數字，不能是 undefined
      });
      // 等超過兩個 jitter 間隔（inject.js 的 JITTER_INTERVAL_MS 是 1 秒）：
      // 固定模式若誤留了計時器，fixedTicks 就會大於 1
      await page.waitForTimeout(2500);
      const fixedTicks = await countTicks();

      // 切到 jitter：座標開始變動，watch 就該持續回報
      await ext.goto(`chrome-extension://${extId}/popup.html`);
      await ext.waitForFunction(() => !document.getElementById('modeJitter').disabled);
      await ext.check('#modeJitter');
      await page.waitForTimeout(3300);   // 約三個間隔，夠下面要求的 >= 3 筆
      const jitterTicks = await page.evaluate(() => window.__watch.slice(1));

      // 停掉之後就該完全安靜：再等超過一個間隔，數字不該再動
      await page.evaluate(() => navigator.geolocation.clearWatch(window.__watchId));
      const atClear = await countTicks();
      await page.waitForTimeout(1500);
      const afterClear = await countTicks();

      const jitterDistinct = new Set(jitterTicks.map(p => `${p.lat},${p.lng}`)).size;
      console.log('watchPosition       : '
        + JSON.stringify({ id: watchIdType, fixedTicks, jitter: jitterTicks.length,
          jitterDistinct, atClear, afterClear }));
      results.push(['watchPosition：固定送一次、jitter 持續送、clearWatch 停得掉',
        watchIdType === 'number'
        && fixedTicks === 1
        && jitterTicks.length >= 3 && jitterDistinct >= 2
        && afterClear === atClear]);

      // 改回 fixed，下一項才是在測開關而不是順便測到模式
      await ext.evaluate(() => new Promise(r => chrome.storage.local.set({ mode: 'fixed' }, r)));

      // 10) Popup 開關關掉 → 不再覆寫。第 2～9 項全在測「開啟」狀態，
      //    enabled: false 這條路徑到這裡才第一次被驗到。
      await ext.goto(`chrome-extension://${extId}/popup.html`);
      // 開關的 CSS transition 是 .15s。不等它跑完就截圖，拍到的是過渡中間狀態 ——
      // 開關看起來還在關閉位，但實際上 checked 已經是 true，截圖會誤導讀的人。
      const SETTLE = 250;
      await ext.waitForTimeout(SETTLE);
      await ext.screenshot({ path: path.join(SHOTS, 'popup-on.png') });

      await ext.uncheck('#enabled');
      // 比對 data-state 而不是顯示文字，也不是 class：
      //   文字 —— 介面有中英兩種語系，比對文字的話換個語言這裡就斷了
      //   class —— popup.js 的 fail() 也會設成 'state off'，
      //            「存檔成功」與「存檔失敗」會分不出來
      // data-state 是 popup.js 專門為這件事寫的訊號，成功是 on/off、失敗是 error。
      await ext.waitForFunction(
        () => document.getElementById('state').dataset.state === 'off');
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
        !overrodeAnything && !(off.overridden && sameCoords(off, LIVE))]);
    } finally {
      await cleanup(a);
    }

    // 11) 失敗情境：設定永遠送不到，排隊必須有出口
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
