(() => {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    targetModel: "GPT 6.0 Sol"
  });

  const RETRY_DELAYS_MS = [0, 400, 800, 1400, 2200, 3200, 5000, 8000];
  const NEW_CHAT_LABELS = [
    "新しいチャット",
    "新規チャット",
    "new chat",
    "start a new chat"
  ];
  const AUTO_LABELS = ["自動", "auto", "automatic"];
  const POPUP_SELECTOR = [
    '[role="menu"]',
    '[role="listbox"]',
    '[role="dialog"]',
    '[data-radix-popper-content-wrapper]',
    '[data-popper-placement]',
    '[class*="MenuPopover"]',
    '[class*="menu-popover"]'
  ].join(",");
  const CLICKABLE_SELECTOR = [
    "button",
    "a[href]",
    '[role="button"]',
    '[role="combobox"]',
    '[role="menuitem"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    "[aria-haspopup]"
  ].join(",");

  let settings = { ...DEFAULT_SETTINGS };
  let generation = 0;
  let completed = false;
  let running = false;
  let retryTimer = null;
  let attemptIndex = 0;
  let manualRun = false;
  let lastUrl = location.href;
  let lastStatus = {
    state: "waiting",
    message: "Copilot の画面を待っています",
    updatedAt: Date.now()
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function normalizeText(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase();
  }

  function elementText(element) {
    if (!(element instanceof Element)) return "";
    return normalizeText([
      element.innerText,
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("data-testid")
    ].filter(Boolean).join(" "));
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0;
  }

  function allRoots() {
    const roots = [document];
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index];
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot && !roots.includes(element.shadowRoot)) {
          roots.push(element.shadowRoot);
        }
      }
    }
    return roots;
  }

  function deepQueryAll(selector) {
    const result = [];
    const seen = new Set();
    for (const root of allRoots()) {
      for (const element of root.querySelectorAll(selector)) {
        if (!seen.has(element)) {
          seen.add(element);
          result.push(element);
        }
      }
    }
    return result;
  }

  function closestClickable(element) {
    if (!(element instanceof Element)) return null;
    return element.closest(CLICKABLE_SELECTOR) || element;
  }

  function insideVisiblePopup(element) {
    const popup = element.closest(POPUP_SELECTOR);
    return Boolean(popup && isVisible(popup));
  }

  function matchesTarget(text) {
    const target = normalizeText(settings.targetModel);
    if (!target) return false;
    return text === target || text.includes(target);
  }

  function looksLikeAuto(text) {
    return AUTO_LABELS.some((label) => {
      const normalizedLabel = normalizeText(label);
      return text === normalizedLabel || text.includes(normalizedLabel);
    });
  }

  function modelTriggerScore(element) {
    if (!isVisible(element) || insideVisiblePopup(element)) return -Infinity;

    const text = elementText(element);
    const rect = element.getBoundingClientRect();
    const attributes = normalizeText([
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("data-testid"),
      element.id,
      element.className
    ].join(" "));
    let score = 0;

    if (element.tagName === "BUTTON") score += 25;
    if (element.hasAttribute("aria-haspopup")) score += 45;
    if (matchesTarget(text)) score += 90;
    if (looksLikeAuto(text)) score += 75;
    if (/\b(model|models|mode|モデル)\b/.test(attributes)) score += 90;
    if (/\b(gpt|claude|gemini|openai)\b/.test(text)) score += 35;
    if (rect.top >= 0 && rect.top < 180) score += 45;
    if (rect.height > 18 && rect.height < 80) score += 15;
    if (text.length > 140) score -= 100;
    if (/新しいチャット|新規チャット|new chat/.test(text)) score -= 150;
    return score;
  }

  function findModelTrigger() {
    const candidates = deepQueryAll(CLICKABLE_SELECTOR)
      .map(closestClickable)
      .filter(Boolean);
    const unique = [...new Set(candidates)];
    unique.sort((a, b) => modelTriggerScore(b) - modelTriggerScore(a));
    const best = unique[0];
    return best && modelTriggerScore(best) >= 100 ? best : null;
  }

  function menuCandidateScore(element, trigger) {
    if (!isVisible(element) || element === trigger || element.contains(trigger)) return -Infinity;
    const text = elementText(element);
    if (!matchesTarget(text)) return -Infinity;

    const role = element.getAttribute("role");
    let score = 0;
    if (text === normalizeText(settings.targetModel)) score += 90;
    if (["menuitem", "menuitemradio", "option"].includes(role)) score += 80;
    if (element.tagName === "BUTTON") score += 35;
    if (insideVisiblePopup(element)) score += 70;
    if (element.getAttribute("aria-checked") === "true" || element.getAttribute("aria-selected") === "true") {
      score += 20;
    }
    if (text.length > 100) score -= 60;
    return score;
  }

  function findTargetMenuItem(trigger) {
    const candidates = deepQueryAll(CLICKABLE_SELECTOR)
      .map(closestClickable)
      .filter(Boolean);
    const unique = [...new Set(candidates)];
    unique.sort((a, b) => menuCandidateScore(b, trigger) - menuCandidateScore(a, trigger));
    const best = unique[0];
    return best && menuCandidateScore(best, trigger) >= 70 ? best : null;
  }

  function findProviderMenuItem(trigger) {
    const candidates = deepQueryAll(CLICKABLE_SELECTOR)
      .map(closestClickable)
      .filter((element) => {
        if (!element || element === trigger || !isVisible(element) || !insideVisiblePopup(element)) return false;
        const text = elementText(element);
        return text === "openai" || text.includes("openai");
      });
    return candidates.sort((a, b) => elementText(a).length - elementText(b).length)[0] || null;
  }

  function hasOpenModelMenu() {
    return deepQueryAll(POPUP_SELECTOR).some((element) => {
      if (!isVisible(element)) return false;
      const text = elementText(element);
      return matchesTarget(text) || text.includes("openai") || looksLikeAuto(text);
    });
  }

  function setStatus(state, message) {
    lastStatus = { state, message, updatedAt: Date.now() };
  }

  function clickElement(element) {
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
    element.focus({ preventScroll: true });
    element.click();
  }

  async function trySelectModel(runGeneration) {
    const trigger = findModelTrigger();
    if (!trigger) {
      setStatus("waiting", "モデル選択ボタンを待っています");
      return false;
    }

    if (matchesTarget(elementText(trigger))) {
      completed = true;
      setStatus("selected", `${settings.targetModel} が選択されています`);
      return true;
    }

    setStatus("selecting", `${settings.targetModel} を選択しています`);
    if (!hasOpenModelMenu()) {
      clickElement(trigger);
      await sleep(300);
    }

    for (let step = 0; step < 4 && generation === runGeneration; step += 1) {
      const currentTrigger = findModelTrigger() || trigger;
      if (matchesTarget(elementText(currentTrigger))) {
        completed = true;
        setStatus("selected", `${settings.targetModel} を選択しました`);
        return true;
      }

      const targetItem = findTargetMenuItem(currentTrigger);
      if (targetItem) {
        clickElement(targetItem);
        await sleep(350);
        continue;
      }

      const providerItem = findProviderMenuItem(currentTrigger);
      if (providerItem) {
        clickElement(providerItem);
        await sleep(350);
        continue;
      }

      await sleep(250);
    }

    const finalTrigger = findModelTrigger() || trigger;
    if (matchesTarget(elementText(finalTrigger))) {
      completed = true;
      setStatus("selected", `${settings.targetModel} を選択しました`);
      return true;
    }

    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true
    }));
    setStatus("retrying", `${settings.targetModel} が見つからないため再試行します`);
    return false;
  }

  function scheduleAttempt(delay = null) {
    if ((!settings.enabled && !manualRun) || completed || running || retryTimer !== null) return;
    if (attemptIndex >= RETRY_DELAYS_MS.length) {
      setStatus("not-found", "モデルを選択できませんでした。拡張アイコンから再実行できます");
      return;
    }

    const waitMs = delay ?? RETRY_DELAYS_MS[attemptIndex];
    retryTimer = setTimeout(async () => {
      retryTimer = null;
      if ((!settings.enabled && !manualRun) || completed || running) return;

      const runGeneration = generation;
      running = true;
      const succeeded = await trySelectModel(runGeneration).catch((error) => {
        console.debug("[Copilot Default Model] selection failed", error);
        setStatus("retrying", "選択処理でエラーが発生したため再試行します");
        return false;
      });
      running = false;

      if (!succeeded && generation === runGeneration) {
        attemptIndex += 1;
        scheduleAttempt();
      }
    }, Math.max(0, waitMs));
  }

  function beginNewChat(reason, force = false, runWhileDisabled = false) {
    generation += 1;
    completed = false;
    running = false;
    attemptIndex = 0;
    manualRun = runWhileDisabled;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    setStatus("waiting", `${reason}：モデル選択を待っています`);
    scheduleAttempt(force ? 0 : 250);
  }

  function isNewChatControl(element) {
    const clickable = element instanceof Element ? element.closest(CLICKABLE_SELECTOR) : null;
    if (!clickable) return false;
    const text = elementText(clickable);
    return NEW_CHAT_LABELS.some((label) => text.includes(normalizeText(label)));
  }

  async function loadSettings() {
    const saved = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    settings = {
      enabled: saved.enabled !== false,
      targetModel: String(saved.targetModel || DEFAULT_SETTINGS.targetModel).trim()
    };
  }

  document.addEventListener("click", (event) => {
    if (isNewChatControl(event.target)) {
      setTimeout(() => beginNewChat("新しいチャット"), 500);
    }
  }, true);

  const observer = new MutationObserver(() => {
    if (!completed && !running && settings.enabled) scheduleAttempt(120);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      beginNewChat("画面の切り替わり");
    }
  }, 500);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    if (changes.enabled) settings.enabled = changes.enabled.newValue !== false;
    if (changes.targetModel) {
      settings.targetModel = String(changes.targetModel.newValue || DEFAULT_SETTINGS.targetModel).trim();
    }
    if (settings.enabled) {
      beginNewChat("設定の変更", true);
    } else {
      generation += 1;
      completed = false;
      running = false;
      manualRun = false;
      attemptIndex = 0;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      setStatus("disabled", "自動選択は無効です");
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_STATUS") {
      sendResponse({ ...lastStatus, settings: { ...settings } });
      return false;
    }
    if (message?.type === "RUN_NOW") {
      beginNewChat("手動実行", true, true);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  loadSettings()
    .then(() => {
      if (settings.enabled) beginNewChat("初期表示", true);
      else setStatus("disabled", "自動選択は無効です");
    })
    .catch((error) => {
      console.debug("[Copilot Default Model] settings could not be loaded", error);
      settings = { ...DEFAULT_SETTINGS };
      beginNewChat("初期表示", true);
    });
})();
