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

  chrome.storage.local.get(GEO_MOCK_DEFAULTS, (s) => {
    if (chrome.runtime.lastError) {
      fail('讀取設定失敗:' + chrome.runtime.lastError.message);
      return;
    }
    el.enabled.checked = !!s.enabled;
    setState(s.enabled);
    el.lat.textContent = s.lat;
    el.lng.textContent = s.lng;
    el.accuracy.textContent = s.accuracy + ' m';
  });

  el.enabled.addEventListener('change', () => {
    const on = el.enabled.checked;
    chrome.storage.local.set({ enabled: on }, () => {
      if (chrome.runtime.lastError) {
        // 沒存成就把開關扳回去，不要讓 UI 顯示一個沒生效的狀態
        el.enabled.checked = !on;
        fail('儲存失敗:' + chrome.runtime.lastError.message);
        return;
      }
      setState(on);
    });
  });

  el.options.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
})();
