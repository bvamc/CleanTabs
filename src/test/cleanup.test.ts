import { describe, expect, it, vi } from "vitest";
import { closeSelectedTabsWithBackup } from "../lib/cleanup";
import type { TabSnapshot, WindowSnapshot } from "../lib/types";

const windows: WindowSnapshot[] = [
  {
    windowId: 1,
    focused: true,
    tabs: []
  }
];

const snapshot: TabSnapshot = {
  id: "snapshot-1",
  name: "Before cleanup",
  createdAt: 1,
  source: "auto-before-close",
  windows
};

describe("closeSelectedTabsWithBackup", () => {
  it("creates an automatic backup before closing tabs", async () => {
    const calls: string[] = [];
    const getWindows = vi.fn(async () => {
      calls.push("getWindows");
      return windows;
    });
    const saveSnapshot = vi.fn(async () => {
      calls.push("saveSnapshot");
      return snapshot;
    });
    const closeTabs = vi.fn(async () => {
      calls.push("closeTabs");
    });

    await closeSelectedTabsWithBackup({
      tabIds: [3, 2, 2],
      getWindows,
      saveSnapshot,
      closeTabs
    });

    expect(saveSnapshot).toHaveBeenCalledWith("Before cleanup", "auto-before-close", windows);
    expect(closeTabs).toHaveBeenCalledWith([3, 2]);
    expect(calls).toEqual(["getWindows", "saveSnapshot", "closeTabs"]);
  });

  it("does nothing when no tabs are selected", async () => {
    const getWindows = vi.fn(async () => windows);
    const saveSnapshot = vi.fn(async () => snapshot);
    const closeTabs = vi.fn(async () => undefined);

    await closeSelectedTabsWithBackup({
      tabIds: [],
      getWindows,
      saveSnapshot,
      closeTabs
    });

    expect(getWindows).not.toHaveBeenCalled();
    expect(saveSnapshot).not.toHaveBeenCalled();
    expect(closeTabs).not.toHaveBeenCalled();
  });
});
