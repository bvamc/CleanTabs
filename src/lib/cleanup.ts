import type { TabSnapshot, WindowSnapshot } from "./types";

interface CloseWithBackupOptions {
  tabIds: number[];
  getWindows: () => Promise<WindowSnapshot[]>;
  saveSnapshot: (name: string, source: "auto-before-close", windows: WindowSnapshot[]) => Promise<TabSnapshot>;
  closeTabs: (tabIds: number[]) => Promise<void>;
}

export async function closeSelectedTabsWithBackup({
  tabIds,
  getWindows,
  saveSnapshot,
  closeTabs
}: CloseWithBackupOptions): Promise<void> {
  const uniqueTabIds = Array.from(new Set(tabIds));
  if (uniqueTabIds.length === 0) return;

  const windows = await getWindows();
  await saveSnapshot("Before cleanup", "auto-before-close", windows);
  await closeTabs(uniqueTabIds);
}
