(() => {
// content.js v5.0
// Claude, ChatGPT, Gemini, Telegram 범용 지원

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 현재 사이트 감지 ──
const SITE = (() => {
  const h = location.hostname;
  if (h === 'claude.ai') return 'claude';
  if (h === 'chat.openai.com' || h === 'chatgpt.com') return 'chatgpt';
  if (h === 'gemini.google.com') return 'gemini';
  if (h.includes('web.telegram.org')) return 'telegram';
  return null;
})();

const SITE_NAME = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini', telegram: 'Telegram' }[SITE] || 'AI';

// ── 복사 모드: 'full' | 'code' (AI→TG)
let copyMode = 'code'; // 기본값: 코드블록
// ── TG→AI 모드: 'all' | 'last'
let tgCopyMode = 'all'; // 기본값: 답변전체

// ── 공통 입력 함수 ──
function normalizeBridgeText(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function getContentEditablePlainText(el) {
  return normalizeBridgeText(el.innerText || el.textContent || '');
}

function setContentEditableTextWithBreaks(el, text) {
  const normalizedText = normalizeBridgeText(text);

  el.textContent = '';

  const lines = normalizedText.split('\n');
  lines.forEach(function(line, index) {
    if (index > 0) {
      el.appendChild(document.createElement('br'));
    }
    if (line) {
      el.appendChild(document.createTextNode(line));
    }
  });

  el.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    cancelable: true,
    data: normalizedText,
    inputType: 'insertText'
  }));
}

function dispatchPasteText(el, text) {
  const normalizedText = normalizeBridgeText(text);

  try {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', normalizedText);

    const pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer
    });

    el.dispatchEvent(pasteEvent);
    return true;
  } catch (e) {
    return false;
  }
}

function setInput(el, text) {
  const normalizedText = normalizeBridgeText(text);

  el.focus();

  if (el.isContentEditable) {
    document.execCommand('selectAll', false, null);

    const pasteDispatched = dispatchPasteText(el, normalizedText);

    setTimeout(function() {
      const currentText = getContentEditablePlainText(el).trim();
      const expectedText = normalizedText.trim();

      if (!currentText || currentText !== expectedText) {
        document.execCommand('selectAll', false, null);
        const inserted = document.execCommand('insertText', false, normalizedText);

        const afterInsertText = getContentEditablePlainText(el).trim();

        if (!inserted || !afterInsertText || afterInsertText !== expectedText) {
          document.execCommand('selectAll', false, null);
          setContentEditableTextWithBreaks(el, normalizedText);
        }
      }
    }, pasteDispatched ? 80 : 0);

    return;
  }

  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  if (nativeSetter) nativeSetter.call(el, normalizedText);
  else el.value = normalizedText;

  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// ── 토큰 추정 ──
function estimateTokens(text) {
  if (!text) return 0;
  const korean = (text.match(/[가-힣]/g) || []).length;
  const others = text.length - korean;
  return Math.ceil(korean / 2 + others / 4);
}

// ────────────────────────────────────────
// Claude
// ────────────────────────────────────────
function claude_getResponse() {
  const selectors = ['.font-claude-message', '[data-testid="assistant-message"]', '.prose', '.standard-markdown'];
  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);
    if (!els.length) continue;
    const last = els[els.length - 1];
    const code = last.querySelectorAll('pre');
    if (copyMode === 'code' && code.length) return code[code.length - 1].innerText?.trim() || null;
    return last.innerText?.trim() || null;
  }
  return null;
}

function claude_isStreaming() {
  const stops = [
    'button[aria-label="Stop generating"]', 'button[aria-label="Stop response"]',
    'button[aria-label="응답 중지"]', 'button[data-testid="stop-button"]', 'button[aria-label="Stop"]'
  ];
  return stops.some(s => document.querySelector(s));
}

async function claude_pasteInput(text, autoSend) {
  const input = document.querySelector('[data-testid="chat-input"]');
  if (!input) return { ok: false, error: '입력창을 찾을 수 없어요.' };
  setInput(input, text);
  if (!autoSend) return { ok: true };
  await sleep(400);
  const btn = document.querySelector('button[aria-label="메시지 보내기"], button[aria-label="Send message"]');
  if (!btn || btn.disabled) return { ok: false, error: '전송 버튼을 찾을 수 없어요.' };
  btn.click();
  return { ok: true };
}

function claude_getInputEl() {
  return document.querySelector('[data-testid="chat-input"]');
}

// ────────────────────────────────────────
// ChatGPT
// ────────────────────────────────────────
function chatgpt_getResponse() {
  const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
  if (!msgs.length) return null;
  const last = msgs[msgs.length - 1];
  const code = last.querySelectorAll('pre');
  if (copyMode === 'code' && code.length) return code[code.length - 1].innerText?.trim() || null;
  return last.innerText?.trim() || null;
}

function chatgpt_isStreaming() {
  return !!document.querySelector(
    'button[aria-label="Stop streaming"], [data-testid="stop-button"], button[aria-label="Stop generating"]'
  );
}

async function chatgpt_pasteInput(text, autoSend) {
  const input = document.querySelector('#prompt-textarea') ||
                document.querySelector('div[contenteditable="true"][data-lexical-editor]') ||
                document.querySelector('div[contenteditable="true"]');
  if (!input) return { ok: false, error: '입력창을 찾을 수 없어요.' };
  setInput(input, text);
  if (!autoSend) return { ok: true };
  await sleep(400);
  const btn = document.querySelector(
    'button[data-testid="send-button"], button[aria-label="Send message"], button[aria-label="메시지 보내기"]'
  );
  if (!btn || btn.disabled) return { ok: false, error: '전송 버튼을 찾을 수 없어요.' };
  btn.click();
  return { ok: true };
}

function chatgpt_getInputEl() {
  return document.querySelector('#prompt-textarea') ||
         document.querySelector('div[contenteditable="true"]');
}

// ────────────────────────────────────────
// Gemini
// ────────────────────────────────────────
function gemini_getResponse() {
  const selectors = [
    'model-response .response-content',
    '.model-response-text',
    'message-content',
    '.response-container-scrollable'
  ];
  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);
    if (!els.length) continue;
    const last = els[els.length - 1];
    const code = last.querySelectorAll('pre');
    if (copyMode === 'code' && code.length) return code[code.length - 1].innerText?.trim() || null;
    return last.innerText?.trim() || null;
  }
  return null;
}

function gemini_isStreaming() {
  return !!document.querySelector('.loading-indicator, [aria-label="Stop generating"], .progress-container');
}

