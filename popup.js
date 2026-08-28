// geo-mock popup —— 啟用開關 + 地址搜尋。
// 座標的細項欄位（accuracy 等）仍在 options 頁改。
// 設定寫進 storage 後由 bridge.js 的 onChanged 即時推給每個分頁，不必重整。
(() => {
  'use strict';

  const el = Object.fromEntries(
    ['enabled', 'state', 'lat', 'lng', 'accuracy', 'options', 'q', 'go', 'results', 'msg',
      'places', 'addPlace', 'placeForm', 'placeName', 'cancelPlace',
      'modeFixed', 'modeJitter', 'radiusLabel', 'radius']
      .map(k => [k, document.getElementById(k)])
  );

  const PLACE_MAX = 12;   // 存到滿就停，chips 再多下去 popup 會被推得很長
  let places = [];

  // 最後一次讀到／寫入的座標。選了搜尋候選之後只換 lat/lng，
  // accuracy 不在候選資料裡（Nominatim 不提供），要靠這份補齊畫面。
  let current = {};

  // 模式切換只有「固定／抖動」兩個，沒有「關閉」—— 那由上面的開關表達，
  // 否則同一件事會有兩個入口。SPEC 寫的是三選一，偏離的理由記在 SPEC.md。
  function showMode() {
    const isJitter = current.mode === 'jitter';
    el.modeFixed.checked = !isJitter;
    el.modeJitter.checked = isJitter;
    // 半徑只在抖動模式下有意義，固定模式顯示它只會讓人以為它有作用
    el.radiusLabel.hidden = !isJitter;
    el.radius.hidden = !isJitter;
    el.radius.textContent = current.jitterRadius + ' m';
  }

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
      showCoords(s);          // s 是完整設定，mode 與 jitterRadius 也一起進 current
      showMode();
      el.modeFixed.disabled = false;
      el.modeJitter.disabled = false;
      places = Array.isArray(s.places) ? s.places : [];
      renderPlaces();
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
    // 這裡是所有 lat/lng 寫入 storage 的收口。搜尋候選在 geocode.js 已經
    // parseFloat + isFinite 過濾過，但已存地點是從 storage 讀回來的 ——
    // 舊版本或手動編輯留下的壞資料會一路寫進去，畫面顯示 undefined 而 storage
    // 還是舊值，那是最難查的那種不一致。
    const lat = Number(place.lat);
    const lng = Number(place.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      say('這個地點的座標壞掉了', true);
      return;
    }

    try {
      chrome.storage.local.set({ lat, lng }, () => {
        if (chrome.runtime.lastError) {
          say('儲存失敗:' + chrome.runtime.lastError.message, true);
          return;
        }
        showCoords({ lat, lng });
        invalidate();
        el.q.value = '';           // 程式賦值不會觸發 input，訊息不會被洗掉
        say('已套用');
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

  // 兩顆 radio 共用一個 handler：值就在 e.target.value 上，分開寫只是重複。
  function onModeChange(e) {
    const mode = e.target.value;
    // 兩條失敗路徑做的事一樣：沒存成就把畫面扳回實際值，不要顯示一個沒生效的狀態
    const failed = (message) => {
      showMode();
      say('模式儲存失敗:' + message, true);
    };
    try {
      chrome.storage.local.set({ mode }, () => {
        if (chrome.runtime.lastError) { failed(chrome.runtime.lastError.message); return; }
        current.mode = mode;
        showMode();
        say(mode === 'jitter' ? `抖動模式，半徑 ${current.jitterRadius} m` : '固定模式');
      });
    } catch (err) {
      // 同步例外是非預期的程式錯誤，多印一行；lastError 是預期內的失敗，不印
      console.error('[geo-mock] popup 儲存模式失敗:', err);
      failed(err.message);
    }
  }

  el.modeFixed.addEventListener('change', onModeChange);
  el.modeJitter.addEventListener('change', onModeChange);

  // ── 已存地點 ────────────────────────────────────────────────
  // 只有這裡讀寫 places。bridge.js 的 WATCHED 不含這個鍵，所以存／刪地點
  // 不會對每個開著的分頁推一次設定。

  function placeChip(place) {
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'chip';
    use.title = `${place.lat}, ${place.lng}`;
    use.textContent = place.label;      // 使用者自己打的字，一律 textContent
    use.addEventListener('click', () => apply(place));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.title = '刪除';
    del.setAttribute('aria-label', `刪除 ${place.label}`);
    del.textContent = '×';
    // 比對物件參考而不是 index 或內容：index 在前一次刪除後就位移了，
    // 而同名同座標存兩次仍是兩個不同的物件，刪得掉正確的那個。
    del.addEventListener('click', () => savePlaces((list) => list.filter((p) => p !== place)));

    const li = document.createElement('li');
    li.append(use, del);
    return li;
  }

  function renderPlaces() {
    el.places.replaceChildren(...places.map(placeChip));
    const full = places.length >= PLACE_MAX;
    el.addPlace.disabled = full;
    el.addPlace.textContent = full ? `已存滿 ${PLACE_MAX} 個` : '＋ 存目前座標';
  }

  // 收 updater 函式而不是現成的陣列，而且把寫入串成鏈：連續刪兩個 chip 時，
  // 第二次要等第一次寫完、`places` 更新過了才算新陣列。兩次都從同一份舊
  // `places` 扣的話，先刪掉的那個會復活。
  let placeWrites = Promise.resolve();

  function savePlaces(update) {
    placeWrites = placeWrites.then(() => new Promise((done) => {
      const next = update(places);
      // UI 已經把新增鈕 disable 掉了，這裡是收口 —— 日後多一個寫入端
      // （匯入、同步）就不會靜靜地突破上限。
      if (next.length > PLACE_MAX) { done(); return; }
      try {
        chrome.storage.local.set({ places: next }, () => {
          if (chrome.runtime.lastError) {
            say('地點儲存失敗:' + chrome.runtime.lastError.message, true);
          } else {
            places = next;
            renderPlaces();
          }
          done();
        });
      } catch (err) {
        console.error('[geo-mock] popup 儲存地點失敗:', err);
        say('地點儲存失敗:' + err.message, true);
        done();
      }
    }));
  }

  // 不用 prompt()：在 extension popup 裡不可靠（會連 popup 一起關掉），
  // 所以是行內表單，開與關要成對維護。
  function openPlaceForm() {
    el.placeForm.hidden = false;
    el.addPlace.hidden = true;
    el.placeName.value = '';
    el.placeName.focus();
  }

  function closePlaceForm() {
    el.placeForm.hidden = true;
    el.addPlace.hidden = false;
  }

  el.addPlace.addEventListener('click', openPlaceForm);
  el.cancelPlace.addEventListener('click', closePlaceForm);

  el.placeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const label = el.placeName.value.trim();
    if (!label) { el.placeName.focus(); return; }
    if (!Number.isFinite(current.lat) || !Number.isFinite(current.lng)) {
      say('還沒讀到目前座標，等一下再試', true);
      return;
    }
    savePlaces((list) => [...list, { label, lat: current.lat, lng: current.lng }]);
    closePlaceForm();
  });

  el.options.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
})();
