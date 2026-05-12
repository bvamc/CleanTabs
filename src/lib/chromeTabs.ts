import type { TabInfo, WindowSnapshot } from "./types";

export type TabGroupingMode = "in-place" | "new-window";

export interface TabGroupRequest {
  title: string;
  tabIds: number[];
}

export async function getCurrentTabs(): Promise<TabInfo[]> {
  const [windows, groupById] = await Promise.all([
    chrome.windows.getAll({ populate: true }),
    getTabGroupsById()
  ]);
  return windows.flatMap((window) => serializeWindowTabs(window, groupById));
}

export async function getCurrentWindowSnapshots(): Promise<WindowSnapshot[]> {
  const [windows, groupById] = await Promise.all([
    chrome.windows.getAll({ populate: true }),
    getTabGroupsById()
  ]);
  return windows.map((window) => ({
    windowId: window.id ?? -1,
    focused: Boolean(window.focused),
    tabs: serializeWindowTabs(window, groupById)
  }));
}

export async function closeTabs(tabIds: number[]): Promise<void> {
  const uniqueIds = Array.from(new Set(tabIds)).filter((id) => Number.isFinite(id));
  if (uniqueIds.length === 0) return;
  await chrome.tabs.remove(uniqueIds);
}

export async function focusTab(tabId: number, windowId: number): Promise<void> {
  await focusWindow(windowId, tabId);
}

export async function groupTabs(
  title: string,
  tabIds: number[],
  tabs: TabInfo[],
  mode: TabGroupingMode
): Promise<number[]> {
  if (mode === "new-window") {
    return groupTabsInNewWindow(title, tabIds, tabs);
  }

  return groupTabsByWindow(title, tabIds, tabs);
}

export async function groupTabSetsInNewWindow(
  tabSets: TabGroupRequest[],
  tabs: TabInfo[]
): Promise<number[]> {
  const preparedSets = tabSets
    .map((set) => ({
      title: set.title,
      tabs: orderedSelectedTabs(set.tabIds, tabs)
    }))
    .filter((set) => set.tabs.length > 0);
  const selectedTabIds = Array.from(new Set(preparedSets.flatMap((set) => set.tabs.map((tab) => tab.id))));
  const selectedTabs = orderedSelectedTabs(selectedTabIds, tabs);
  if (selectedTabs.length === 0) return [];

  const [firstTab, ...remainingTabs] = selectedTabs;
  const createdWindow = await chrome.windows.create({
    focused: true,
    tabId: firstTab.id
  });

  if (!createdWindow.id) {
    throw new Error("Chrome did not return a window for selected groups.");
  }

  if (remainingTabs.length > 0) {
    await chrome.tabs.move(remainingTabs.map((tab) => tab.id), {
      index: -1,
      windowId: createdWindow.id
    });
  }

  const groupIds: number[] = [];
  for (const set of preparedSets) {
    const ids = set.tabs.map((tab) => tab.id);
    const groupId = await addTabsToGroup(set.title, ids, {
      windowId: createdWindow.id
    });
    groupIds.push(groupId);
  }

  return groupIds;
}

export async function groupTabsByWindow(
  title: string,
  tabIds: number[],
  tabs: TabInfo[]
): Promise<number[]> {
  const tabIdSet = new Set(tabIds);
  const byWindow = new Map<number, number[]>();

  for (const tab of tabs) {
    if (!tabIdSet.has(tab.id)) continue;
    const current = byWindow.get(tab.windowId) ?? [];
    current.push(tab.id);
    byWindow.set(tab.windowId, current);
  }

  const groupIds: number[] = [];
  for (const [windowId, ids] of byWindow.entries()) {
    if (ids.length === 0) continue;
    const windowTabs = tabs.filter((tab) => ids.includes(tab.id));
    const existingGroupId = primaryGroupId(windowTabs);
    const groupId =
      existingGroupId !== undefined &&
      windowTabs.every((tab) => tab.groupId === existingGroupId)
        ? await updateTabGroup(title, existingGroupId)
        : await addTabsToGroup(title, ids, {
            existingGroupId,
            windowId
          });
    groupIds.push(groupId);
  }

  return groupIds;
}