async function gemini_pasteInput(text, autoSend) {
  const input = document.querySelector('rich-textarea div[contenteditable="true"]') ||
                document.querySelector('.ql-editor') ||
                document.querySelector('div[contenteditable="true"]');
  if (!input) return { ok: false, error: '입력창을 찾을 수 없어요.' };
  setInput(input, text);
  if (!autoSend) return { ok: true };
  await sleep(400);
  const btn = document.querySelector('button[aria-label="Send message"], button.send-button');
  if (!btn || btn.disabled) return { ok: false, error: '전송 버튼을 찾을 수 없어요.' };
  btn.click();
  return { ok: true };
}

function gemini_getInputEl() {
  return document.querySelector('rich-textarea div[contenteditable="true"]') ||
         document.querySelector('div[contenteditable="true"]');
}

// ────────────────────────────────────────
// Telegram
// ────────────────────────────────────────
function telegram_getAllLastBotMessages() {
  // ── K 버전: .bubble ──
  const bubbles = document.querySelectorAll('.bubble');
  if (bubbles.length) {
    const texts = [];
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const bubble = bubbles[i];
      if (bubble.classList.contains('is-out')) break; // 사용자 메시지 → 중단
      const text = bubble.querySelector('.text, .message, [class*="text-content"]')?.innerText?.trim();
      if (text) texts.unshift(text);
    }
    if (texts.length) return texts.join('\n\n');
  }
  return null;
}

function telegram_getLastBotMessage() {
  // ── K 버전: .bubble:not(.is-out) ──
  const bubbles = document.querySelectorAll('.bubble:not(.is-out)');
  if (bubbles.length) {
    const last = bubbles[bubbles.length - 1];
    const text = last.querySelector('.text, .message, [class*="text-content"]')?.innerText?.trim();
    if (text) return text;
  }

  // ── A 버전: .messages-container .message ──
  const aMsgs = document.querySelectorAll('.messages-container .message, [data-message-id]');
  const aBotMsgs = Array.from(aMsgs).filter(m =>
    !m.classList.contains('own') && !m.classList.contains('is-outgoing')
  );
  if (aBotMsgs.length) {
    const last = aBotMsgs[aBotMsgs.length - 1];
    const text = last.querySelector('.text-content, .message-text, [data-message-text]')?.innerText?.trim();
    if (text) return text;
  }

  return null;
}

// tgCopyMode에 따라 적절한 함수 호출 (파라미터로 전달받은 mode 사용)
function telegram_getMessageForMode(mode) {
  if (mode === 'all') {
    const all = telegram_getAllLastBotMessages();
    if (all) return all;
  }
  return telegram_getLastBotMessage();
}

async function telegram_sendMessage(text, autoSend) {
  // 메인 입력창 찾기 (K버전 div.input-message-input)
  let input = document.querySelector('div.input-message-input[contenteditable="true"]');

  if (!input) return { ok: false, error: 'Telegram 입력창을 찾을 수 없어요.' };
  input.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('insertText', false, text);
  input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  if (!autoSend) return { ok: true };
  await sleep(400);

  // 전송 버튼 찾기 — K버전: btn-send, A버전: aria-label
  let btn = document.querySelector('button.btn-send');
  if (!btn || btn.disabled) {
    btn = document.querySelector(
      'button.bubbles-corner-button:not(.chat-secondary-button), button[aria-label*="Send"], button[aria-label*="보내"]'
    );
  }

  if (!btn || btn.disabled) return { ok: false, error: '전송 버튼을 찾을 수 없어요.' };
  btn.click();
  return { ok: true };
}

// ────────────────────────────────────────
// 사이트별 디스패처
// ────────────────────────────────────────
function getResponse() {
  if (SITE === 'claude')  return claude_getResponse();
  if (SITE === 'chatgpt') return chatgpt_getResponse();
  if (SITE === 'gemini')  return gemini_getResponse();
  return null;
}

function isStreaming() {
  if (SITE === 'claude')  return claude_isStreaming();
  if (SITE === 'chatgpt') return chatgpt_isStreaming();
  if (SITE === 'gemini')  return gemini_isStreaming();
  return false;
}

async function pasteToAI(text, autoSend) {
  if (SITE === 'claude')  return claude_pasteInput(text, autoSend);
  if (SITE === 'chatgpt') return chatgpt_pasteInput(text, autoSend);
  if (SITE === 'gemini')  return gemini_pasteInput(text, autoSend);
  return { ok: false, error: '지원하지 않는 사이트예요.' };
}

function getInputEl() {
  if (SITE === 'claude')  return claude_getInputEl();
  if (SITE === 'chatgpt') return chatgpt_getInputEl();
  if (SITE === 'gemini')  return gemini_getInputEl();
  return null;
}

