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

const AUTO_RETURN_ROUTES_KEY =
  'bridge_auto_return_routes';
const AUTO_RETURN_ROUTE_LIMIT = 50;
const AUTO_RETURN_TERMINAL_AGE =
  7 * 24 * 60 * 60 * 1000;
let autoReturnRouteQueue = Promise.resolve();

function normalizeConversationUrl(value) {
  try {
    const url = new URL(value);
    return url.origin + url.pathname;
  } catch (error) {
    return '';
  }
}

function isChatgptUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.origin === 'https://chatgpt.com' ||
      url.origin === 'https://chat.openai.com'
    );
  } catch (error) {
    return false;
  }
}

function isSpecificConversationUrl(value) {
  try {
    const path = new URL(value).pathname;
    return path !== '/' && path.length > 1;
  } catch (error) {
    return false;
  }
}

function parseStage(text) {
  const match = String(text || '').match(
    /^\s*\[(\d+-\d+)\]\s*$/m
  );
  return match ? match[1] : '';
}

function parseCommandMode(text) {
  const match = String(text || '').match(
    /^\s*\/(run|auto2?|fullauto)\b/im
  );
  return match ? match[1].toLowerCase() : '';
}

function normalizeProject(value) {
  return String(value || '')
    .trim()
    .replace(/^['"`]|['"`]$/g, '')
    .split('/').filter(Boolean).pop()
    ?.toLowerCase() || '';
}

function parseProject(text) {
  const match = String(text || '').match(
    /^(?:Project|프로젝트|작업\s*대상)\s*:\s*(?:\n\s*)?([^\n]+?)\s*$/im
  );
  return match ? match[1].trim() : '';
}

function parseJobRegistration(text) {
  const value = String(text || '');
  const job = value.match(/^\s*Job\s*:\s*(J[^\s]+)\s*$/im);
  if (!job) return null;
  const modeStage = value.match(
    /^\s*(RUN|AUTO2?|FULLAUTO)\s*[·|:-]\s*(\d+-\d+)\s*$/im
  );
  return {
    jobId: job[1],
    commandMode:
      modeStage ? modeStage[1].toLowerCase() : '',
    stage:
      modeStage ? modeStage[2] : parseStage(value),
    project: parseProject(value)
  };
}

function stageLineCount(text, stage) {
  if (!stage) return 0;
  const marker = '[' + stage + ']';
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line === marker)
    .length;
}

function isRouteSystemStatusMessage(text) {
  const value = String(text || '').trim();
  return (
    /^Auto\s+DONE\b/i.test(value) ||
    /^\[Codex\]\s+\d+[hm]\b/i.test(value) ||
    /^작업\s*대기열(?:에)?\s*등록/im.test(value) ||
    /^대기\s*작업\s*자동\s*시작/im.test(value)
  );
}

function routeProjectMatches(a, b) {
  const left = normalizeProject(a);
  const right = normalizeProject(b);
  return !left || !right || left === right;
}

function cleanAutoReturnRoutes(routes) {
  const now = Date.now();
  const terminal = new Set([
    'delivered',
    'cancelled',
    'delivery_failed',
    'ambiguous'
  ]);
  return routes
    .filter(function(route) {
      return !(
        terminal.has(route.status) &&
        now - Number(route.updatedAt || route.createdAt || 0) >
          AUTO_RETURN_TERMINAL_AGE
      );
    })
    .sort(function(a, b) {
      const aTerminal = terminal.has(a.status) ? 0 : 1;
      const bTerminal = terminal.has(b.status) ? 0 : 1;
      if (aTerminal !== bTerminal) return bTerminal - aTerminal;
      return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    })
    .slice(0, AUTO_RETURN_ROUTE_LIMIT);
}

async function getAutoReturnRoutes() {
  const stored =
    await bridgeStorageGet([AUTO_RETURN_ROUTES_KEY]);
  return Array.isArray(stored[AUTO_RETURN_ROUTES_KEY])
    ? stored[AUTO_RETURN_ROUTES_KEY]
    : [];
}

async function saveAutoReturnRoutes(routes) {
  await bridgeStorageSet({
    [AUTO_RETURN_ROUTES_KEY]:
      cleanAutoReturnRoutes(routes)
  });
}

function createRouteId() {
  return (
    'route-' + Date.now().toString(36) + '-' +
    Math.random().toString(36).slice(2, 9)
  );
}

async function reserveAutoReturnRoute(
  aiTab,
  text,
  context,
  autoReturn
) {
  if (!autoReturn || !isChatgptUrl(aiTab?.url)) {
    return { route: null, reason: 'disabled_or_unsupported' };
  }
  const stage = parseStage(text);
  if (!stage) {
    return { route: null, reason: 'stage_not_found' };
  }
  if (!context?.chatKey) {
    return { route: null, reason: 'telegram_context_unavailable' };
  }
  const now = Date.now();
  const project = parseProject(text);
  const route = {
    routeId: createRouteId(),
    routingVersion: '059-3',
    sourceTabId: aiTab.id,
    sourceUrl: aiTab.url || '',
    sourceConversationUrl:
      normalizeConversationUrl(aiTab.url),
    sourceTitle: aiTab.title || '',
    stage: stage,
    project: project,
    normalizedProject: normalizeProject(project),
    commandMode: parseCommandMode(text),
    telegramChatKey: context.chatKey,
    telegramAnchorKey: context.anchorKey || '',
    telegramAnchorOrder:
      typeof context.anchorOrder === 'number'
        ? context.anchorOrder
        : null,
    jobId: '',
    status: 'awaiting_job',
    autoReturn: true,
    createdAt: now,
    updatedAt: now,
    resultParts: [],
    resultText: '',
    error: ''
  };
  const routes = await getAutoReturnRoutes();
  routes.push(route);
  await saveAutoReturnRoutes(routes);
  return { route: route, reason: '' };
}

async function updateRouteStatus(routeId, status, error) {
  const routes = await getAutoReturnRoutes();
  const route = routes.find(item => item.routeId === routeId);
  if (!route) return;
  route.status = status;
  route.error = error || '';
  route.updatedAt = Date.now();
  await saveAutoReturnRoutes(routes);
}

function messageIsAfterAnchor(route, incoming) {
  return !(
    typeof route.telegramAnchorOrder === 'number' &&
    typeof incoming.order === 'number' &&
    incoming.order <= route.telegramAnchorOrder
  );
}

function resultHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

async function waitForTabComplete(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.status === 'complete') return tab;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('target_load_timeout');
}

