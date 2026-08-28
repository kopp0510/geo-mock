// geo-mock 地址搜尋 —— 包住 Nominatim 的查詢、快取與速率閘門。
//
// 只在擴充自己的頁面（popup）載入，不是 content script，所以這裡可以直接用
// chrome.storage 的 promise 版 API，也不必像 defaults.js 那樣防二次注入。
//
// Nominatim 使用政策是硬約束（見 SPEC.md），違反會被封鎖。這支檔案是唯一
// 送出請求的地方，三條規定都在這裡兌現：
//   1. 絕對上限每秒 1 次 → DEBOUNCE_MS（打字停下才查）+ gate()（實際送出的硬下限）
//   2. 必須快取，重複查同一個字串可能被封 → chrome.storage.local
//   3. 必須顯示 OpenStreetMap 出處 → popup.html 的 .attrib（不在這裡，但屬同一組約束）
const GEO_MOCK_GEOCODE = (() => {
  'use strict';

  const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
  const CACHE_KEY = 'geocodeCache';
  const LAST_AT_KEY = 'geocodeLastAt';

  const DEBOUNCE_MS = 1200;        // 打字停多久才送；政策要求 ≥1000，留一點餘裕
  const MIN_INTERVAL_MS = 1000;    // 兩次實際送出之間的硬下限
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const CACHE_MAX = 50;            // 快取筆數上限，超過丟最舊的
  const LIMIT = 5;                 // 候選清單長度

  // popup 每次開啟都是新的 JS 環境，記憶體裡的時間戳會歸零 ——
  // 所以真正把關的是存進 storage 的那份，記憶體這份只是省一次讀取。
  let lastRequestAt = 0;
  let chain = Promise.resolve();

  // 快取鍵：去頭尾、壓縮空白、轉小寫。「 台北  車站 」與「台北 車站」算同一筆。
  const normalize = (q) => q.trim().replace(/\s+/g, ' ').toLowerCase();

  async function cacheGet(key) {
    const { [CACHE_KEY]: cache = {} } = await chrome.storage.local.get(CACHE_KEY);
    const hit = cache[key];
    if (!hit || Date.now() - hit.ts > CACHE_TTL_MS) return null;
    return hit.results;
  }

  async function cachePut(key, results) {
    const { [CACHE_KEY]: cache = {} } = await chrome.storage.local.get(CACHE_KEY);
    const next = { ...cache, [key]: { ts: Date.now(), results } };
    const keys = Object.keys(next);
    if (keys.length > CACHE_MAX) {
      keys.sort((a, b) => next[a].ts - next[b].ts)
        .slice(0, keys.length - CACHE_MAX)
        .forEach((k) => delete next[k]);
    }
    await chrome.storage.local.set({ [CACHE_KEY]: next });
  }

  // 送出前先擋住，確保與上一次送出至少隔 MIN_INTERVAL_MS。
  async function gate() {
    const { [LAST_AT_KEY]: storedAt = 0 } = await chrome.storage.local.get(LAST_AT_KEY);
    // 取兩者較大的：storage 那份跨 popup 開關有效，記憶體那份反映本次剛送出的。
    const wait = MIN_INTERVAL_MS - (Date.now() - Math.max(storedAt, lastRequestAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    await chrome.storage.local.set({ [LAST_AT_KEY]: lastRequestAt });
  }

  async function fetchRemote(query) {
    await gate();
    const url = `${ENDPOINT}?format=jsonv2&limit=${LIMIT}`
      + `&accept-language=zh-TW&q=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Nominatim 回應 ${res.status}`);
    const raw = await res.json();
    // lat/lon 回來是字串，不轉的話存進 storage 的是字串，
    // 畫面上看起來一模一樣，但 inject.js 拿到的座標型別就錯了。
    return raw
      .map((r) => ({ label: r.display_name, lat: parseFloat(r.lat), lng: parseFloat(r.lon) }))
      .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
  }

  // 查一組候選。先看快取，沒有才送出；同時只會有一個請求在路上（串成鏈），
  // 否則兩發併行會一起穿過 gate()，變成同一秒兩次請求。
  function search(query) {
    const key = normalize(query);
    if (!key) return Promise.resolve([]);
    return cacheGet(key).then((hit) => {
      if (hit) return hit;
      const next = chain.catch(() => {}).then(() => fetchRemote(key));
      chain = next.catch(() => {});   // 前一發失敗不能卡死後面的
      return next.then(async (results) => {
        await cachePut(key, results);
        return results;
      });
    });
  }

  return { search, DEBOUNCE_MS };
})();