// ────────────────────────────────────────
// 공통 모듈 (CSS, 드래그, 상태)
// ────────────────────────────────────────
const PANEL_STYLES = `
    .ctb-btn {
      display: block !important; width: 100% !important; padding: 9px 8px !important;
      border: none !important; border-radius: 7px !important; font-size: 10px !important; font-weight: 500 !important;
      cursor: pointer !important; margin-bottom: 5px !important;
      color: #fff !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important;
    }
    .ctb-btn:hover { opacity: 0.85; }
    .ctb-btn:active { opacity: 0.65; }
    .ctb-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .ctb-tg { background: #2AABEE !important; }
    .ctb-cls { background: #a78bfa !important; }
    #ctb-ai-autosend-label, #ctb-tg-autosend-label {
      display: flex !important; align-items: center !important; gap: 4px;
      margin-top: 2px; cursor: pointer; user-select: none;
    }
    #ctb-ai-autosend-label span, #ctb-tg-autosend-label span { font-size: 9px !important; color: #a0a0b0 !important; line-height: 1.2; }
    #ctb-autosend { width: 11px; height: 11px; accent-color: #2AABEE; cursor: pointer; flex-shrink: 0; }
    #ctb-mode-row {
      display: flex; gap: 4px; margin-bottom: 5px;
    }
    #ctb-tgmode-row {
      display: flex; gap: 4px; margin-bottom: 5px;
    }
    .ctb-mode-btn {
      flex: 1; padding: 3px 0; font-size: 9px; font-weight: 600;
      border: 1px solid #333355; border-radius: 5px;
      background: none; color: #555577; cursor: pointer; transition: all 0.15s;
    }
    .ctb-mode-btn:hover { border-color: #a78bfa; color: #a78bfa; }
    .ctb-mode-active { background: #2a2a55 !important; border-color: #a78bfa !important; color: #a78bfa !important; }
    #ctb-status { color: #a0a0b0 !important;
      margin-top: 6px; font-size: 9px; text-align: center;
      min-height: 12px; color: #a0a0b0; line-height: 1.3;
      word-break: keep-all; white-space: pre-wrap;
    }
    #ctb-status.ok  { color: #4ade80; }
    #ctb-status.err { color: #f87171; }
    #ctb-token-counter {
      position: absolute; font-size: 10px; color: #888;
      pointer-events: none; z-index: 99998; background: transparent; transition: color 0.2s;
    }
    #ctb-token-counter.warn   { color: #f59e0b; }
    #ctb-token-counter.danger { color: #f87171; }
    /* AI 위젯 */
    #ctb-ai-panel { position:fixed !important; right:16px; bottom:120px;  z-index:99999 !important; background:#1a1a2e; border:1px solid #3a3a5c !important; border-radius:12px !important; padding:9px 10px !important; width:110px !important; box-shadow:0 4px 20px rgba(0,0,0,0.4) !important; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif !important; user-select:none !important; }
    #ctb-ai-title { display:flex; align-items:center; justify-content:space-between; margin-bottom:7px; cursor:grab; }
    #ctb-ai-title:active { cursor:grabbing; }
    #ctb-ai-title-text { font-size:10px; font-weight:600; color:#a78bfa; letter-spacing:0.5px; flex:1; text-align:center; }
    #ctb-ai-controls { display:flex; gap:2px; flex-shrink:0; }
    #ctb-ai-controls button { background:none; border:none; color:#555; font-size:11px; cursor:pointer; padding:0 3px; line-height:1; border-radius:3px; transition:color 0.15s; }
    #ctb-ai-controls button:hover { color:#a78bfa; }
    /* TG 위젯 */
    #ctb-tg-panel { position:fixed !important; right:16px; bottom:120px;  z-index:99999 !important; background:#1a1a2e !important; border:1px solid #3a3a5c !important; border-radius:12px !important; padding:9px 10px !important; width:110px !important; box-shadow:0 4px 20px rgba(0,0,0,0.4) !important; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif !important; user-select:none !important; }
    #ctb-tg-title { display:flex; align-items:center; justify-content:space-between; margin-bottom:7px; cursor:grab; }
    #ctb-tg-title:active { cursor:grabbing; }
    #ctb-tg-title-text { font-size:10px; font-weight:600; color:#a78bfa; letter-spacing:0.5px; flex:1; text-align:center; }
    #ctb-tg-controls { display:flex; gap:2px; flex-shrink:0; }
    #ctb-tg-controls button { background:none; border:none; color:#555; font-size:11px; cursor:pointer; padding:0 3px; line-height:1; border-radius:3px; transition:color 0.15s; }
    #ctb-tg-controls button:hover { color:#a78bfa; }
    .ctb-switch-btn {
      display:block; width:100%; padding:3px 0; margin-top:5px;
      font-size:11px; text-align:center; cursor:pointer;
      background:none; border:1px solid #3a3a5c; border-radius:5px;
      color:#555; transition:color 0.15s,border-color 0.15s;
    }
    .ctb-switch-btn:hover { color:#a78bfa; border-color:#a78bfa; }
`;

function makeDraggable(panel, handleSelector, storageKey) {
  const handle = panel.querySelector(handleSelector);
  if (!handle) return;
  let dragging = false, dragX = 0, dragY = 0;
  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    dragX = e.clientX - panel.getBoundingClientRect().left;
    dragY = e.clientY - panel.getBoundingClientRect().top;
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
    panel.dataset.pinned = 'false';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    panel.style.left = (e.clientX - dragX) + 'px';
    panel.style.top  = (e.clientY - dragY) + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    if (storageKey) {
      chrome.storage.local.set({
        [storageKey]: {
          left: parseInt(panel.style.left) || 0,
          top:  parseInt(panel.style.top)  || 0
        }
      });
    }
  });
}

function copyPanelPosition(fromPanel, toPanel, storageKey) {
  if (!fromPanel || !toPanel || fromPanel === toPanel) return;

  const rect = fromPanel.getBoundingClientRect();

  let left = parseInt(fromPanel.style.left, 10);
  let top = parseInt(fromPanel.style.top, 10);

  if (!Number.isFinite(left)) {
    left = Math.round(rect.left);
  }

  if (!Number.isFinite(top)) {
    top = Math.round(rect.top);
  }

  if (!Number.isFinite(left) || !Number.isFinite(top)) return;

  toPanel.style.right = 'auto';
  toPanel.style.bottom = 'auto';
  toPanel.style.left = left + 'px';
  toPanel.style.top = top + 'px';

  if (storageKey) {
    chrome.storage.local.set({
      [storageKey]: { left: left, top: top }
    });
  }
}

function setPanelStatus(statusEl, msg, type = '') {
  statusEl.textContent = msg;
  statusEl.className = type;
}
function setPanelBtnsDisabled(btns, v) {
  btns.forEach(b => { if (b) b.disabled = v; });
}

function getBridgeRefreshHandlers() {
  window.__ctbRefreshHandlers = window.__ctbRefreshHandlers || {};
  return window.__ctbRefreshHandlers;
}

function registerBridgeRefreshHandler(key, handler) {
  if (!key || typeof handler !== 'function') return;
  getBridgeRefreshHandlers()[key] = handler;
}

function runBridgeRefreshHandler(key, done) {
  var handler = getBridgeRefreshHandlers()[key];
  if (typeof handler === 'function') { handler(done); return; }
  if (typeof done === 'function') done();
}

function isBridgeAIPage() {
  return SITE === 'chatgpt' || SITE === 'claude' || SITE === 'gemini';
}

function syncBridgeTargetPickerVisibility() {
  var isAIPage = isBridgeAIPage();
  var currentTitle = document.title || SITE_NAME || '현재 AI 탭';

  var aiSourceSelect = document.getElementById('ctb-ai-source-select');
  var aiCurrentTabLabel = document.getElementById('ctb-ai-current-tab-label');

  var tgAiSelect = document.getElementById('ctb-ai-select');
  var tgCurrentTabLabel = document.getElementById('ctb-tg-current-tab-label');

  if (isAIPage) {
    if (aiSourceSelect) aiSourceSelect.style.display = 'none';
    if (aiCurrentTabLabel) {
      aiCurrentTabLabel.style.display = 'block';
      aiCurrentTabLabel.textContent = currentTitle;
      aiCurrentTabLabel.title = currentTitle;
    }
    if (tgAiSelect) tgAiSelect.style.display = 'none';
    if (tgCurrentTabLabel) {
      tgCurrentTabLabel.style.display = 'block';
      tgCurrentTabLabel.textContent = currentTitle;
      tgCurrentTabLabel.title = currentTitle;
    }
    return;
  }

  if (aiSourceSelect) aiSourceSelect.style.display = '';
  if (aiCurrentTabLabel) {
    aiCurrentTabLabel.style.display = 'none';
    aiCurrentTabLabel.textContent = '';
    aiCurrentTabLabel.title = '';
  }
  if (tgAiSelect) tgAiSelect.style.display = '';
  if (tgCurrentTabLabel) {
    tgCurrentTabLabel.style.display = 'none';
    tgCurrentTabLabel.textContent = '';
    tgCurrentTabLabel.title = '';
  }
}


