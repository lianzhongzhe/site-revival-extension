// 网站恢复助手 —— 内容脚本
// 职责：1) 实时暂存页面表单内容（防抖落盘） 2) 网站恢复访问后自动还原表单

(() => {
  if (window.top !== window) return; // 只在顶层页面运行

  const PAGE_URL = location.href.split('#')[0];
  const SAVE_DEBOUNCE_MS = 700;
  let saveTimer = null;
  let suppressSaveUntil = 0; // 还原操作触发的 input 事件不应再次写草稿

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- 采集表单内容 ---------- */

  function collectFields() {
    return Array.from(document.querySelectorAll('input, textarea, select'))
      .map((el, idx) => {
        const tag = el.tagName.toLowerCase();
        const type = tag === 'input' ? (el.type || 'text').toLowerCase() : tag;
        // 密码、文件、隐藏字段不保存（隐私与安全考虑）
        if (['password', 'file', 'hidden', 'submit', 'button', 'image', 'reset'].includes(type)) return null;
        const info = {
          idx: idx,
          tag: tag,
          type: type,
          name: el.name || '',
          id: el.id || '',
          ph: el.getAttribute('placeholder') || '',
        };
        if (type === 'checkbox' || type === 'radio') {
          info.checked = el.checked;
          info.value = el.value;
        } else {
          info.value = el.value;
        }
        return info;
      })
      .filter(Boolean);
  }

  function hasContent(fields) {
    return fields.some((f) =>
      f.type === 'checkbox' || f.type === 'radio' ? f.checked : String(f.value || '').trim() !== ''
    );
  }

  function saveDraft() {
    try {
      const fields = collectFields();
      if (!hasContent(fields)) return; // 页面上没填任何东西就不存
      const snap = { title: document.title, savedAt: Date.now(), fields: fields };
      chrome.storage.local.set({ ['draft:' + PAGE_URL]: snap }).catch(() => {});
    } catch (e) { /* ignore */ }
  }

  function queueSave() {
    if (Date.now() < suppressSaveUntil) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, SAVE_DEBOUNCE_MS);
  }

  document.addEventListener('input', queueSave, true);
  document.addEventListener('change', queueSave, true);
  // 提交瞬间立即落盘，防止跳转失败后内容丢失
  document.addEventListener('submit', () => { clearTimeout(saveTimer); saveDraft(); }, true);

  /* ---------- 还原表单 ---------- */

  function restoreSnapshot(snap) {
    const current = Array.from(document.querySelectorAll('input, textarea, select'));
    let restored = 0;
    for (const f of snap.fields || []) {
      const el = findField(current, f);
      if (el && applyValue(el, f)) restored++;
    }
    return restored;
  }

  // 定位字段：name > id > placeholder > 序号
  function findField(current, f) {
    if (f.type === 'radio' && f.name) {
      const byValue = current.find((el) => el.type === 'radio' && el.name === f.name && el.value === f.value);
      if (byValue) return byValue;
    }
    if (f.name) {
      const sameType = current.filter((el) => el.name === f.name && el.type === f.type);
      if (sameType.length) return sameType[0];
      const any = current.filter((el) => el.name === f.name);
      if (any.length) return any[0];
    }
    if (f.id) {
      const el = current.find((el) => el.id === f.id);
      if (el) return el;
    }
    if (f.ph) {
      const el = current.find((el) => el.getAttribute('placeholder') === f.ph);
      if (el) return el;
    }
    return current[f.idx] || null;
  }

  function applyValue(el, f) {
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el.type || 'text').toLowerCase() : tag;
    if (['password', 'file', 'hidden'].includes(type)) return false;
    try {
      if (type === 'checkbox') {
        if (el.checked !== !!f.checked) { el.checked = !!f.checked; fireEvents(el); }
        return true;
      }
      if (type === 'radio') {
        if (el.value === f.value && f.checked) { el.checked = true; fireEvents(el); return true; }
        return false;
      }
      if (tag === 'select') {
        const opts = Array.from(el.options);
        const hit = opts.find((o) => o.value === f.value) || opts.find((o) => o.text === f.value);
        if (!hit) return false;
        if (el.value !== hit.value) { el.value = hit.value; fireEvents(el); }
        return true;
      }
      const v = f.value == null ? '' : String(f.value);
      if (el.value !== v) setNativeValue(el, v);
      return true;
    } catch (e) {
      return false;
    }
  }

  // 用原生 setter 赋值并派发事件，兼容 React/Vue 等框架页面
  function setNativeValue(el, v) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, v);
    else el.value = v;
    fireEvents(el);
  }

  function fireEvents(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ---------- 页面内提示条 ---------- */

  function showBanner(count) {
    const box = document.createElement('div');
    box.style.cssText = [
      'position:fixed', 'right:20px', 'bottom:20px', 'z-index:2147483647',
      'max-width:320px', 'padding:12px 16px', 'border-radius:10px',
      'background:#111827', 'color:#fff',
      'font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,.25)',
    ].join(';');

    const title = document.createElement('div');
    title.style.fontWeight = '700';
    title.textContent = '已自动还原 ' + count + ' 个表单字段';

    const desc = document.createElement('div');
    desc.style.cssText = 'opacity:.75;margin-top:4px';
    desc.textContent = '该网站此前无法访问，现已恢复。内容已填回，请确认后重新提交。';

    const close = document.createElement('button');
    close.textContent = '知道了';
    close.style.cssText = 'margin-top:8px;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;background:#10b981;color:#fff;font-size:12px';
    close.addEventListener('click', () => box.remove());

    box.append(title, desc, close);
    document.documentElement.appendChild(box);
    setTimeout(() => box.remove(), 10000);
  }

  /* ---------- 启动：查询是否有待恢复记录 ---------- */

  async function tryRestore() {
    let res = null;
    try {
      res = await chrome.runtime.sendMessage({ type: 'CHECK_RECOVERY', url: PAGE_URL });
    } catch (e) { return; }
    if (!res || !res.found) return;

    suppressSaveUntil = Date.now() + 2000;
    let restored = 0;
    for (let i = 0; i < 4; i++) {
      restored = res.snapshot ? restoreSnapshot(res.snapshot) : 0;
      if (restored > 0) break;
      // SPA 页面的字段可能还没渲染出来，稍等重试；已有字段但没匹配上则放弃
      if (document.querySelector('input, textarea, select')) break;
      await sleep(1000);
    }
    if (restored > 0) showBanner(restored);

    // 无论是否还原成功，页面既然已正常打开，就清理待恢复记录
    try { await chrome.runtime.sendMessage({ type: 'RECOVERED', url: PAGE_URL }); }
    catch (e) { /* ignore */ }
  }

  tryRestore();
})();
