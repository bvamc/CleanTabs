const dashboardUrl = chrome.runtime.getURL("index.html");
const SMART_MODEL_ALARM = "cleantab-smart-model-warmup";
const SMART_MODEL_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }]
};

interface LanguageModelSession {
  destroy?: () => void;
}

interface LanguageModelFactory {
  availability?: (options?: typeof SMART_MODEL_OPTIONS) => Promise<string> | string;
  create?: (options?: typeof SMART_MODEL_OPTIONS) => Promise<LanguageModelSession>;
}

declare global {
  var LanguageModel: LanguageModelFactory | undefined;
}

chrome.action.onClicked.addListener(async () => {
  const existingTabs = await chrome.tabs.query({ url: dashboardUrl });
  const existingTab = existingTabs[0];

  if (existingTab?.id !== undefined) {
    await chrome.tabs.update(existingTab.id, { active: true });
    if (existingTab.windowId !== undefined) {
      await chrome.windows.update(existingTab.windowId, { focused: true });
    }
    return;
  }

  await chrome.tabs.create({ url: dashboardUrl, active: true });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(SMART_MODEL_ALARM, {
    delayInMinutes: 1,
    periodInMinutes: 30
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(SMART_MODEL_ALARM, {
    delayInMinutes: 1,
    periodInMinutes: 30
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== SMART_MODEL_ALARM) return;
  void warmLocalModel();
});

async function warmLocalModel() {
  const settings = await chrome.storage.local.get("cleantab.smartNames.enabled");
  if (settings["cleantab.smartNames.enabled"] === false) return;

  const model = globalThis.LanguageModel;
  if (!model) return;

  try {
    const availability = await Promise.resolve(model.availability?.(SMART_MODEL_OPTIONS) ?? "available");
    if (availability !== "available" || !model.create) {
      await chrome.storage.local.set({
        "cleantab.smartModel.lastWarmup": {
          availability,
          checkedAt: Date.now()
        }
      });
      return;
    }

    const session = await model.create(SMART_MODEL_OPTIONS);
    session.destroy?.();
    await chrome.storage.local.set({
      "cleantab.smartModel.lastWarmup": {
        availability,
        checkedAt: Date.now()
      }
    });
  } catch {
    await chrome.storage.local.set({
      "cleantab.smartModel.lastWarmup": {
        availability: "error",
        checkedAt: Date.now()
      }
    });
  }
}

export {};