// ────────────────────────────────────────
// AI 위젯 (AI→TG 전용)
// ────────────────────────────────────────
function injectAIWidget() {
  if (document.getElementById('ctb-ai-panel')) return;

  // CSS 주입 (최초 1회)
  if (!document.getElementById('ctb-bridge-style')) {
    const style = document.createElement('style');
    style.id = 'ctb-bridge-style';
    style.textContent = PANEL_STYLES;
    document.head.appendChild(style);
  }

  const panel = document.createElement('div');
  panel.id = 'ctb-ai-panel';
  panel.innerHTML = `
    <div id="ctb-ai-title">
      <span id="ctb-ai-title-text">🔗 → Telegram</span>
      <div id="ctb-ai-controls">
        <button id="ctb-ai-minimize" title="최소화">−</button>
        <button id="ctb-ai-refresh" title="새로고침">↺</button>
        <button id="ctb-ai-close" title="닫기">✕</button>
      </div>
    </div>
    <div id="ctb-body">
      <button id="ctb-ai-btn1" class="ctb-btn ctb-tg">📤 → Telegram</button>
      <select id="ctb-ai-source-select" style="width:100%;margin-bottom:5px;padding:2px;font-size:9px;background:#2a2a55;color:#a78bfa;border:1px solid #3a3a5c;border-radius:5px;"><option value="">AI 탭 목록 받는 중...</option></select>
      <div id="ctb-ai-current-tab-label" style="display:none;width:100%;margin-bottom:5px;padding:3px 4px;font-size:9px;background:#2a2a55;color:#a78bfa;border:1px solid #3a3a5c;border-radius:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
      <div id="ctb-mode-row">
        <button id="ctb-ai-mode-full" class="ctb-mode-btn">전체</button>
        <button id="ctb-ai-mode-code" class="ctb-mode-btn ctb-mode-active">코드</button>
      </div>
      <label id="ctb-ai-autosend-label" style="display:flex !important;align-items:center;gap:4px;margin-top:2px;cursor:pointer">
        <input type="checkbox" id="ctb-ai-autosend" checked style="width:13px;height:13px;opacity:1;display:inline;flex-shrink:0;position:static;appearance:auto;accent-color:#2AABEE" />
        <span>전송까지 자동으로</span>
      </label>
      <button id="ctb-ai-switch" class="ctb-switch-btn">🔁 위젯 전환</button>
      <div id="ctb-status"></div>
    </div>
  `;

  document.body.appendChild(panel);

  // ── 위치 복원 ──
  chrome.storage.local.get(['widgetPos_ai'], (res) => {
    if (res?.widgetPos_ai) {
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      panel.style.left = res.widgetPos_ai.left + 'px';
      panel.style.top  = res.widgetPos_ai.top  + 'px';
    }
  });

  makeDraggable(panel, '#ctb-ai-title', 'widgetPos_ai');

  // ── 최소화/복원 ──
  let isMinimized = false;
  const bodyEl = panel.querySelector('#ctb-body');
  const controlsEl = panel.querySelector('#ctb-ai-controls');
  const titleTextEl = panel.querySelector('#ctb-ai-title-text');

  function minimize() {
    isMinimized = true;
    bodyEl.style.display = 'none';
    controlsEl.style.display = 'none';
    panel.style.width = '36px'; panel.style.height = '36px';
    panel.style.borderRadius = '50%'; panel.style.padding = '0';
    panel.style.display = 'flex'; panel.style.justifyContent = 'center'; panel.style.alignItems = 'center';
    panel.style.cursor = 'pointer';
    panel.querySelector('#ctb-ai-title').style.marginBottom = '0';
    panel.querySelector('#ctb-ai-title').style.cursor = 'pointer';
    titleTextEl.style.fontSize = '18px';
    titleTextEl.textContent = '🔗';
  }

  function restore() {
    isMinimized = false;
    bodyEl.style.display = '';
    controlsEl.style.display = '';
    panel.style.width = '110px'; panel.style.height = '';
    panel.style.borderRadius = '12px'; panel.style.padding = '9px 10px';
    panel.style.display = ''; panel.style.justifyContent = ''; panel.style.alignItems = '';
    panel.style.cursor = '';
    panel.querySelector('#ctb-ai-title').style.marginBottom = '7px';
    panel.querySelector('#ctb-ai-title').style.cursor = 'grab';
    titleTextEl.style.fontSize = '10px';
    titleTextEl.textContent = '🔗 → Telegram';
  }

  panel.querySelector('#ctb-ai-minimize').addEventListener('click', (e) => { e.stopPropagation(); minimize(); });
    panel.querySelector('#ctb-ai-refresh').addEventListener('click', (e) => {
    e.stopPropagation();
    runBridgeRefreshHandler('aiSource', function() {
      syncBridgeTargetPickerVisibility();
      setStatus('\u21BA \uC0C8\uB85C\uACE0\uCE68 \uC644\uB8CC', 'ok');
    });
  });
  panel.addEventListener('click', () => { if (isMinimized) restore(); });
  panel.querySelector('#ctb-ai-close').addEventListener('click', (e) => { e.stopPropagation(); panel.style.display = 'none'; });

  // ── 복사 모드 토글 ──
  const modFullBtn = panel.querySelector('#ctb-ai-mode-full');
  const modCodeBtn = panel.querySelector('#ctb-ai-mode-code');
  const applyCopyMode = (mode) => {
    if (mode === 'full') {
      copyMode = 'full';
      modFullBtn.classList.add('ctb-mode-active');
      modCodeBtn.classList.remove('ctb-mode-active');
    } else {
      copyMode = 'code';
      modCodeBtn.classList.add('ctb-mode-active');
      modFullBtn.classList.remove('ctb-mode-active');
    }
  };
  chrome.storage.local.get(['bridge_mode'], (res) => {
    if (res?.bridge_mode) applyCopyMode(res.bridge_mode);
  });
  modFullBtn.addEventListener('click', () => {
    copyMode = 'full'; chrome.storage.local.set({ bridge_mode: 'full' });
    modFullBtn.classList.add('ctb-mode-active');
    modCodeBtn.classList.remove('ctb-mode-active');
  });
  modCodeBtn.addEventListener('click', () => {
    copyMode = 'code'; chrome.storage.local.set({ bridge_mode: 'code' });
    modCodeBtn.classList.add('ctb-mode-active');
    modFullBtn.classList.remove('ctb-mode-active');
  });

  // ── 상태 표시 ──
  const statusEl = panel.querySelector('#ctb-status');
  const btn1 = panel.querySelector('#ctb-ai-btn1');
  const autoCheck = panel.querySelector('#ctb-ai-autosend');
  const AI_SOURCE_COLORS = { chatgpt: '#10A37F', claude: '#D97757', gemini: '#EA4335' };
  let aiSourceTarget = null;
  const aiSourceSelect = panel.querySelector('#ctb-ai-source-select');
  const aiCurrentTabLabel = panel.querySelector('#ctb-ai-current-tab-label');
  const isCurrentPageAI = SITE === 'chatgpt' || SITE === 'claude' || SITE === 'gemini';
  const applyAISource = function(tabInfo) {
    aiSourceTarget = tabInfo;
    var siteName = tabInfo ? (tabInfo.siteName || 'AI') : 'AI';
    btn1.textContent = '\u{1F4E4} \u2192 Telegram';
    btn1.style.background = tabInfo && AI_SOURCE_COLORS[tabInfo.site] ? AI_SOURCE_COLORS[tabInfo.site] : '#2AABEE';
    btn1.title = tabInfo ? siteName + ' - ' + tabInfo.title : '';
  };

  function getSelectedAISourceTabId() {
    if (aiSourceSelect && aiSourceSelect.value) {
      return Number(aiSourceSelect.value);
    }
    return aiSourceTarget ? aiSourceTarget.id : null;
  }

  function updateAISourcePanelUI() {
    if (isCurrentPageAI) {
      if (aiSourceSelect) {
        aiSourceSelect.style.display = 'none';
      }
      if (aiCurrentTabLabel) {
        var currentTitle = document.title || SITE_NAME || '현재 AI 탭';
        aiCurrentTabLabel.style.display = 'block';
        aiCurrentTabLabel.textContent = currentTitle;
        aiCurrentTabLabel.title = currentTitle;
      }
      return;
    }
    if (aiSourceSelect) {
      aiSourceSelect.style.display = '';
    }
    if (aiCurrentTabLabel) {
      aiCurrentTabLabel.style.display = 'none';
      aiCurrentTabLabel.textContent = '';
      aiCurrentTabLabel.title = '';
    }
  }

  const refreshAiSourceTabs = function(done) {
    try {
      chrome.runtime.sendMessage({ action: 'getAiTabs' }, function(res) {
        if (!res || !res.tabs || !res.tabs.length) {
          aiSourceSelect.innerHTML = '<option value="">AI 탭 없음</option>';
          applyAISource(null);
          updateAISourcePanelUI();
          if (typeof done === 'function') done();
          return;
        }
        var tabs = res.tabs;
        var previousTargetId = aiSourceTarget ? Number(aiSourceTarget.id) : null;
        var senderTabId = res.senderTabId ? Number(res.senderTabId) : null;
        aiSourceSelect.innerHTML = '';
        tabs.forEach(function(t) {
          var site = 'ai', siteName = 'AI';
          if (t.url.indexOf('chatgpt.com') >= 0 || t.url.indexOf('chat.openai.com') >= 0) { site = 'chatgpt'; siteName = 'ChatGPT'; }
          else if (t.url.indexOf('claude.ai') >= 0) { site = 'claude'; siteName = 'Claude'; }
          else if (t.url.indexOf('gemini.google.com') >= 0) { site = 'gemini'; siteName = 'Gemini'; }
          var o = document.createElement('option');
          o.value = String(t.id); o.textContent = t.title || siteName;
          o.title = t.title || siteName;
          o.dataset.site = site; o.dataset.siteName = siteName;
          aiSourceSelect.appendChild(o);
        });
        var selectedTabId = null;
        if (isCurrentPageAI && senderTabId && tabs.some(function(tx) { return Number(tx.id) === senderTabId; })) {
          selectedTabId = senderTabId;
        } else if (previousTargetId && tabs.some(function(tx) { return Number(tx.id) === previousTargetId; })) {
          selectedTabId = previousTargetId;
        } else {
          selectedTabId = Number(tabs[0].id);
        }
        aiSourceSelect.value = String(selectedTabId);
        var selectedOption = Array.from(aiSourceSelect.options).find(function(x) { return Number(x.value) === selectedTabId; });
        var selectedTab = tabs.find(function(x) { return Number(x.id) === selectedTabId; });
        if (selectedOption && selectedTab) {
          applyAISource({ site: selectedOption.dataset.site, siteName: selectedOption.dataset.siteName, title: selectedTab.title || selectedOption.textContent, id: selectedTab.id });
        }
        updateAISourcePanelUI();
        if (typeof done === 'function') done();
      });
    } catch(e) {
      aiSourceSelect.innerHTML = '<option value="">AI 탭 오류</option>';
      applyAISource(null);
      updateAISourcePanelUI();
      if (typeof done === 'function') done();
    }
  };

  refreshAiSourceTabs();
  registerBridgeRefreshHandler('aiSource', refreshAiSourceTabs);
  aiSourceSelect.addEventListener('change', function() {
    const selected = this.options[this.selectedIndex];

    if (selected && selected.value) {
      applyAISource({
        site: selected.dataset.site,
        siteName: selected.dataset.siteName,
        title: selected.title || selected.textContent,
        id: Number(selected.value)
      });
    } else {
      applyAISource(null);
    }

    _prevStreaming = null;
    checkStreaming();
  });
  chrome.storage.local.get(['bridge_autosend_ai'], (res) => {
    if (res?.bridge_autosend_ai !== undefined) autoCheck.checked = res.bridge_autosend_ai;
  });
  autoCheck.addEventListener('change', () => {
    chrome.storage.local.set({ bridge_autosend_ai: autoCheck.checked });
  });
  const setStatus = (msg, type) => setPanelStatus(statusEl, msg, type);
  const setBtnsDisabled = (v) => setPanelBtnsDisabled([btn1], v);

  // ── AI → Telegram ──
  btn1.addEventListener('click', () => {
    const autoSend = autoCheck.checked;
    setBtnsDisabled(true);
    setStatus('⏳ 처리 중...');
    chrome.runtime.sendMessage({ action: 'aiToTelegram', autoSend, targetTabId: isCurrentPageAI ? null : (aiSourceTarget ? aiSourceTarget.id : null) }, (res) => {
      setBtnsDisabled(false);
      if (chrome.runtime.lastError) { setStatus(`❌ ${chrome.runtime.lastError.message}`, 'err'); return; }
      if (res?.ok) setStatus('✅ Telegram 전송!', 'ok');
      else         setStatus(`❌ ${res?.error || '실패'}`, 'err');
    });
  });

  // ── 위젯 스위치 ──
  panel.querySelector('#ctb-ai-switch').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleOtherWidget();
  });

  // ── AI 작성 중 감지 ──
  var _streaming = false;
  var _prevStreaming = null;
  var _streamingCheckBusy = false;

  function applyStreamingPanelState(streaming) {
    _streaming = streaming;

    if (streaming) {
      setStatus('\u23F3 \uC791\uC131 \uC911...');
      panel.style.background = '#ffffff';
      panel.style.borderColor = '#d0d0d0';
    } else {
      setStatus('\u2705 \uC644\uB8CC');
      panel.style.background = '#1a1a2e';
      panel.style.borderColor = '#3a3a5c';
    }
  }

  function updateStreamingState(streaming) {
    if (streaming === _prevStreaming) return;
    _prevStreaming = streaming;
    applyStreamingPanelState(streaming);
  }

  function checkStreaming() {
    if (isCurrentPageAI) {
      var localStreaming = false;
      try {
        localStreaming = isStreaming();
      } catch (e) {
        localStreaming = false;
      }
      updateStreamingState(localStreaming);
      return;
    }

    if (_streamingCheckBusy) return;
    _streamingCheckBusy = true;

    var selectedAiTabId = getSelectedAISourceTabId();
    console.log('[AI-STREAM-REMOTE] selectedAiTabId=', selectedAiTabId, 'aiSourceTarget=', aiSourceTarget ? aiSourceTarget.id : null);

    try {
      chrome.runtime.sendMessage({
        action: 'checkAiTabStreaming',
        targetTabId: selectedAiTabId
      }, function(res) {
        var runtimeError = chrome.runtime.lastError;

        _streamingCheckBusy = false;

        if (runtimeError) {
          console.log('[AI-STREAM-REMOTE-ERR]', runtimeError.message);
          updateStreamingState(false);
          return;
        }

        console.log('[AI-STREAM-REMOTE-RES]', res);

        if (!res || !res.ok) {
          updateStreamingState(false);
          return;
        }

        updateStreamingState(!!res.streaming);
      });
    } catch (e) {
      console.log('[AI-STREAM-REMOTE-THROW]', e && e.message ? e.message : e);
      _streamingCheckBusy = false;
      updateStreamingState(false);
    }
  }

  checkStreaming();
  setInterval(checkStreaming, 1500);

  syncBridgeTargetPickerVisibility();
}

