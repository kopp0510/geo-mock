// geo-mock popup —— 只管啟用開關，座標本身在 options 頁改。
// 沒有 storage.onChanged 即時推送（SPEC 第二版第 6 項），所以切換後必須重整分頁。
(() => {
  'use strict';

  const el = Object.fromEntries(
    ['enabled', 'state', 'lat', 'lng', 'accuracy', 'options']
      .map(k => [k, document.getElementById(k)])
  );

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
      el.lat.textContent = s.lat;
      el.lng.textContent = s.lng;
      el.accuracy.textContent = s.accuracy + ' m';
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

  el.options.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
})();
