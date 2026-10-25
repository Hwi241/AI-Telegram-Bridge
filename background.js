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

function getAiSourceSite(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return '';
    if (
      parsed.hostname === 'chatgpt.com' ||
      parsed.hostname === 'chat.openai.com'
    ) return 'chatgpt';
    if (parsed.hostname === 'claude.ai') return 'claude';
    if (parsed.hostname === 'gemini.google.com') return 'gemini';
  } catch (e) {}
  return '';
}

function isAiSourceUrl(url) {
  return !!getAiSourceSite(url);
}

function isAiUrl(url) {
  return isAiSourceUrl(url);
}

function isTelegramDestinationUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'web.telegram.org';
  } catch (e) {
    return false;
  }
}

async function findFirstAiTab() {
  const tabs = await chrome.tabs.query({
    url: ['https://chatgpt.com/*','https://chat.openai.com/*','https://claude.ai/*','https://gemini.google.com/*']
  });
  return tabs[0] || null;
}

function normalizeTabSourceUrl(value) {
  try {
    const url = new URL(value);
    return url.origin + url.pathname;
  } catch (e) {
    return '';
  }
}

async function resolveAiSourceTab(request, senderTabId) {
  const sourceAiTabId =
    Number(request?.sourceAiTabId || 0);

  const sourceAiUrl =
    normalizeTabSourceUrl(
      request?.sourceAiUrl || ''
    );

  const sourceAiTitle =
    String(
      request?.sourceAiTitle || ''
    ).trim();

  /*
   * Telegram 페이지에서 AI→Telegram을 누른 경우에는
   * 반드시 명시적으로 선택한 AI tab을 source로 사용한다.
   *
   * tab ID가 아직 유효하고 AI URL이며,
   * 저장된 source URL과도 일치하면 그 tab을 사용한다.
   */
  if (sourceAiTabId) {
    try {
      const selected =
        await chrome.tabs.get(
          sourceAiTabId
        );

      if (
        selected &&
        isAiSourceUrl(selected.url)
      ) {
        const selectedUrl =
          normalizeTabSourceUrl(
            selected.url
          );

        if (
          !sourceAiUrl ||
          selectedUrl === sourceAiUrl
        ) {
          return selected;
        }
      }
    } catch (e) {}

    /*
     * tab ID가 stale 되었거나,
     * ID는 존재하지만 저장된 대화 URL과 달라졌다면
     * ID를 그대로 신뢰하지 않는다.
     *
     * 저장된 AI conversation URL로만 복구한다.
     */
    if (!sourceAiUrl) {
      return null;
    }

    const openAiTabs =
      await chrome.tabs.query({
        url: [
          'https://chatgpt.com/*',
          'https://chat.openai.com/*',
          'https://claude.ai/*',
          'https://gemini.google.com/*'
        ]
      });

    const urlMatches =
      openAiTabs.filter(function(tab) {
        return (
          tab &&
          isAiSourceUrl(tab.url) &&
          normalizeTabSourceUrl(
            tab.url
          ) === sourceAiUrl
        );
      });

    if (urlMatches.length === 1) {
      return urlMatches[0];
    }

    if (
      urlMatches.length > 1 &&
      sourceAiTitle
    ) {
      const titleMatches =
        urlMatches.filter(function(tab) {
          return (
            String(tab.title || '').trim() ===
            sourceAiTitle
          );
        });

      if (titleMatches.length === 1) {
        return titleMatches[0];
      }
    }

    return null;
  }

  /*
   * 명시 source가 없는 경우에는
   * 현재 sender 자체가 AI 페이지일 때만 허용한다.
   *
   * Telegram sender는 절대로 fallback source가 될 수 없다.
   */
  if (senderTabId) {
    try {
      const senderTab =
        await chrome.tabs.get(
          senderTabId
        );

      if (
        senderTab &&
        isAiSourceUrl(senderTab.url)
      ) {
        return senderTab;
      }
    } catch (e) {}
  }

  return null;
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

async function captureChatgptCodeByCopyButton(tabId) {
  const results =
    await chrome.scripting.executeScript({
      target: {
        tabId: tabId
      },
      world: 'MAIN',
      func: async function() {
        const sleep =
          function(ms) {
            return new Promise(function(resolve) {
              setTimeout(resolve, ms);
            });
          };

        const normalize =
          function(value) {
            return String(value || '')
              .replace(/\r\n/g, '\n')
              .replace(/\r/g, '\n');
          };

        const assistantCandidates =
          Array.from(
            document.querySelectorAll(
              '[data-chatgpt-search-unit-key$=":assistant"][data-chatgpt-search-message-ids], ' +
              'section[data-turn="assistant"], ' +
              '[data-message-author-role="assistant"]'
            )
          ).filter(function(node) {
            return node && node.isConnected;
          });

        if (!assistantCandidates.length) {
          return {
            ok: false,
            error:
              'ChatGPT 최신 답변을 찾을 수 없습니다.'
          };
        }

        const assistant =
          assistantCandidates[
            assistantCandidates.length - 1
          ];

        const turn =
          assistant.closest('[data-turn-key]') ||
          assistant.closest(
            '[data-testid^="conversation-turn-"]'
          ) ||
          assistant.closest('article') ||
          assistant;

        const blocks =
          Array.from(
            turn.querySelectorAll(
              '[data-markdown-copy="code-block"]'
            )
          ).filter(function(node) {
            return node && node.isConnected;
          });

        if (!blocks.length) {
          return {
            ok: false,
            error:
              '최신 ChatGPT 답변에서 코드박스를 찾을 수 없습니다.'
          };
        }

        const block =
          blocks[blocks.length - 1];

        const exactSelectors = [
          'button[data-testid="copy-code-button"]',
          '[data-testid="copy-code-button"]',
          'button[aria-label*="Copy code" i]',
          'button[aria-label*="코드 복사"]',
          'button[title*="Copy code" i]',
          'button[title*="코드 복사"]'
        ];

        let copyButton = null;

        for (const selector of exactSelectors) {
          const candidate =
            block.querySelector(selector);

          if (candidate) {
            copyButton = candidate;
            break;
          }
        }

        if (!copyButton) {
          copyButton =
            Array.from(
              block.querySelectorAll('button')
            ).find(function(button) {
              const label =
                [
                  button.getAttribute(
                    'aria-label'
                  ),
                  button.getAttribute('title'),
                  button.getAttribute(
                    'data-testid'
                  ),
                  button.textContent
                ]
                  .filter(Boolean)
                  .join(' ')
                  .toLowerCase();

              return (
                label.includes('copy') ||
                label.includes('복사')
              );
            }) || null;
        }

        if (!copyButton) {
          return {
            ok: false,
            error:
              'ChatGPT 코드박스의 복사 버튼을 찾을 수 없습니다.'
          };
        }

        let capturedText = '';

        const onCopy =
          function(event) {
            try {
              const copied =
                event.clipboardData?.getData(
                  'text/plain'
                );

              if (copied) {
                capturedText =
                  normalize(copied);
              }
            } catch (e) {}
          };

        document.addEventListener(
          'copy',
          onCopy,
          true
        );

        const clipboard =
          navigator.clipboard;

        const clipboardProto =
          clipboard
            ? Object.getPrototypeOf(
                clipboard
              )
            : null;

        const originalWriteText =
          clipboardProto &&
          typeof clipboardProto.writeText ===
            'function'
            ? clipboardProto.writeText
            : null;

        let writeHooked = false;

        if (
          clipboardProto &&
          originalWriteText
        ) {
          try {
            clipboardProto.writeText =
              function(value) {
                capturedText =
                  normalize(value);

                return Promise.resolve();
              };

            writeHooked = true;
          } catch (e) {}
        }

        try {
          copyButton.click();

          const deadline =
            Date.now() + 1500;

          while (
            !capturedText &&
            Date.now() < deadline
          ) {
            await sleep(50);
          }
        } finally {
          document.removeEventListener(
            'copy',
            onCopy,
            true
          );

          if (
            writeHooked &&
            clipboardProto &&
            originalWriteText
          ) {
            try {
              clipboardProto.writeText =
                originalWriteText;
            } catch (e) {}
          }
        }

        if (!capturedText) {
          return {
            ok: false,
            error:
              'ChatGPT 복사 버튼은 눌렀지만 전체 코드 값을 가져오지 못했습니다.'
          };
        }

        return {
          ok: true,
          text: capturedText
        };
      }
    });

  const result =
    results?.[0]?.result;

  if (!result?.ok) {
    throw new Error(
      result?.error ||
      'ChatGPT 코드 복사에 실패했습니다.'
    );
  }

  return result.text;
}

const CTB_RETURN_VERSION = '061-8';
const CTB_RETURN_KEY = 'bridge_auto_return_routes';

let ctbReturnDeliveryBusy = false;

function ctbReturnConversationUrl(value) {
  try {
    const url = new URL(value);

    if (
      url.protocol !== 'https:' ||
      !['chatgpt.com', 'chat.openai.com'].includes(url.hostname)
    ) {
      return '';
    }

    const path = url.pathname.replace(/\/$/, '');

    if (!/(?:^|\/)c\/[a-zA-Z0-9-]+$/.test(path)) {
      return '';
    }

    return url.origin + path;
  } catch {
    return '';
  }
}

async function ctbReadReturnRoute() {
  const data = await chrome.storage.local.get(CTB_RETURN_KEY);
  const routes = data[CTB_RETURN_KEY];

  if (!Array.isArray(routes)) return null;

  return routes.find(function(route) {
    return route?.routingVersion === CTB_RETURN_VERSION;
  }) || null;
}

async function ctbWriteReturnRoute(route) {
  const data = await chrome.storage.local.get(CTB_RETURN_KEY);
  const existing = Array.isArray(data[CTB_RETURN_KEY])
    ? data[CTB_RETURN_KEY]
    : [];

  const retained = existing.filter(function(item) {
    return item?.routingVersion !== CTB_RETURN_VERSION;
  });

  await chrome.storage.local.set({
    [CTB_RETURN_KEY]: [...retained, route]
  });
}

async function ctbChangeReturnRoute(token, allowedStatuses, patch) {
  const current = await ctbReadReturnRoute();

  if (
    !current ||
    current.token !== token ||
    !allowedStatuses.includes(current.status)
  ) {
    return null;
  }

  const updated = {
    ...current,
    ...patch,
    updatedAt: Date.now()
  };

  await ctbWriteReturnRoute(updated);

  return updated;
}

function ctbValidTelegramSender(sender, route, token) {
  return !!(
    sender?.tab &&
    sender.tab.id === route?.telegramTabId &&
    isTelegramDestinationUrl(sender.tab.url) &&
    token &&
    token === route?.token
  );
}

async function ctbHandleReturnJob(message, sender) {
  const route = await ctbReadReturnRoute();

  if (
    !ctbValidTelegramSender(sender, route, message.token) ||
    !/^J\d{4,}-\d{6}-\d{2}$/.test(message.jobId || '')
  ) {
    return { ok: false, error: '예약 검증 실패' };
  }

  if (
    route.status === 'awaiting_result' &&
    route.jobId === message.jobId
  ) {
    return { ok: true };
  }

  const updated = await ctbChangeReturnRoute(
    message.token,
    ['sending', 'awaiting_job'],
    {
      status: 'awaiting_result',
      jobId: message.jobId
    }
  );

  return {
    ok: !!updated,
    error: updated ? '' : 'Job 연결 상태 불일치'
  };
}

async function ctbHandleReturnReady(message, sender) {
  if (ctbReturnDeliveryBusy) {
    return { ok: false, error: '전달 처리 중' };
  }

  const route = await ctbReadReturnRoute();

  if (
    !ctbValidTelegramSender(sender, route, message.token) ||
    route.status !== 'awaiting_result' ||
    route.jobId !== message.jobId ||
    !/^R[1-9]\d*$/.test(message.sequence || '')
  ) {
    return { ok: false, error: 'Job 또는 종료 신호 불일치' };
  }

  if (
    message.candidateCount !== 1 ||
    typeof message.text !== 'string' ||
    !message.text.trim()
  ) {
    await ctbChangeReturnRoute(
      route.token,
      ['awaiting_result'],
      {
        status: 'ambiguous',
        error: '완료보고 후보가 정확히 1개가 아님'
      }
    );

    return {
      ok: false,
      error: '후보 개수 불확실 · 수동 전달 필요'
    };
  }

  ctbReturnDeliveryBusy = true;

  try {
    const claimed = await ctbChangeReturnRoute(
      route.token,
      ['awaiting_result'],
      {
        status: 'delivering',
        sequence: message.sequence,
        claimedAt: Date.now()
      }
    );

    if (!claimed) {
      return { ok: false, error: '전달 예약 선점 실패' };
    }

    const target = await chrome.tabs.get(route.sourceTabId);

    if (
      !target ||
      ctbReturnConversationUrl(target.url) !==
        route.sourceConversationUrl
    ) {
      throw new Error('원본 ChatGPT 대화 탭이 변경됨');
    }

    // 자동전송은 sendToTab()의 재주입/재시도 경로를 사용하지 않는다.
    // 응답 유실 시 중복 전송을 막기 위해 정확히 한 번만 호출한다.
    const result = await chrome.tabs.sendMessage(
      target.id,
      {
        action: 'ctbAutoReturnDeliver',
        conversationUrl: route.sourceConversationUrl,
        text: message.text
      }
    );

    const sent = result?.ok === true && result?.sent === true;

    await ctbChangeReturnRoute(
      route.token,
      ['delivering'],
      {
        status: sent ? 'delivered' : 'delivery_failed',
        error: sent ? '' : (result?.error || 'ChatGPT 전송 미확인'),
        completedAt: Date.now()
      }
    );

    return {
      ok: sent,
      error: sent ? '' : (result?.error || 'ChatGPT 전송 미확인')
    };
  } catch (error) {
    try {
      await ctbChangeReturnRoute(
        route.token,
        ['delivering'],
        {
          status: 'ambiguous',
          error: error?.message || '전달 상태 확인 실패'
        }
      );
    } catch {}

    return {
      ok: false,
      error: error?.message || '자동전달 실패'
    };
  } finally {
    ctbReturnDeliveryBusy = false;
  }
}

// AI → Telegram
async function handleAiToTelegram(
  senderTabId,
  autoSend,
  sourceRequest,
  autoReturn
) {
  const sourceAiTab =
    await resolveAiSourceTab(
      sourceRequest,
      senderTabId
    );

  if (!sourceAiTab) {
    return {
      ok: false,
      error:
        '선택한 AI 탭을 찾을 수 없습니다.'
    };
  }

  if (!isAiSourceUrl(sourceAiTab.url)) {
    return {
      ok: false,
      error:
        'AI 원본 탭이 올바르지 않습니다.'
    };
  }

  const expectedSourceSite =
    getAiSourceSite(
      sourceAiTab.url
    );

  const streamRes =
    await sendToTab(
      sourceAiTab.id,
      {
        action: 'checkStreaming'
      }
    ).catch(function() {
      return null;
    });

  if (streamRes?.streaming) {
    return {
      ok: false,
      error:
        'AI가 아직 답변 중이에요.'
    };
  }

  let aiRes =
    await sendToTab(
      sourceAiTab.id,
      {
        action: 'getResponse'
      }
    );

  if (
    aiRes?.sourceSite !==
      expectedSourceSite ||
    !isAiSourceUrl(
      aiRes?.sourceUrl
    ) ||
    normalizeTabSourceUrl(
      aiRes.sourceUrl
    ) !==
      normalizeTabSourceUrl(
        sourceAiTab.url
      )
  ) {
    return {
      ok: false,
      error:
        'AI 원본 응답 출처를 확인할 수 없습니다.'
    };
  }

  if (
    expectedSourceSite === 'chatgpt' &&
    aiRes?.useNativeCodeCopy
  ) {
    try {
      aiRes = {
        ...aiRes,
        text:
          await captureChatgptCodeByCopyButton(
            sourceAiTab.id
          )
      };
    } catch (e) {
      return {
        ok: false,
        error:
          e?.message ||
          'ChatGPT 코드박스 복사에 실패했습니다.'
      };
    }
  }

  if (!aiRes?.text) {
    return {
      ok: false,
      error:
        'AI 응답을 찾을 수 없어요.'
    };
  }

  const tgTab =
    await findTelegramTab();

  if (
    !tgTab ||
    !isTelegramDestinationUrl(
      tgTab.url
    )
  ) {
    return {
      ok: false,
      error:
        'web.telegram.org 탭을 열고 봇 채팅방을 선택해주세요.'
    };
  }

  let returnRoute = null;

  if (autoReturn === true) {
    const conversationUrl =
      ctbReturnConversationUrl(sourceAiTab.url);

    if (
      autoSend !== true ||
      expectedSourceSite !== 'chatgpt' ||
      !conversationUrl
    ) {
      return {
        ok: false,
        error: '자동회신은 원본 ChatGPT 대화와 Telegram 자동전송이 필요합니다.'
      };
    }

    const previous = await ctbReadReturnRoute();

    const activeStatuses = [
      'sending',
      'awaiting_job',
      'awaiting_result',
      'delivering'
    ];

    if (
      previous &&
      activeStatuses.includes(previous.status) &&
      Date.now() - Number(previous.createdAt || 0) <
        12 * 60 * 60 * 1000
    ) {
      return {
        ok: false,
        error: '이전 GPT 자동회신 작업이 아직 진행 중입니다.'
      };
    }

    returnRoute = {
      routingVersion: CTB_RETURN_VERSION,
      routeId: crypto.randomUUID(),
      token: crypto.randomUUID(),
      autoReturn: true,
      sourceTabId: sourceAiTab.id,
      sourceConversationUrl: conversationUrl,
      telegramTabId: tgTab.id,
      jobId: '',
      sequence: '',
      status: 'sending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      error: ''
    };

    await ctbWriteReturnRoute(returnRoute);
  }

  try {
    const result = await sendToTab(
      tgTab.id,
      {
        action: 'sendToTelegram',
        text: aiRes.text,
        autoSend: !!autoSend,
        ctbReturnToken: returnRoute?.token || ''
      }
    );

    if (returnRoute) {
      await ctbChangeReturnRoute(
        returnRoute.token,
        ['sending'],
        {
          status:
            result?.ok === true && result?.sent === true
              ? 'awaiting_job'
              : 'ambiguous',
          error:
            result?.ok === true && result?.sent === true
              ? ''
              : (result?.error || 'Telegram 전송 확인 실패')
        }
      );
    }

    return result;
  } catch (error) {
    if (returnRoute) {
      try {
        await ctbChangeReturnRoute(
          returnRoute.token,
          ['sending'],
          {
            status: 'ambiguous',
            error: error?.message || 'Telegram 전송 상태 불명'
          }
        );
      } catch {}
    }

    throw error;
  }
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


// ────────────────────────────────────────
// 기존 탭 content.js 자동 주입
//────────────────────────────────────────
const BRIDGE_CONTENT_URL_PATTERNS = [
 'https://claude.ai/*',
 'https://chat.openai.com/*',
 'https://chatgpt.com/*',
 'https://gemini.google.com/*',
 'https://web.telegram.org/*'
];

function isBridgeContentUrl(url) {
 if (!url) return false;

 return url.indexOf('https://claude.ai/') === 0 ||
 url.indexOf('https://chat.openai.com/') === 0 ||
 url.indexOf('https://chatgpt.com/') === 0 ||
 url.indexOf('https://gemini.google.com/') === 0 ||
 url.indexOf('https://web.telegram.org/') === 0;
}

async function injectBridgeContentIntoTab(tabId) {
 if (!tabId || !chrome.scripting || !chrome.scripting.executeScript) return false;

 try {
 await chrome.scripting.executeScript({
 target: { tabId: tabId },
 files: ['content.js']
 });
 return true;
 } catch (e) {
 return false;
 }
}

async function injectBridgeContentIntoOpenTabs() {
 if (!chrome.tabs || !chrome.tabs.query) return;

 const tabs = await chrome.tabs.query({
 url: BRIDGE_CONTENT_URL_PATTERNS
 });

 await Promise.all((tabs || []).map(function(tab) {
 return injectBridgeContentIntoTab(tab.id);
 }));
}

function scheduleBridgeContentInjection() {
 setTimeout(function() {
 injectBridgeContentIntoOpenTabs().catch(function() {});
 }, 1200);
}

scheduleBridgeContentInjection();

if (chrome.runtime && chrome.runtime.onInstalled) {
 chrome.runtime.onInstalled.addListener(function() {
 scheduleBridgeContentInjection();
 });
}

if (chrome.runtime && chrome.runtime.onStartup) {
 chrome.runtime.onStartup.addListener(function() {
 scheduleBridgeContentInjection();
 });
}

if (chrome.tabs && chrome.tabs.onUpdated) {
 chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
 if (changeInfo && changeInfo.status === 'complete' && tab && isBridgeContentUrl(tab.url)) {
 injectBridgeContentIntoTab(tabId).catch(function() {});
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
      const aiTab = await resolveAiSourceTab({
        sourceAiTabId: msg.sourceAiTabId,
        sourceAiUrl: msg.sourceAiUrl,
        sourceAiTitle: msg.sourceAiTitle
      }, sender.tab?.id);

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
        title: aiTab.title || '',
        url: aiTab.url || '',
        sourceSite: getAiSourceSite(aiTab.url)
      });
    })();

    return true;
  }

  if (msg.action === 'ctbAutoReturnJob') {
    ctbHandleReturnJob(msg, sender)
      .then(sendResponse)
      .catch(function(error) {
        sendResponse({
          ok: false,
          error: error?.message || String(error)
        });
      });

    return true;
  }

  if (msg.action === 'ctbAutoReturnReady') {
    ctbHandleReturnReady(msg, sender)
      .then(sendResponse)
      .catch(function(error) {
        sendResponse({
          ok: false,
          error: error?.message || String(error)
        });
      });

    return true;
  }

  if (msg.action === 'aiToTelegram') {
    handleAiToTelegram(
      aiTabId,
      msg.autoSend,
      {
        sourceAiTabId: msg.sourceAiTabId,
        sourceAiUrl: msg.sourceAiUrl,
        sourceAiTitle: msg.sourceAiTitle
      },
      msg.autoReturn
    )
      .then(sendResponse)
      .catch(function(e) {
        sendResponse({
          ok: false,
          error:
            e?.message ||
            String(e)
        });
      });
    return true;
  }
  if (msg.action === 'telegramToAI') {
    handleTelegramToAi(aiTabId, msg.autoSend, msg.tgCopyMode, msg.aiTarget, msg.targetTabId)
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

// ────────────────────────────────────────
// AI 응답 완료 알림
// ────────────────────────────────────────
const BRIDGE_NOTIFY_POPUP_ENABLED_KEY_BG = 'bridge_notify_popup_enabled';
const BRIDGE_NOTIFY_ATTENTION_ENABLED_KEY_BG = 'bridge_notify_attention_enabled';
const BRIDGE_NOTIFICATION_PREFIX = 'bridge-complete-';

function getBridgeNotificationIconUrl() {
 try {
 const manifest = chrome.runtime.getManifest();
 const icons = manifest && manifest.icons ? manifest.icons : {};
 const iconPath = icons['128'] || icons['48'] || icons['32'] || icons['16'];

 if (iconPath) {
 return chrome.runtime.getURL(iconPath);
 }
 } catch (e) {}

 return chrome.runtime.getURL('bridge-notification-icon.png');
}

function getBridgeNotifySettings(callback) {
 chrome.storage.local.get({
 [BRIDGE_NOTIFY_POPUP_ENABLED_KEY_BG]: true,
 [BRIDGE_NOTIFY_ATTENTION_ENABLED_KEY_BG]: true
 }, (res) => {
 callback({
 popupEnabled: res[BRIDGE_NOTIFY_POPUP_ENABLED_KEY_BG] !== false,
 attentionEnabled: res[BRIDGE_NOTIFY_ATTENTION_ENABLED_KEY_BG] !== false
 });
 });
}

function drawBridgeNotificationAttention(tab) {
 if (!tab || !tab.windowId || !chrome.windows || !chrome.windows.update) return;

 try {
 chrome.windows.update(tab.windowId, { drawAttention: true }, () => {
 void chrome.runtime.lastError;
 });
 } catch (e) {}
}

function focusBridgeNotificationTab(notificationId) {
 if (!notificationId || notificationId.indexOf(BRIDGE_NOTIFICATION_PREFIX) !== 0) return;

 const rest = notificationId.slice(BRIDGE_NOTIFICATION_PREFIX.length);
 const tabIdText = rest.split('-')[0];
 const tabId = Number(tabIdText);

 if (!Number.isFinite(tabId) || !chrome.tabs || !chrome.tabs.get) return;

 chrome.tabs.get(tabId, (tab) => {
 if (chrome.runtime.lastError || !tab) return;

 if (chrome.windows && chrome.windows.update && tab.windowId) {
 chrome.windows.update(tab.windowId, { focused: true, drawAttention: false }, () => {
 void chrome.runtime.lastError;
 });
 }

 chrome.tabs.update(tabId, { active: true }, () => {
 void chrome.runtime.lastError;
 });
 });

 if (chrome.notifications && chrome.notifications.clear) {
 chrome.notifications.clear(notificationId, () => {
 void chrome.runtime.lastError;
 });
 }
}

function createBridgeNotification(tab, payload, sendResponse) {
 getBridgeNotifySettings((settings) => {
 if (settings.attentionEnabled) {
 drawBridgeNotificationAttention(tab);
 }

 if (!settings.popupEnabled) {
 sendResponse({ ok: true, popup: 'disabled', attention: settings.attentionEnabled });
 return;
 }

 if (!chrome.notifications || !chrome.notifications.create) {
 sendResponse({ ok: false, error: 'notifications_unavailable', attention: settings.attentionEnabled });
 return;
 }

 const tabId = tab && tab.id ? tab.id : 0;
 const type = payload && payload.type ? String(payload.type) : 'complete';
 const notificationId = BRIDGE_NOTIFICATION_PREFIX + tabId + '-' + type + '-' + Date.now();

 chrome.notifications.create(notificationId, {
 type: 'basic',
 iconUrl: getBridgeNotificationIconUrl(),
 title: payload && payload.title ? payload.title : '작업 완료',
 message: payload && payload.message ? payload.message : '새 작업 상태가 도착했습니다.',
 priority: 2
 }, () => {
 const err = chrome.runtime.lastError;
 if (err) {
 sendResponse({ ok: false, error: err.message, attention: settings.attentionEnabled });
 return;
 }

 sendResponse({ ok: true, notificationId, attention: settings.attentionEnabled });
 });
 });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
 if (!msg || msg.action !== 'bridgeNotifyComplete') return false;

 // Telegram은 자체 알림을 사용하고 확장프로그램 알림에서는 제외한다.
 if (msg.type !== 'ai') {
 sendResponse({ ok: true, ignored: 'non_ai_notification' });
 return false;
 }

 createBridgeNotification(sender && sender.tab ? sender.tab : null, msg, sendResponse);
 return true;
});

if (chrome.notifications && chrome.notifications.onClicked) {
 chrome.notifications.onClicked.addListener((notificationId) => {
 focusBridgeNotificationTab(notificationId);
 });
}