// ────────────────────────────────────────
// TG 위젯 (TG→AI 전용)
// ────────────────────────────────────────
function injectTGWidget() {
  if (document.getElementById('ctb-tg-panel')) return;

  // CSS 주입 (최초 1회)
  if (!document.getElementById('ctb-bridge-style')) {
    const style = document.createElement('style');
    style.id = 'ctb-bridge-style';
    style.textContent = PANEL_STYLES;
    document.head.appendChild(style);
  }

  const panel = document.createElement('div');
  panel.id = 'ctb-tg-panel';
  panel.innerHTML = `
    <div id="ctb-tg-title">
      <span id="ctb-tg-title-text">📥 → AI</span>
      <div id="ctb-tg-controls">
        <button id="ctb-tg-minimize" title="최소화">−</button>
        <button id="ctb-tg-refresh" title="새로고침">↺</button>
        <button id="ctb-tg-close" title="닫기">✕</button>
      </div>
    </div>
    <div id="ctb-body">
      <button id="ctb-tg-btn2" class="ctb-btn">📥 → GPT</button>
      <div id="ctb-tgmode-row">
        <button id="ctb-tgmode-all" class="ctb-mode-btn ctb-mode-active">답변전체</button>
        <button id="ctb-tgmode-last" class="ctb-mode-btn">마지막1개</button>
      </div>
      <select id="ctb-ai-select" style="width:100%;margin-bottom:5px;padding:2px;font-size:9px;background:#2a2a55;color:#a78bfa;border:1px solid #3a3a5c;border-radius:5px;"><option value="">탭 목록 받는 중...</option></select>
      <div id="ctb-tg-current-tab-label" style="display:none;width:100%;margin-bottom:5px;padding:3px 4px;font-size:9px;background:#2a2a55;color:#a78bfa;border:1px solid #3a3a5c;border-radius:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div><label id="ctb-tg-autosend-label" style="display:flex !important;align-items:center;gap:4px;margin-top:2px;cursor:pointer">
        <input type="checkbox" id="ctb-tg-autosend" checked style="width:13px;height:13px;opacity:1;display:inline;flex-shrink:0;position:static;appearance:auto;accent-color:#2AABEE" />
        <span>전송까지 자동으로</span>
      </label>
      <button id="ctb-tg-switch" class="ctb-switch-btn">🔁 위젯 전환</button>
      <div id="ctb-status"></div>
    </div>
  `;

  document.body.appendChild(panel);

  // ── 위치 복원 ──
  chrome.storage.local.get(['widgetPos_tg'], (res) => {
    if (res?.widgetPos_tg) {
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      panel.style.left = res.widgetPos_tg.left + 'px';
      panel.style.top  = res.widgetPos_tg.top  + 'px';
    }
  });

  makeDraggable(panel, '#ctb-tg-title', 'widgetPos_tg');

  // ── 최소화/복원 ──
  let isMinimized = false;
  const bodyEl = panel.querySelector('#ctb-body');
  const controlsEl = panel.querySelector('#ctb-tg-controls');
  const titleTextEl = panel.querySelector('#ctb-tg-title-text');

  function minimize() {
    isMinimized = true;
    bodyEl.style.display = 'none';
    controlsEl.style.display = 'none';
    panel.style.width = '36px'; panel.style.height = '36px';
    panel.style.borderRadius = '50%'; panel.style.padding = '0';
    panel.style.display = 'flex'; panel.style.justifyContent = 'center'; panel.style.alignItems = 'center';
    panel.style.cursor = 'pointer';
    panel.querySelector('#ctb-tg-title').style.marginBottom = '0';
    panel.querySelector('#ctb-tg-title').style.cursor = 'pointer';
    titleTextEl.style.fontSize = '18px';
    titleTextEl.textContent = '📥';
  }

  function restore() {
    isMinimized = false;
    bodyEl.style.display = '';
    controlsEl.style.display = '';
    panel.style.width = '110px'; panel.style.height = '';
    panel.style.borderRadius = '12px'; panel.style.padding = '9px 10px';
    panel.style.display = ''; panel.style.justifyContent = ''; panel.style.alignItems = '';
    panel.style.cursor = '';
    panel.querySelector('#ctb-tg-title').style.marginBottom = '7px';
    panel.querySelector('#ctb-tg-title').style.cursor = 'grab';
    titleTextEl.style.fontSize = '10px';
    titleTextEl.textContent = '📥 → AI';
  }

  panel.querySelector('#ctb-tg-minimize').addEventListener('click', (e) => { e.stopPropagation(); minimize(); });
  panel.querySelector('#ctb-tg-refresh').addEventListener('click', (e) => {
    e.stopPropagation();
    runBridgeRefreshHandler('tgTarget', function() {
      syncBridgeTargetPickerVisibility();
      setStatus('\u21BA \uC0C8\uB85C\uACE0\uCE68 \uC644\uB8CC', 'ok');
    });
  });
  panel.addEventListener('click', () => { if (isMinimized) restore(); });
  panel.querySelector('#ctb-tg-close').addEventListener('click', (e) => { e.stopPropagation(); panel.style.display = 'none'; });

  // ── AI 탭 동적 선택 ──
  const SITE_COLORS = { chatgpt: '#10A37F', claude: '#D97757', gemini: '#EA4335' };
  let aiTarget = null;
  const aiSelect = panel.querySelector('#ctb-ai-select');
  const tgCurrentTabLabel = panel.querySelector('#ctb-tg-current-tab-label');
  const tgBtn2 = panel.querySelector('#ctb-tg-btn2');
  const isCurrentPageAIForTG = SITE === 'chatgpt' || SITE === 'claude' || SITE === 'gemini';
  var applyAI = function(tabInfo) {
    aiTarget = tabInfo;
    var siteName = tabInfo ? (tabInfo.siteName || 'AI') : 'AI';
    tgBtn2.textContent = '\u{1F4E5} \u2192 ' + siteName;
    tgBtn2.style.background = tabInfo && SITE_COLORS[tabInfo.site] ? SITE_COLORS[tabInfo.site] : '#a78bfa';
    tgBtn2.title = tabInfo ? tabInfo.title : '';
  };
  var updateTGTargetPanelUI = function() {
    if (isCurrentPageAIForTG) {
      if (aiSelect) aiSelect.style.display = 'none';
      if (tgCurrentTabLabel) {
        var currentTitle = document.title || SITE_NAME || '현재 AI 탭';
        tgCurrentTabLabel.style.display = 'block';
        tgCurrentTabLabel.textContent = currentTitle;
        tgCurrentTabLabel.title = currentTitle;
      }
    } else {
      if (aiSelect) aiSelect.style.display = '';
      if (tgCurrentTabLabel) { tgCurrentTabLabel.style.display = 'none'; tgCurrentTabLabel.textContent = ''; tgCurrentTabLabel.title = ''; }
    }
  };

  var refreshAiTabs = function() {
    try {
      chrome.runtime.sendMessage({ action: 'getAiTabs' }, function(res) {
        if (!res || !res.tabs || !res.tabs.length) {
          aiSelect.innerHTML = '<option value="">AI 탭 없음</option>';
          applyAI(null);
          updateTGTargetPanelUI();
          return;
        }
        var tabs = res.tabs;
        var previousTargetId = aiTarget ? Number(aiTarget.id) : null;
        var senderTabId = res.senderTabId ? Number(res.senderTabId) : null;
        aiSelect.innerHTML = '';
        tabs.forEach(function(t) {
          var site = 'ai', siteName = 'AI';
          if (t.url.indexOf('chatgpt.com') >= 0 || t.url.indexOf('chat.openai.com') >= 0) { site = 'chatgpt'; siteName = 'ChatGPT'; }
          else if (t.url.indexOf('claude.ai') >= 0) { site = 'claude'; siteName = 'Claude'; }
          else if (t.url.indexOf('gemini.google.com') >= 0) { site = 'gemini'; siteName = 'Gemini'; }
          var o = document.createElement('option');
          o.value = String(t.id); o.textContent = t.title || siteName;
          o.title = t.title || siteName;
          o.dataset.site = site; o.dataset.siteName = siteName;
          aiSelect.appendChild(o);
        });
        var selectedTabId = null;
        if (isCurrentPageAIForTG && senderTabId && tabs.some(function(tx) { return Number(tx.id) === senderTabId; })) {
          selectedTabId = senderTabId;
        } else if (previousTargetId && tabs.some(function(tx) { return Number(tx.id) === previousTargetId; })) {
          selectedTabId = previousTargetId;
        } else {
          selectedTabId = Number(tabs[0].id);
        }
        aiSelect.value = String(selectedTabId);
        var selectedOption = Array.from(aiSelect.options).find(function(x) { return Number(x.value) === selectedTabId; });
        var selectedTab = tabs.find(function(x) { return Number(x.id) === selectedTabId; });
        if (selectedOption && selectedTab) {
          applyAI({ site: selectedOption.dataset.site, siteName: selectedOption.dataset.siteName, title: selectedTab.title || selectedOption.textContent, id: selectedTab.id });
        }
        updateTGTargetPanelUI();
      });
    } catch(e) {
      aiSelect.innerHTML = '<option value="">AI 탭 오류</option>';
      applyAI(null);
      updateTGTargetPanelUI();
    }
  };

  refreshAiTabs();
  registerBridgeRefreshHandler('tgTarget', refreshAiTabs);

  aiSelect.addEventListener('change', function() {
    var sel = this.options[this.selectedIndex];
    if (sel && sel.value) {
      applyAI({ site: sel.dataset.site, siteName: sel.dataset.siteName, title: sel.title || sel.textContent, id: Number(sel.value) });
    }
  });


  // ── TG→AI 모드 토글 ──
  const modAllBtn = panel.querySelector('#ctb-tgmode-all');
  const modLastBtn = panel.querySelector('#ctb-tgmode-last');
  const applyTGMode = (mode) => {
    if (mode === 'all') {
      tgCopyMode = 'all';
      modAllBtn.classList.add('ctb-mode-active');
      modLastBtn.classList.remove('ctb-mode-active');
    } else {
      tgCopyMode = 'last';
      modLastBtn.classList.add('ctb-mode-active');
      modAllBtn.classList.remove('ctb-mode-active');
    }
  };
  chrome.storage.local.get(['bridge_tgmode'], (res) => {
    if (res?.bridge_tgmode) applyTGMode(res.bridge_tgmode);
  });
  modAllBtn.addEventListener('click', () => {
    tgCopyMode = 'all'; chrome.storage.local.set({ bridge_tgmode: 'all' });
    modAllBtn.classList.add('ctb-mode-active');
    modLastBtn.classList.remove('ctb-mode-active');
  });
  modLastBtn.addEventListener('click', () => {
    tgCopyMode = 'last'; chrome.storage.local.set({ bridge_tgmode: 'last' });
    modLastBtn.classList.add('ctb-mode-active');
    modAllBtn.classList.remove('ctb-mode-active');
  });

  // ── 상태 표시 ──
  const statusEl = panel.querySelector('#ctb-status');
  const btn2 = panel.querySelector('#ctb-tg-btn2');
  const autoCheck = panel.querySelector('#ctb-tg-autosend');
  chrome.storage.local.get(['bridge_autosend_tg'], (res) => {
    if (res?.bridge_autosend_tg !== undefined) autoCheck.checked = res.bridge_autosend_tg;
  });
  autoCheck.addEventListener('change', () => {
    chrome.storage.local.set({ bridge_autosend_tg: autoCheck.checked });
  });
  const setStatus = (msg, type) => setPanelStatus(statusEl, msg, type);
  const setBtnsDisabled = (v) => setPanelBtnsDisabled([btn2], v);

  // ── CHECKBOX 진단 ──
  const tgChk = panel.querySelector('#ctb-tg-autosend');
  if (tgChk) {
    const r = tgChk.getBoundingClientRect();
    const cs = getComputedStyle(tgChk);
    console.log('[TG-CHK] found=', !!tgChk, 'rect=', r.width, r.height, 'display=', cs.display, 'visibility=', cs.visibility, 'opacity=', cs.opacity, 'position=', cs.position);
  } else {
    console.log('[TG-CHK] NOT FOUND in panel!');
  }

  // ── Telegram → AI ──
  btn2.addEventListener('click', () => {
    const autoSend = autoCheck.checked;
    setBtnsDisabled(true);
    setStatus('⏳ 처리 중...');
    chrome.runtime.sendMessage({ action: 'telegramToAI', autoSend, tgCopyMode, aiTarget, targetTabId: isCurrentPageAIForTG ? null : (aiTarget ? aiTarget.id : null) }, (res) => {
      setBtnsDisabled(false);
      if (chrome.runtime.lastError) { setStatus(`❌ ${chrome.runtime.lastError.message}`, 'err'); return; }
      if (res?.ok) setStatus(autoSend ? '✅ AI 전송!' : '✅ AI 입력!', 'ok');
      else         setStatus(`❌ ${res?.error || '실패'}`, 'err');
    });
  });

  // ── 위젯 스위치 ──
  panel.querySelector('#ctb-tg-switch').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleOtherWidget();
  });

  syncBridgeTargetPickerVisibility();
}

