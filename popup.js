// geo-mock popup —— 啟用開關 + 地址搜尋。
// 座標的細項欄位（accuracy 等）仍在 options 頁改。
// 沒有 storage.onChanged 即時推送（SPEC 第二版第 6 項），所以切換後必須重整分頁。
(() => {
  'use strict';

  const el = Object.fromEntries(
    ['enabled', 'state', 'lat', 'lng', 'accuracy', 'options', 'q', 'results', 'msg']
      .map(k => [k, document.getElementById(k)])
  );

  // 最後一次讀到／寫入的座標。選了搜尋候選之後只換 lat/lng，
  // accuracy 不在候選資料裡（Nominatim 不提供），要靠這份補齊畫面。
  let current = {};

  function showCoords(patch) {
    current = { ...current, ...patch };
    el.lat.textContent = current.lat;
    el.lng.textContent = current.lng;
    el.accuracy.textContent = current.accuracy === undefined ? '–' : current.accuracy + ' m';
  }

  function setState(on) {
    el.state.textContent = on ? '覆寫中' : '未覆寫，走真實定位';
    el.state.className = 'state ' + (on ? 'on' : 'off');
  }

  function fail(msg) {
    el.state.textContent = msg;
    el.state.className = 'state off';
  }

  // 開關在 HTML 裡是 disabled 的，讀到設定才交出控制權。
  // 否則有一段窗口：checkbox 已經可以點，但顯示的是 HTML 的初始值（unchecked），
  // 而實際預設是 enabled: true —— 使用者會從一個假的基準狀態寫出設定。
  // 讀取失敗時維持 disabled，寧可不能操作，也不要操作到錯的東西。
  try {
    chrome.storage.local.get(GEO_MOCK_DEFAULTS, (s) => {
      if (chrome.runtime.lastError) {
        fail('讀取設定失敗:' + chrome.runtime.lastError.message);
        return;
      }
      el.enabled.checked = !!s.enabled;
      el.enabled.disabled = false;
      setState(s.enabled);
      showCoords(s);
    });
  } catch (err) {
    // 同步例外（如 Extension context invalidated）。bridge.js 也是這樣處理的，
    // 不印出來的話非預期的程式錯誤會消失無蹤。
    console.error('[geo-mock] popup 讀取設定失敗:', err);
    fail('讀取設定失敗:' + err.message);
  }

  el.enabled.addEventListener('change', () => {
    const on = el.enabled.checked;
    try {
      chrome.storage.local.set({ enabled: on }, () => {
        if (chrome.runtime.lastError) {
          // 沒存成就把開關扳回去，不要讓 UI 顯示一個沒生效的狀態
          el.enabled.checked = !on;
          fail('儲存失敗:' + chrome.runtime.lastError.message);
          return;
        }
        setState(on);
      });
    } catch (err) {
      el.enabled.checked = !on;
      console.error('[geo-mock] popup 儲存設定失敗:', err);
      fail('儲存失敗:' + err.message);
    }
  });

  // ── 地址搜尋 ────────────────────────────────────────────────
  // 送出時機與快取的規矩全在 geocode.js，這裡只管 debounce 與畫面。

  let timer = null;
  let seq = 0;   // 連打時較早送出的請求可能較晚回來，用序號丟掉過期的結果

  function say(text, isErr) {
    el.msg.textContent = text;
    el.msg.className = 'msg' + (isErr ? ' err' : '');
  }

  function clearResults() {
    el.results.replaceChildren();
    el.results.hidden = true;
  }

  function apply(r) {
    try {
      chrome.storage.local.set({ lat: r.lat, lng: r.lng }, () => {
        if (chrome.runtime.lastError) {
          say('儲存失敗:' + chrome.runtime.lastError.message, true);
          return;
        }
        showCoords({ lat: r.lat, lng: r.lng });
        clearResults();
        el.q.value = '';
        say('已套用，重新整理目標分頁即生效');
      });
    } catch (err) {
      console.error('[geo-mock] popup 套用座標失敗:', err);
      say('儲存失敗:' + err.message, true);
    }
  }

  function render(items) {
    el.results.replaceChildren(...items.map((r) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      // display_name 是外部回來的資料，一律走 textContent／append，不碰 innerHTML
      btn.append(r.label);
      const coord = document.createElement('span');
      coord.className = 'coord';
      coord.textContent = `${r.lat.toFixed(6)}, ${r.lng.toFixed(6)}`;
      btn.append(coord);
      btn.addEventListener('click', () => apply(r));
      const li = document.createElement('li');
      li.append(btn);
      return li;
    }));
    el.results.hidden = items.length === 0;
  }

  function run(query) {
    const mine = ++seq;
    say('搜尋中…');
    GEO_MOCK_GEOCODE.search(query).then((items) => {
      if (mine !== seq) return;      // 已經有更新的查詢送出，這份結果作廢
      render(items);
      say(items.length ? '' : '找不到符合的地點');
    }).catch((err) => {
      if (mine !== seq) return;
      console.error('[geo-mock] 地址搜尋失敗:', err);
      clearResults();
      say('搜尋失敗:' + err.message, true);
    });
  }

  el.q.addEventListener('input', (e) => {
    if (e.isComposing) return;       // 中文輸入法組字中，還不是完整的查詢字串
    clearTimeout(timer);
    const q = el.q.value.trim();
    if (!q) { seq++; clearResults(); say(''); return; }
    timer = setTimeout(() => run(q), GEO_MOCK_GEOCODE.DEBOUNCE_MS);
  });

  // Enter 不等 debounce 直接查；每秒 1 次的硬下限由 geocode.js 的閘門顧著。
  el.q.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    clearTimeout(timer);
    const q = el.q.value.trim();
    if (q) run(q);
  });

  el.options.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
})();