async function groupTabsInNewWindow(
  title: string,
  tabIds: number[],
  tabs: TabInfo[]
): Promise<number[]> {
  const selectedTabs = orderedSelectedTabs(tabIds, tabs);
  const selectedIds = selectedTabs.map((tab) => tab.id);
  if (selectedIds.length === 0) return [];

  const existingGroupId = primaryGroupId(selectedTabs);
  if (existingGroupId !== undefined) {
    const targetTab = selectedTabs.find((tab) => tab.groupId === existingGroupId);
    if (!targetTab) return [];

    const tabsToMove = selectedTabs
      .filter((tab) => tab.windowId !== targetTab.windowId)
      .map((tab) => tab.id);
    if (tabsToMove.length > 0) {
      await chrome.tabs.move(tabsToMove, {
        index: -1,
        windowId: targetTab.windowId
      });
    }

    const groupId =
      tabsToMove.length === 0 &&
      selectedTabs.every((tab) => tab.groupId === existingGroupId && tab.windowId === targetTab.windowId)
        ? await updateTabGroup(title, existingGroupId)
        : await addTabsToGroup(title, selectedIds, {
            existingGroupId,
            windowId: targetTab.windowId
          });
    await focusWindow(targetTab.windowId, selectedIds[0]);
    return [groupId];
  }

  const [firstTabId, ...remainingTabIds] = selectedIds;
  const createdWindow = await chrome.windows.create({
    focused: true,
    tabId: firstTabId
  });

  if (!createdWindow.id) {
    throw new Error("Chrome did not return a window for grouped tabs.");
  }

  if (remainingTabIds.length > 0) {
    await chrome.tabs.move(remainingTabIds, {
      index: -1,
      windowId: createdWindow.id
    });
  }

  const groupId = await addTabsToGroup(title, selectedIds, {
    windowId: createdWindow.id
  });

  return [groupId];
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

async function addTabsToGroup(
  title: string,
  tabIds: number[],
  options: { existingGroupId?: number; windowId: number }
): Promise<number> {
  const groupId =
    options.existingGroupId === undefined
      ? await chrome.tabs.group({
          tabIds,
          createProperties: { windowId: options.windowId }
        })
      : await chrome.tabs.group({
          tabIds,
          groupId: options.existingGroupId
        });
  await chrome.tabGroups.update(groupId, {
    title,
    color: "cyan"
  });
  return groupId;
}

async function updateTabGroup(title: string, groupId: number): Promise<number> {
  await chrome.tabGroups.update(groupId, {
    title,
    color: "cyan"
  });
  return groupId;
}

async function focusWindow(windowId: number, activeTabId?: number): Promise<void> {
  await chrome.windows.update(windowId, { focused: true });
  if (activeTabId !== undefined) {
    await chrome.tabs.update(activeTabId, { active: true });
  }
}

function primaryGroupId(tabs: TabInfo[]): number | undefined {
  const counts = new Map<number, number>();
  for (const tab of tabs) {
    if (!isGrouped(tab)) continue;
    counts.set(tab.groupId, (counts.get(tab.groupId) ?? 0) + 1);
  }

  return Array.from(counts.entries()).sort((first, second) => second[1] - first[1])[0]?.[0];
}

function orderedSelectedTabs(tabIds: number[], tabs: TabInfo[]): TabInfo[] {
  const selectedIds = new Set(tabIds);
  return tabs
    .filter((tab) => selectedIds.has(tab.id))
    .sort((first, second) => first.windowId - second.windowId || first.index - second.index);
}

async function getTabGroupsById(): Promise<Map<number, chrome.tabGroups.TabGroup>> {
  if (!chrome.tabGroups?.query) return new Map();
  const groups = await chrome.tabGroups.query({});
  return new Map(groups.map((group) => [group.id, group]));
}

function serializeWindowTabs(
  window: chrome.windows.Window,
  groupById: Map<number, chrome.tabGroups.TabGroup>
): TabInfo[] {
  return (window.tabs ?? [])
    .filter((tab): tab is chrome.tabs.Tab & { id: number; windowId: number } => {
      return tab.id !== undefined && tab.windowId !== undefined && Boolean(tab.url);
    })
    .map((tab) => {
      const group = tab.groupId === undefined ? undefined : groupById.get(tab.groupId);
      return {
        id: tab.id,
        windowId: tab.windowId,
        index: tab.index,
        title: tab.title ?? "Untitled tab",
        url: tab.url ?? "",
        favIconUrl: tab.favIconUrl,
        active: Boolean(tab.active),
        pinned: Boolean(tab.pinned),
        lastAccessed: tab.lastAccessed,
        groupId: isGrouped(tab) ? tab.groupId : undefined,
        groupTitle: group?.title,
        groupColor: group?.color,
        groupCollapsed: group?.collapsed
      };
    });
}

function isGrouped(tab: { groupId?: number }): tab is { groupId: number } {
  return tab.groupId !== undefined && tab.groupId >= 0;
}
