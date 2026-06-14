// background.js v5.0
// AI ↔ Telegram Bridge
// web.telegram.org DOM 방식으로 전송 (유저 계정으로 봇에 전달)

async function findTab(pattern) {
  const tabs = await chrome.tabs.query({ url: pattern });
  return tabs[0] || null;
}

async function findTelegramTab() {
  return findTab('https://web.telegram.org/*');
}

function isAiUrl(url) {
  if (!url) return false;
  return url.indexOf('https://chatgpt.com/') >= 0 || url.indexOf('https://chat.openai.com/') >= 0 ||
         url.indexOf('https://claude.ai/') >= 0 || url.indexOf('https://gemini.google.com/') >= 0;
}

async function findFirstAiTab() {
  const tabs = await chrome.tabs.query({
    url: ['https://chatgpt.com/*','https://chat.openai.com/*','https://claude.ai/*','https://gemini.google.com/*']
  });
  return tabs[0] || null;
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await new Promise(r => setTimeout(r, 300));
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (e2) {
      throw new Error('탭에 연결할 수 없어요: ' + e2.message);
    }
  }
}

// AI → Telegram
async function handleAiToTelegram(senderTabId, autoSend, targetTabId) {
  let aiTab = null;
  if (targetTabId) {
    try { var target = await chrome.tabs.get(targetTabId); if (target && isAiUrl(target.url)) aiTab = target; } catch(e) {}
  }
  if (!aiTab && senderTabId) {
    try { var sender = await chrome.tabs.get(senderTabId); if (sender && isAiUrl(sender.url)) aiTab = sender; } catch(e) {}
  }
  if (!aiTab) aiTab = await findFirstAiTab();
  if (!aiTab) return { ok: false, error: 'AI 탭을 찾을 수 없습니다.' };

  const streamRes = await sendToTab(aiTab.id, { action: 'checkStreaming' }).catch(() => null);
  if (streamRes?.streaming) return { ok: false, error: 'AI가 아직 답변 중이에요.' };

  const aiRes = await sendToTab(aiTab.id, { action: 'getResponse' });
  if (!aiRes?.text) return { ok: false, error: 'AI 응답을 찾을 수 없어요.' };
  const tgTab = await findTelegramTab();
  if (!tgTab) return { ok: false, error: 'web.telegram.org 탭을 열고 봇 채팅방을 선택해주세요.' };
  return sendToTab(tgTab.id, { action: 'sendToTelegram', text: aiRes.text, autoSend });
}

// Telegram → AI
async function findAiTab(aiTarget) {
  const patterns = { chatgpt: 'https://chatgpt.com/*', claude: 'https://claude.ai/*', gemini: 'https://gemini.google.com/*' };
  var key = typeof aiTarget === 'string' ? aiTarget : (aiTarget && aiTarget.site ? aiTarget.site : null);
  var pattern = key ? (patterns[key] || 'https://chatgpt.com/*') : 'https://chatgpt.com/*';
  return findTab(pattern);
}

async function handleTelegramToAi(senderTabId, autoSend, tgCopyMode, aiTarget, targetTabId) {
  const tgTab = await findTelegramTab();
  if (!tgTab) return { ok: false, error: 'web.telegram.org 탭을 열고 봇 채팅방을 선택해주세요.' };
  var aiTab = null;
  if (targetTabId) {
    try {
      const target = await chrome.tabs.get(targetTabId);
      if (target && isAiUrl(target.url)) aiTab = target;
    } catch(e) { aiTab = null; }
  }
  if (!aiTab && senderTabId) {
    try {
      const senderTab = await chrome.tabs.get(senderTabId);
      if (senderTab && isAiUrl(senderTab.url)) aiTab = senderTab;
    } catch(e) { aiTab = null; }
  }
  if (!aiTab) {
    aiTab = await findAiTab(aiTarget || 'chatgpt');
  }
  if (!aiTab) return { ok: false, error: 'AI 탭을 찾을 수 없습니다.' };

  const tgRes = await sendToTab(tgTab.id, { action: 'getTelegramMessage', tgCopyMode: tgCopyMode || 'all' });
  if (!tgRes?.text) return { ok: false, error: 'Telegram 메시지를 찾을 수 없어요.' };

  return sendToTab(aiTab.id, { action: 'pasteToAI', text: tgRes.text, autoSend });
}



