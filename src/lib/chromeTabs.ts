import type { TabInfo, WindowSnapshot } from "./types";

export async function getCurrentTabs(): Promise<TabInfo[]> {
  const windows = await chrome.windows.getAll({ populate: true });
  return windows.flatMap((window) => serializeWindowTabs(window));
}

export async function getCurrentWindowSnapshots(): Promise<WindowSnapshot[]> {
  const windows = await chrome.windows.getAll({ populate: true });
  return windows.map((window) => ({
    windowId: window.id ?? -1,
    focused: Boolean(window.focused),
    tabs: serializeWindowTabs(window)
  }));
}

export async function closeTabs(tabIds: number[]): Promise<void> {
  const uniqueIds = Array.from(new Set(tabIds)).filter((id) => Number.isFinite(id));
  if (uniqueIds.length === 0) return;
  await chrome.tabs.remove(uniqueIds);
}

export async function restoreSnapshotTabs(
  windows: WindowSnapshot[],
  target: "new-window" | "current-window"
): Promise<void> {
  const urls = windows.flatMap((window) => window.tabs.map((tab) => tab.url)).filter(Boolean);
  if (urls.length === 0) return;

  if (target === "new-window") {
    await chrome.windows.create({ url: urls });
    return;
  }

  await Promise.all(urls.map((url) => chrome.tabs.create({ url, active: false })));
}

function serializeWindowTabs(window: chrome.windows.Window): TabInfo[] {
  return (window.tabs ?? [])
    .filter((tab): tab is chrome.tabs.Tab & { id: number; windowId: number } => {
      return tab.id !== undefined && tab.windowId !== undefined && Boolean(tab.url);
    })
    .map((tab) => ({
      id: tab.id,
      windowId: tab.windowId,
      index: tab.index,
      title: tab.title ?? "Untitled tab",
      url: tab.url ?? "",
      favIconUrl: tab.favIconUrl,
      active: Boolean(tab.active),
      pinned: Boolean(tab.pinned),
      lastAccessed: tab.lastAccessed
    }));
}