async function findAutoReturnTarget(route) {
  if (route.sourceTabId) {
    try {
      const tab = await chrome.tabs.get(route.sourceTabId);
      if (
        normalizeConversationUrl(tab.url) ===
        route.sourceConversationUrl
      ) return tab;
    } catch (error) {}
  }
  const tabs = await chrome.tabs.query({
    url: ['https://chatgpt.com/*', 'https://chat.openai.com/*']
  });
  const exact = tabs.find(function(tab) {
    return normalizeConversationUrl(tab.url) ===
      route.sourceConversationUrl;
  });
  if (exact) return exact;
  if (!isSpecificConversationUrl(route.sourceConversationUrl)) {
    throw new Error('conversation_url_not_specific');
  }
  const created = await chrome.tabs.create({
    url: route.sourceConversationUrl,
    active: false
  });
  return waitForTabComplete(created.id, 20000);
}

async function deliverAutoReturnRoute(routeId) {
  let routes = await getAutoReturnRoutes();
  let route = routes.find(item => item.routeId === routeId);
  if (
    !route ||
    route.status !== 'collecting_result' ||
    route.deliveredAt
  ) return;
  if (!route.resultText || !route.sourceConversationUrl) {
    route.status = 'delivery_failed';
    route.error = route.resultText
      ? 'target_url_invalid'
      : 'result_ambiguous';
    route.updatedAt = Date.now();
    await saveAutoReturnRoutes(routes);
    return;
  }
  route.status = 'delivering';
  route.updatedAt = Date.now();
  await saveAutoReturnRoutes(routes);
  try {
    let target;
    try {
      target = await findAutoReturnTarget(route);
    } catch (error) {
      const category =
        error?.message === 'conversation_url_not_specific'
          ? 'target_url_invalid'
          : 'target_tab_not_found';
      throw new Error(category);
    }
    if (
      normalizeConversationUrl(target?.url) !==
      route.sourceConversationUrl
    ) {
      throw new Error('target_url_invalid');
    }
    const stream = await sendToTab(target.id, {
      action: 'checkStreaming'
    });
    if (stream?.streaming) throw new Error('target_streaming');
    const result = await sendToTab(target.id, {
      action: 'pasteToAI',
      text: route.resultText,
      autoSend: true
    });
    if (!result?.ok || result.sent !== true) {
      throw new Error(
        result?.pasted === false || !result?.pasted
          ? 'paste_failed'
          : 'send_failed'
      );
    }
    routes = await getAutoReturnRoutes();
    route = routes.find(item => item.routeId === routeId);
    if (!route || route.status !== 'delivering') return;
    route.status = 'delivered';
    route.deliveredAt = Date.now();
    route.resultLength = route.resultText.length;
    route.resultHash = resultHash(route.resultText);
    route.resultText = '';
    route.resultParts = [];
    route.error = '';
    route.updatedAt = Date.now();
    await saveAutoReturnRoutes(routes);
  } catch (error) {
    routes = await getAutoReturnRoutes();
    route = routes.find(item => item.routeId === routeId);
    if (!route || route.status === 'delivered') return;
    route.status = 'delivery_failed';
    route.error = error?.message || 'delivery_failed';
    route.updatedAt = Date.now();
    await saveAutoReturnRoutes(routes);
  }
}