// ────────────────────────────────────────
// 토큰 카운터
// ────────────────────────────────────────
function injectTokenCounter() {
  if (document.getElementById('ctb-token-counter')) return;
  const counter = document.createElement('div');
  counter.id = 'ctb-token-counter';
  document.body.appendChild(counter);

  function update() {
    const input = getInputEl();
    if (!input) { counter.textContent = ''; return; }
    const rect   = input.getBoundingClientRect();
    const text   = input.innerText || input.value || '';
    const tokens = estimateTokens(text);
    if (!text.trim()) { counter.textContent = ''; return; }
    counter.style.left = (rect.right - 65 + window.scrollX) + 'px';
    counter.style.top  = (rect.bottom - 18 + window.scrollY) + 'px';
    counter.textContent = `~${tokens} tokens`;
    counter.className = tokens > 3000 ? 'danger' : tokens > 1500 ? 'warn' : '';
  }

  document.addEventListener('input', update, true);
  setInterval(update, 800);
}

// ────────────────────────────────────────
// 메시지 리스너
// ────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'getResponse') {
    sendResponse({ text: getResponse() });
    return true;
  }
  if (msg.action === 'checkStreaming') {
    sendResponse({ streaming: isStreaming() });
    return true;
  }
  if (msg.action === 'pasteToAI') {
    pasteToAI(msg.text, msg.autoSend).then(sendResponse);
    return true;
  }
  if (msg.action === 'getTelegramMessage') {
    sendResponse({ text: telegram_getMessageForMode(msg.tgCopyMode || 'all') });
    return true;
  }
  if (msg.action === 'sendToTelegram') {
    telegram_sendMessage(msg.text, msg.autoSend).then(sendResponse);
    return true;
  }
});

