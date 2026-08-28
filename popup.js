// geo-mock popup —— 啟用開關 + 地址搜尋。
// 座標的細項欄位（accuracy 等）仍在 options 頁改。
// 沒有 storage.onChanged 即時推送（SPEC 第二版第 6 項），所以切換後必須重整分頁。
(() => {
  'use strict';

  const el = Object.fromEntries(
    ['enabled', 'state', 'lat', 'lng', 'accuracy', 'options', 'q', 'go', 'results', 'msg']
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
  // 速率、快取與去重的規矩全在 geocode.js，這裡只管觸發時機與畫面。
  //
  // **只由 Enter 或搜尋鈕觸發，不做打字即查。** Nominatim 政策的 Unacceptable Use
  // 明文禁止 client 端的 auto-complete（「will get you banned」），跟速率無關，
  // 加多長的 debounce 都不合規。要改動這段之前先看 geocode.js 開頭那段政策說明。

  let seq = 0;   // 較早送出的請求可能較晚回來，用序號丟掉過期的結果

  function say(text, isErr) {
    el.msg.textContent = text;
    el.msg.className = 'msg' + (isErr ? ' err' : '');
  }

  function clearResults() {
    el.results.replaceChildren();
    el.results.hidden = true;
  }

  // 收掉畫面上對不上的候選，並讓還在路上的那發結果作廢。
  // 這兩件事一定要一起做：少了 seq++，回來的結果會把剛清掉的清單畫回去。
  // 三個呼叫端（改字、套用、查詢失敗）差別只在之後顯示什麼訊息。
  function invalidate() {
    seq++;
    clearResults();
  }

  function apply(place) {
    try {
      chrome.storage.local.set({ lat: place.lat, lng: place.lng }, () => {
        if (chrome.runtime.lastError) {
          say('儲存失敗:' + chrome.runtime.lastError.message, true);
          return;
        }
        showCoords({ lat: place.lat, lng: place.lng });
        invalidate();
        el.q.value = '';           // 程式賦值不會觸發 input，訊息不會被洗掉
        say('已套用，重新整理目標分頁即生效');
      });
    } catch (err) {
      console.error('[geo-mock] popup 套用座標失敗:', err);
      say('儲存失敗:' + err.message, true);
    }
  }

  // 一列候選：地址在上、座標在下，整列是一顆按鈕，點了就套用。
  function resultItem(place) {
    const coord = document.createElement('span');
    coord.className = 'coord';
    coord.textContent = `${place.lat.toFixed(6)}, ${place.lng.toFixed(6)}`;

    const btn = document.createElement('button');
    btn.type = 'button';
    // label 是外部回來的資料（Nominatim 的 display_name），
    // 一律走 textContent／append，不碰 innerHTML
    btn.append(place.label, coord);
    btn.addEventListener('click', () => apply(place));

    const li = document.createElement('li');
    li.append(btn);
    return li;
  }

  function render(items) {
    el.results.replaceChildren(...items.map(resultItem));
    el.results.hidden = items.length === 0;
  }

  // 查詢跑在 service worker（background.js），不在這裡。這樣 popup 中途被關掉時，
  // fetch 與快取寫入照樣完成，不會下次再送一遍同樣的查詢。
  async function run(query) {
    const mine = ++seq;
    say('搜尋中…');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'geo-mock:search', query });
      if (mine !== seq) return;      // 已經有更新的查詢送出，這份結果作廢
      // 回覆沒送到時 res 是 undefined（不是 reject），
      // 不擋的話下一行會讀到 undefined.results
      if (!res) throw new Error('service worker 沒有回應');
      if (res.error) throw new Error(res.error);
      render(res.results);
      say(res.results.length ? '' : '找不到符合的地點');
    } catch (err) {
      if (mine !== seq) return;
      console.error('[geo-mock] 地址搜尋失敗:', err);
      invalidate();
      say('搜尋失敗:' + err.message, true);
    }
  }

  function submit() {
    const q = el.q.value.trim();
    if (!q) { el.q.focus(); return; }
    run(q);
  }

  // 改字之後畫面上那份候選就對不上輸入框了。
  el.q.addEventListener('input', () => {
    invalidate();
    say('');
  });

  el.q.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.isComposing) return;       // 中文輸入法用 Enter 選字，那不是要送出
    if (e.repeat) return;            // 壓著不放會連發，一次一發就夠
    e.preventDefault();
    submit();
  });

  el.go.addEventListener('click', submit);

  el.options.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
})();