async function processTelegramRouteIncoming(incoming) {
  if (!incoming?.chatKey || !incoming?.key || !incoming?.text) return;
  const routes = await getAutoReturnRoutes();
  const registration = parseJobRegistration(incoming.text);
  if (registration?.stage) {
    const existing = routes.find(function(route) {
      return (
        route.telegramChatKey === incoming.chatKey &&
        route.routingVersion === '059-3' &&
        route.jobMessageKey === incoming.key &&
        route.jobId === registration.jobId
      );
    });
    if (existing) {
      if (typeof incoming.order === 'number') {
        existing.jobMessageOrder = incoming.order;
        existing.updatedAt = Date.now();
        await saveAutoReturnRoutes(routes);
      }
      return;
    }

    const candidates = routes.filter(function(route) {
      return (
        route.status === 'awaiting_job' &&
        route.routingVersion === '059-3' &&
        route.autoReturn === true &&
        route.telegramChatKey === incoming.chatKey &&
        route.stage === registration.stage &&
        messageIsAfterAnchor(route, incoming) &&
        routeProjectMatches(route.project, registration.project)
      );
    });
    if (candidates.length === 1) {
      candidates[0].jobId = registration.jobId;
      candidates[0].status = 'awaiting_result';
      candidates[0].updatedAt = Date.now();
      candidates[0].jobMessageKey = incoming.key;
      candidates[0].jobMessageOrder =
        typeof incoming.order === 'number'
          ? incoming.order
          : null;
    } else if (candidates.length > 1) {
      candidates.forEach(function(route) {
        route.status = 'ambiguous';
        route.error = 'job_ambiguous';
        route.updatedAt = Date.now();
      });
    }
    await saveAutoReturnRoutes(routes);
    return;
  }

  if (isRouteSystemStatusMessage(incoming.text)) return;

  const collecting = routes.filter(function(route) {
    return (
      route.status === 'collecting_result' &&
      route.routingVersion === '059-3' &&
      route.telegramChatKey === incoming.chatKey
    );
  });
  const starting = routes.filter(function(route) {
    return (
      route.status === 'awaiting_result' &&
      route.routingVersion === '059-3' &&
      route.telegramChatKey === incoming.chatKey &&
      !(
        typeof route.jobMessageOrder === 'number' &&
        typeof incoming.order === 'number' &&
        incoming.order <= route.jobMessageOrder
      ) &&
      stageLineCount(incoming.text, route.stage) > 0
    );
  });

  if (collecting.length > 1 || starting.length > 1 ||
      (collecting.length === 1 && starting.length === 1 &&
       collecting[0].routeId !== starting[0].routeId)) {
    [...collecting, ...starting].forEach(function(route) {
      route.status = 'ambiguous';
      route.error = 'result_ambiguous';
      route.updatedAt = Date.now();
    });
    await saveAutoReturnRoutes(routes);
    return;
  }

  const route = collecting[0] || starting[0];
  if (!route) return;
  const isStart = route.status === 'awaiting_result';
  const markerCount = stageLineCount(incoming.text, route.stage);
  route.status = 'collecting_result';
  if (isStart) {
    route.resultStartKey = incoming.key;
  }
  route.resultParts = Array.isArray(route.resultParts)
    ? route.resultParts
    : [];
  route.resultKeys = Array.isArray(route.resultKeys)
    ? route.resultKeys
    : [];
  const existingIndex =
    route.resultKeys.indexOf(incoming.key);
  if (existingIndex >= 0) {
    route.resultParts[existingIndex] = incoming.text;
  } else {
    route.resultParts.push(incoming.text);
    route.resultKeys.push(incoming.key);
  }
  route.resultText = route.resultParts.join('\n\n');
  route.updatedAt = Date.now();
  const complete =
    markerCount >= 2 ||
    (
      !isStart &&
      incoming.key !== route.resultStartKey &&
      markerCount >= 1
    );
  await saveAutoReturnRoutes(routes);
  if (complete) await deliverAutoReturnRoute(route.routeId);
}

