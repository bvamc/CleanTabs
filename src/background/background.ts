const dashboardUrl = chrome.runtime.getURL("index.html");

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