// ────────────────────────────────────────
// DeepSeek API 잔액 모니터
// ────────────────────────────────────────
const DEEPSEEK_BALANCE_ENDPOINT = 'https://api.deepseek.com/user/balance';
const DEEPSEEK_BALANCE_ALARM = 'deepseek-balance-1m';
const DEEPSEEK_API_KEY_KEY = 'bridge_deepseek_api_key';
const DEEPSEEK_BALANCE_STATE_KEY = 'bridge_deepseek_balance_state';
const DEEPSEEK_USAGE_HISTORY_KEY = 'bridge_deepseek_usage_history';
const DEEPSEEK_USAGE_HISTORY_LIMIT = 50;

function bridgeStorageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function bridgeStorageSet(values) {
  return new Promise(resolve => chrome.storage.local.set(values, resolve));
}

function pickDeepSeekBalanceInfo(balanceInfos) {
  if (!Array.isArray(balanceInfos) || !balanceInfos.length) return null;
  const usd = balanceInfos.find(function(info) {
    return info && info.currency === 'USD';
  });
  return usd || balanceInfos[0] || null;
}

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000000) / 1000000;
}

function createDeepSeekBalanceStatePatch(patch) {
  return Object.assign({
    configured: false,
    status: 'idle',
    currency: 'USD',
    amount: null,
    isAvailable: false,
    updatedAt: Date.now(),
    error: ''
  }, patch || {});
}

async function fetchDeepSeekBalance() {
  const store = await bridgeStorageGet([
    DEEPSEEK_API_KEY_KEY,
    DEEPSEEK_BALANCE_STATE_KEY,
    DEEPSEEK_USAGE_HISTORY_KEY
  ]);

  const apiKey = (store[DEEPSEEK_API_KEY_KEY] || '').trim();
  const previousState = store[DEEPSEEK_BALANCE_STATE_KEY] || null;
  const previousHistory = Array.isArray(store[DEEPSEEK_USAGE_HISTORY_KEY])
    ? store[DEEPSEEK_USAGE_HISTORY_KEY]
    : [];

  if (!apiKey) {
    const noKeyState = createDeepSeekBalanceStatePatch({
      configured: false,
      status: 'no_key',
      amount: null,
      error: 'API 키 없음'
    });

    await bridgeStorageSet({
      [DEEPSEEK_BALANCE_STATE_KEY]: noKeyState
    });

    return {
      ok: false,
      error: 'API 키 없음',
      state: noKeyState,
      history: previousHistory
    };
  }

  try {
    const response = await fetch(DEEPSEEK_BALANCE_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }

    const json = await response.json();
    const info = pickDeepSeekBalanceInfo(json.balance_infos);

    if (!info) {
      throw new Error('잔액 정보 없음');
    }

    const currency = info.currency || 'USD';
    const currentAmount = roundMoney(info.total_balance);
    const now = Date.now();

    const nextState = createDeepSeekBalanceStatePatch({
      configured: true,
      status: 'ok',
      currency: currency,
      amount: currentAmount,
      isAvailable: !!json.is_available,
      updatedAt: now,
      error: ''
    });

    let nextHistory = previousHistory.slice(0, DEEPSEEK_USAGE_HISTORY_LIMIT);

    if (
      previousState &&
      previousState.status === 'ok' &&
      previousState.currency === currency &&
      Number.isFinite(Number(previousState.amount)) &&
      Number(previousState.amount) > currentAmount
    ) {
      const usedAmount = roundMoney(Number(previousState.amount) - currentAmount);

      if (usedAmount > 0) {
        nextHistory = [{
          amount: usedAmount,
          currency: currency,
          timestamp: now,
          previousAmount: roundMoney(previousState.amount),
          currentAmount: currentAmount
        }].concat(nextHistory).slice(0, DEEPSEEK_USAGE_HISTORY_LIMIT);
      }
    }

    await bridgeStorageSet({
      [DEEPSEEK_BALANCE_STATE_KEY]: nextState,
      [DEEPSEEK_USAGE_HISTORY_KEY]: nextHistory
    });

    return {
      ok: true,
      state: nextState,
      history: nextHistory
    };
  } catch (e) {
    const errorState = createDeepSeekBalanceStatePatch({
      configured: true,
      status: 'error',
      currency: previousState && previousState.currency ? previousState.currency : 'USD',
      amount: previousState && Number.isFinite(Number(previousState.amount)) ? Number(previousState.amount) : null,
      isAvailable: previousState ? !!previousState.isAvailable : false,
      updatedAt: Date.now(),
      error: e && e.message ? e.message : String(e)
    });

    await bridgeStorageSet({
      [DEEPSEEK_BALANCE_STATE_KEY]: errorState
    });

    return {
      ok: false,
      error: errorState.error,
      state: errorState,
      history: previousHistory
    };
  }
}