function queueTelegramRouteIncoming(incoming) {
  const operation = autoReturnRouteQueue
    .then(() => processTelegramRouteIncoming(incoming));
  autoReturnRouteQueue = operation.catch(function(error) {
      console.warn('[CTB auto return]', error?.message || 'route error');
    });
  return operation;
}

function queueAutoReturnOperation(operation) {
  const pending = autoReturnRouteQueue.then(operation);
  autoReturnRouteQueue = pending.catch(function(error) {
    console.warn('[CTB auto return]', error?.message || 'route error');
  });
  return pending;
}

function queueTelegramRouteReconcile(snapshot) {
  return queueAutoReturnOperation(async function() {
    const messages = Array.isArray(snapshot?.messages)
      ? snapshot.messages
      : [];

    for (const message of messages) {
      await processTelegramRouteIncoming({
        chatKey: snapshot.chatKey,
        key: message.key,
        order: message.order,
        text: message.text
      });
    }
  });
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

  /*
   * ChatGPT 코드 모드:
   * DOM에서 코드를 다시 조립하지 않는다.
   * 실제 최신 코드박스 Copy 버튼이 만드는 값을 사용한다.
   */
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

  let reserved = {
    route: null,
    reason: ''
  };

  /*
   * auto-return 예약은 ChatGPT source일 때만 만든다.
   * 이 route의 resultText/resultParts는
   * AI→Telegram payload로 사용하지 않는다.
   */
  if (
    autoReturn &&
    isChatgptUrl(
      sourceAiTab.url
    )
  ) {
    const context =
      await sendToTab(
        tgTab.id,
        {
          action:
            'getTelegramRouteContext'
        }
      ).catch(function() {
        return null;
      });

    reserved =
      await queueAutoReturnOperation(
        function() {
          return reserveAutoReturnRoute(
            sourceAiTab,
            aiRes.text,
            context,
            true
          );
        }
      );
  }

  /*
   * AI→Telegram의 유일한 payload source.
   */
  const sent =
    await sendToTab(
      tgTab.id,
      {
        action: 'sendToTelegram',
        text: aiRes.text,
        autoSend: !!autoSend
      }
    );

  if (
    !sent?.ok &&
    reserved.route
  ) {
    await queueAutoReturnOperation(
      function() {
        return updateRouteStatus(
          reserved.route.routeId,
          'cancelled',
          sent?.error ||
            'telegram_send_failed'
        );
      }
    );
  }

  return {
    ...sent,
    autoReturnReserved:
      !!(
        sent?.ok &&
        reserved.route
      ),
    autoReturnFailed:
      !!(
        sent?.ok &&
        autoReturn &&
        isChatgptUrl(
          sourceAiTab.url
        ) &&
        !reserved.route
      ),
    autoReturnReason:
      reserved.reason || ''
  };
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
  if (msg.action === 'telegramRouteIncoming') {
    queueTelegramRouteIncoming({
      chatKey: msg.chatKey,
      key: msg.key,
      order: msg.order,
      text: msg.text
    }).then(function() {
      sendResponse({ ok: true });
    }).catch(function(error) {
      sendResponse({
        ok: false,
        error: error?.message || 'route_processing_failed'
      });
    });
    return true;
  }
  if (msg.action === 'telegramRouteReconcile') {
    queueTelegramRouteReconcile({
      chatKey: msg.chatKey,
      messages: msg.messages
    }).then(function() {
      sendResponse({ ok: true });
    }).catch(function(error) {
      sendResponse({
        ok: false,
        error: error?.message || 'route_reconcile_failed'
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
