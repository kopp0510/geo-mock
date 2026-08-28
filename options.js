// geo-mock 設定頁 —— 讀寫 chrome.storage.local 的座標欄位。
// 這裡不放啟用開關，那個在 popup（SPEC：Options 頁只放不常改的欄位）。
(() => {
  'use strict';

  const { t } = GEO_MOCK_I18N;

  const FIELDS = ['lat', 'lng', 'accuracy', 'jitterRadius'];
  // 錯誤訊息要講欄位的名字，不是它的 id：「jitterRadius 不是有效的數字」
  // 對使用者沒有意義。
  const FIELD_NAMES = {
    lat: 'latName', lng: 'lngName', accuracy: 'accuracyName', jitterRadius: 'radiusName',
  };
  // 半徑沒有上限的話，多按幾個零就會讓抖動算出跨半個地球的座標。
  // inject.js 那邊會夾回合法範圍，但使用者看到的行為會很莫名。
  const JITTER_MAX = 100000;   // 公尺
  const el = Object.fromEntries(FIELDS.map(k => [k, document.getElementById(k)]));
  const form = document.getElementById('form');
  const status = document.getElementById('status');

  // 先用「跟隨瀏覽器」套一次，讀到設定再套第二次，免得選了 English 的人
  // 每次開這頁都先閃一下中文。
  // **必須排在上面那些 const 之後**：applyAll() 讀 JITTER_MAX，提早呼叫會踩到
  // TDZ，整支 script 拋掉 —— 症狀是欄位永遠空白、頁面看起來像沒載入。
  GEO_MOCK_I18N.setLocale('auto');
  applyAll();

  // apply() 只管靜態的 data-i18n；帶參數的那一句它填不了，所以包在一起，
  // 免得哪次只呼叫了 apply() 而讓 hint 停在上一個語系。
  function applyAll() {
    GEO_MOCK_I18N.apply();
    document.getElementById('radiusHint').textContent = t('radiusHint', JITTER_MAX);
  }

  function say(text, kind) {
    status.textContent = text;
    status.className = kind;
  }

  // 讀的是完整預設（含 enabled、mode、places），但只回填與寫出 FIELDS ——
  // 那幾個歸 popup 管，這裡不能順手把一份陳舊的值寫回去。
  chrome.storage.local.get(GEO_MOCK_DEFAULTS, (saved) => {
    if (chrome.runtime.lastError) {
      say(t('loadFailed', chrome.runtime.lastError.message), 'err');
      return;
    }
    // 語言在 popup 選，這裡只跟著跑
    GEO_MOCK_I18N.setLocale(saved.locale);
    applyAll();

    for (const k of FIELDS) el[k].value = saved[k];
  });

  // popup 換語言時這一頁可能正開著。沒有這個監聽的話它會停在舊語言直到重新載入，
  // 而 README 寫的是「選了立刻換」。locale 以外的鍵不用管 —— 這頁的欄位值
  // 只在載入時讀一次，使用者正在編輯時被外部改動蓋掉才更糟。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.locale) return;
    GEO_MOCK_I18N.setLocale(changes.locale.newValue);
    applyAll();
  });

  // Google Maps 右鍵複製出來的是「緯度, 經度」一整串，
  // type=number 的欄位吃不下（逗號會讓 valueAsNumber 變 NaN），所以另開一個
  // 文字欄接住它，拆完填進下面兩欄。範圍檢查仍走 submit 那條共同路徑。
  document.getElementById('paste').addEventListener('input', (e) => {
    const raw = e.target.value.trim();
    if (!raw) { say('', ''); return; }
    // 逗號或空白分隔都收；科學記號不收，貼上來的座標不會長那樣
    const m = raw.match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) { say(t('pasteBadFormat'), 'err'); return; }
    el.lat.value = m[1];
    el.lng.value = m[2];
    say(t('pasteSplit'), 'ok');
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();

    // 逐欄檢查，不能靠 HTML 的 min/max —— 使用者貼上非數字時 valueAsNumber 會是 NaN
    const values = {};
    for (const k of FIELDS) {
      const n = el[k].valueAsNumber;
      if (!Number.isFinite(n)) {
        say(t('notANumber', t(FIELD_NAMES[k])), 'err'); el[k].focus(); return;
      }
      values[k] = n;
    }
    if (Math.abs(values.lat) > 90)  { say(t('latRange'), 'err'); el.lat.focus(); return; }
    if (Math.abs(values.lng) > 180) { say(t('lngRange'), 'err'); el.lng.focus(); return; }
    if (values.accuracy < 0)        { say(t('accuracyNegative'), 'err'); el.accuracy.focus(); return; }
    if (values.jitterRadius < 0 || values.jitterRadius > JITTER_MAX) {
      say(t('radiusRange', JITTER_MAX), 'err'); el.jitterRadius.focus(); return;
    }

    chrome.storage.local.set(values, () => {
      if (chrome.runtime.lastError) {
        say(t('saveFailed', chrome.runtime.lastError.message), 'err');
        return;
      }
      say(t('saved'), 'ok');
    });
  });
})();