function ensureDeepSeekBalanceAlarm() {
  if (!chrome.alarms || !chrome.alarms.create) return;

  chrome.alarms.create(DEEPSEEK_BALANCE_ALARM, {
    periodInMinutes: 1
  });
}

ensureDeepSeekBalanceAlarm();

if (chrome.runtime && chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(function() {
    ensureDeepSeekBalanceAlarm();
    fetchDeepSeekBalance().catch(function() {});
  });
}

if (chrome.runtime && chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(function() {
    ensureDeepSeekBalanceAlarm();
    fetchDeepSeekBalance().catch(function() {});
  });
}

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener(function(alarm) {
    if (alarm && alarm.name === DEEPSEEK_BALANCE_ALARM) {
      fetchDeepSeekBalance().catch(function() {});
    }
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const aiTabId = sender.tab?.id;

  if (msg.action === 'getAiTabs') {
    var sId = sender.tab ? sender.tab.id : null;
    chrome.tabs.query({ url: ['https://chatgpt.com/*','https://chat.openai.com/*','https://claude.ai/*','https://gemini.google.com/*'] }, (tabs) => {
      var mapped = tabs.map(function(t){ return { id: t.id, title: t.title, url: t.url }; });
      mapped.sort(function(a,b){ if (a.id === sId) return -1; if (b.id === sId) return 1; return 0; });
      sendResponse({ tabs: mapped, senderTabId: sId });
    });
    return true;
  }

  if (msg.action === 'checkAiTabStreaming') {
    (async () => {
      let aiTab = null;

      if (msg.targetTabId) {
        try {
          const target = await chrome.tabs.get(msg.targetTabId);
          if (target && isAiUrl(target.url)) {
            aiTab = target;
          }
        } catch (e) {
          aiTab = null;
        }
      }

      if (!aiTab && sender.tab?.id) {
        try {
          const senderTab = await chrome.tabs.get(sender.tab.id);
          if (senderTab && isAiUrl(senderTab.url)) {
            aiTab = senderTab;
          }
        } catch (e) {
          aiTab = null;
        }
      }

      if (!aiTab) {
        aiTab = await findFirstAiTab();
      }

      if (!aiTab) {
        sendResponse({
          ok: false,
          streaming: false,
          error: 'AI 탭을 찾을 수 없습니다.'
        });
        return;
      }

      const streamRes = await sendToTab(aiTab.id, { action: 'checkStreaming' }).catch(() => null);

      sendResponse({
        ok: true,
        streaming: !!streamRes?.streaming,
        tabId: aiTab.id,
        title: aiTab.title || ''
      });
    })();

    return true;
  }

  if (msg.action === 'aiToTelegram') {
    handleAiToTelegram(aiTabId, msg.autoSend, msg.targetTabId)
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.action === 'telegramToAI') {
    handleTelegramToAi(aiTabId, msg.autoSend, msg.tgCopyMode, msg.aiTarget, msg.targetTabId)
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});