// ── 위젯 스위치 탭 간 동기화 ──
chrome.storage.onChanged.addListener((changes) => {
  if (changes?.bridge_mode) {
    copyMode = changes.bridge_mode.newValue;
    document.querySelectorAll('#ctb-ai-mode-full, #ctb-ai-mode-code').forEach(b => {
      b.classList.toggle('ctb-mode-active',
        (b.id === 'ctb-ai-mode-full' && copyMode === 'full') ||
        (b.id === 'ctb-ai-mode-code' && copyMode === 'code'));
    });
  }
  if (changes?.bridge_tgmode) {
    tgCopyMode = changes.bridge_tgmode.newValue;
    document.querySelectorAll('#ctb-tgmode-all, #ctb-tgmode-last').forEach(b => {
      b.classList.toggle('ctb-mode-active',
        (b.id === 'ctb-tgmode-all' && tgCopyMode === 'all') ||
        (b.id === 'ctb-tgmode-last' && tgCopyMode === 'last'));
    });
  }
  if (changes?.widget_state) {
    applyState(changes.widget_state.newValue || 'normal', true);
  }
  console.log('[ONCHANGED] full keys=', JSON.stringify(Object.keys(changes||{})));
});

// ── 위젯 상태 적용 ──
function applyState(state, keepPosition) {
  var ai = document.getElementById('ctb-ai-panel');
  var tg = document.getElementById('ctb-tg-panel');
  if (!ai || !tg) return;

  var isTG = location.hostname.indexOf('web.telegram.org') >= 0;
  var showAI = (state === 'swapped') ? isTG : !isTG;

  var currentPanel = null;
  if (getComputedStyle(ai).display !== 'none') {
    currentPanel = ai;
  } else if (getComputedStyle(tg).display !== 'none') {
    currentPanel = tg;
  }

  var nextPanel = showAI ? ai : tg;
  var nextStorageKey = showAI ? 'widgetPos_ai' : 'widgetPos_tg';

  console.log('[APPLYSTATE] state=', state, ' isTG=', isTG, ' showAI=', showAI, 'keepPosition=', !!keepPosition);

  if (keepPosition && currentPanel && currentPanel !== nextPanel) {
    copyPanelPosition(currentPanel, nextPanel, nextStorageKey);
  }

  if (showAI) {
    ai.style.display = '';
    tg.style.display = 'none';
  } else {
    tg.style.display = '';
    ai.style.display = 'none';
  }

  syncBridgeTargetPickerVisibility();
}

// ── 위젯 스위치 ──
function toggleOtherWidget() {
  console.log('[TOGGLE] called');
  const aiPanel = document.getElementById('ctb-ai-panel');
  const tgPanel = document.getElementById('ctb-tg-panel');
  if (!aiPanel || !tgPanel) return;
  chrome.storage.local.get(['widget_state'], function(res) {
    var current = res && res.widget_state === 'swapped' ? 'swapped' : 'normal';
    var next = current === 'normal' ? 'swapped' : 'normal';
    applyState(next, true);
    chrome.storage.local.set({ widget_state: next });
  });
}

// ── 사이트별 위젯 주입 ──
if (SITE === 'telegram' || SITE) {
  const onReady = () => {
    console.log("[Bridge] SITE=", SITE, "readyState=", document.readyState, "body=", !!document.body);
    injectAIWidget();
    injectTGWidget();
    injectTokenCounter();

    chrome.storage.local.get(['widget_state'], (res) => {
      console.log('[INIT] widget_state=', res?.widget_state, 'SITE=', SITE);
      applyState(res?.widget_state || 'normal');
    });
  };

  if (document.readyState !== 'loading') { onReady(); }
  else { document.addEventListener('DOMContentLoaded', onReady); }
}

})();