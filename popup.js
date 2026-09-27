"use strict";

const DEFAULT_SETTINGS = {
  enabled: true,
  targetModel: "GPT 6.0 Sol"
};

const enabledInput = document.querySelector("#enabled");
const modelInput = document.querySelector("#target-model");
const runButton = document.querySelector("#run-now");
const statusElement = document.querySelector("#status");

function showStatus(message, isError = false) {
  statusElement.textContent = message;
  statusElement.classList.toggle("error", isError);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToPage(message) {
  const tab = await activeTab();
  if (!tab?.id) throw new Error("active tab unavailable");
  return chrome.tabs.sendMessage(tab.id, message);
}

async function saveSettings() {
  const targetModel = modelInput.value.trim() || DEFAULT_SETTINGS.targetModel;
  modelInput.value = targetModel;
  await chrome.storage.sync.set({
    enabled: enabledInput.checked,
    targetModel
  });
  showStatus("設定を保存しました");
}

enabledInput.addEventListener("change", saveSettings);
modelInput.addEventListener("change", saveSettings);
modelInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    modelInput.blur();
  }
});

runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  try {
    await saveSettings();
    await sendToPage({ type: "RUN_NOW" });
    showStatus("選択処理を開始しました");
  } catch {
    showStatus("Copilot のチャット画面を開いてから実行してください", true);
  } finally {
    runButton.disabled = false;
  }
});

async function initialize() {
  const saved = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  enabledInput.checked = saved.enabled !== false;
  modelInput.value = saved.targetModel || DEFAULT_SETTINGS.targetModel;

  try {
    const status = await sendToPage({ type: "GET_STATUS" });
    showStatus(status?.message || "待機中");
  } catch {
    showStatus("Copilot のチャット画面ではありません", true);
  }
}

initialize().catch(() => {
  showStatus("設定を読み込めませんでした", true);
});
