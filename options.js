// geo-mock 設定頁 —— 讀寫 chrome.storage.local 的座標欄位。
// 這裡不放啟用開關，那個在 popup（SPEC：Options 頁只放不常改的欄位）。
(() => {
  'use strict';

  const FIELDS = ['lat', 'lng', 'accuracy'];
  const el = Object.fromEntries(FIELDS.map(k => [k, document.getElementById(k)]));
  const form = document.getElementById('form');
  const status = document.getElementById('status');

  function say(text, kind) {
    status.textContent = text;
    status.className = kind;
  }

  // 讀的是完整預設（含 enabled），但只回填與寫出 FIELDS ——
  // enabled 歸 popup 管，這裡不能順手把一份陳舊的值寫回去。
  chrome.storage.local.get(GEO_MOCK_DEFAULTS, (saved) => {
    if (chrome.runtime.lastError) {
      say('讀取設定失敗:' + chrome.runtime.lastError.message, 'err');
      return;
    }
    for (const k of FIELDS) el[k].value = saved[k];
  });

  // Google Maps 右鍵複製出來的是「緯度, 經度」一整串，
  // type=number 的欄位吃不下（逗號會讓 valueAsNumber 變 NaN），所以另開一個
  // 文字欄接住它，拆完填進下面兩欄。範圍檢查仍走 submit 那條共同路徑。
  document.getElementById('paste').addEventListener('input', (e) => {
    const raw = e.target.value.trim();
    if (!raw) { say('', ''); return; }
    // 逗號或空白分隔都收；科學記號不收，貼上來的座標不會長那樣
    const m = raw.match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) { say('認不得這個格式，預期「緯度, 經度」', 'err'); return; }
    el.lat.value = m[1];
    el.lng.value = m[2];
    say('已拆進下面兩欄，記得按儲存', 'ok');
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();

    // 逐欄檢查，不能靠 HTML 的 min/max —— 使用者貼上非數字時 valueAsNumber 會是 NaN
    const values = {};
    for (const k of FIELDS) {
      const n = el[k].valueAsNumber;
      if (!Number.isFinite(n)) { say(`${k} 不是有效的數字`, 'err'); el[k].focus(); return; }
      values[k] = n;
    }
    if (Math.abs(values.lat) > 90)  { say('緯度必須在 -90 ～ 90 之間', 'err'); el.lat.focus(); return; }
    if (Math.abs(values.lng) > 180) { say('經度必須在 -180 ～ 180 之間', 'err'); el.lng.focus(); return; }
    if (values.accuracy < 0)        { say('accuracy 不能是負數', 'err'); el.accuracy.focus(); return; }

    chrome.storage.local.set(values, () => {
      if (chrome.runtime.lastError) {
        say('儲存失敗:' + chrome.runtime.lastError.message, 'err');
        return;
      }
      say('已儲存，重新整理目標分頁即生效', 'ok');
    });
  });
})();
