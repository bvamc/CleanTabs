import { afterEach, describe, expect, it, vi } from "vitest";
import { focusTab, groupTabs, groupTabSetsInNewWindow } from "../lib/chromeTabs";
import type { TabInfo } from "../lib/types";

const tabs: TabInfo[] = [
  {
    id: 1,
    windowId: 2,
    index: 1,
    title: "Second",
    url: "https://example.com/second",
    active: false,
    pinned: false
  },
  {
    id: 2,
    windowId: 1,
    index: 0,
    title: "First",
    url: "https://example.com/first",
    active: false,
    pinned: false
  },
  {
    id: 3,
    windowId: 2,
    index: 0,
    title: "Third",
    url: "https://example.com/third",
    active: false,
    pinned: false
  }
];

describe("focusTab", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("focuses the window and activates the target tab", async () => {
    const updateTab = vi.fn(async () => undefined);
    const updateWindow = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", {
      tabs: { update: updateTab },
      windows: { update: updateWindow }
    });

    await focusTab(42, 7);

    expect(updateWindow).toHaveBeenCalledWith(7, { focused: true });
    expect(updateTab).toHaveBeenCalledWith(42, { active: true });
  });
});

describe("groupTabs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("groups selected tabs inside their existing windows", async () => {
    const group = vi.fn(async () => 42);
    const update = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", {
      tabs: { group },
      tabGroups: { update }
    });

    const groupIds = await groupTabs("Example", [1, 2, 3], tabs, "in-place");

    expect(groupIds).toEqual([42, 42]);
    expect(group).toHaveBeenCalledWith({
      tabIds: [1, 3],
      createProperties: { windowId: 2 }
    });
    expect(group).toHaveBeenCalledWith({
      tabIds: [2],
      createProperties: { windowId: 1 }
    });
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("reuses existing groups inside each current window", async () => {
    const groupedTabs: TabInfo[] = [
      { ...tabs[0], groupId: 4 },
      { ...tabs[1] },
      { ...tabs[2] }
    ];
    const group = vi.fn(async (options: { groupId?: number }) => options.groupId ?? 42);
    const update = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", {
      tabs: { group },
      tabGroups: { update }
    });

    const groupIds = await groupTabs("Example", [1, 2, 3], groupedTabs, "in-place");

    expect(groupIds).toEqual([4, 42]);
    expect(group).toHaveBeenCalledWith({
      tabIds: [1, 3],
      groupId: 4
    });
    expect(group).toHaveBeenCalledWith({
      tabIds: [2],
      createProperties: { windowId: 1 }
    });
  });

  it("moves selected tabs into one new window before grouping", async () => {
    const group = vi.fn(async () => 99);
    const move = vi.fn(async () => undefined);
    const update = vi.fn(async () => undefined);
    const create = vi.fn(async () => ({ id: 7 }));
    vi.stubGlobal("chrome", {
      tabs: { group, move },
      tabGroups: { update },
      windows: { create }
    });

    const groupIds = await groupTabs("Example", [1, 2, 3], tabs, "new-window");

    expect(groupIds).toEqual([99]);
    expect(create).toHaveBeenCalledWith({
      focused: true,
      tabId: 2
    });
    expect(move).toHaveBeenCalledWith([3, 1], {
      index: -1,
      windowId: 7
    });
    expect(group).toHaveBeenCalledWith({
      tabIds: [2, 3, 1],
      createProperties: { windowId: 7 }
    });
    expect(update).toHaveBeenCalledWith(99, {
      title: "Example",
      color: "cyan"
    });
  });

  it("reuses an existing group in one-window mode instead of creating another window", async () => {
    const groupedTabs: TabInfo[] = [
      { ...tabs[0] },
      { ...tabs[1], groupId: 5, windowId: 1 },
      { ...tabs[2] }
    ];
    const create = vi.fn();
    const group = vi.fn(async () => 5);
    const move = vi.fn(async () => undefined);
    const updateTab = vi.fn(async () => undefined);
    const updateGroup = vi.fn(async () => undefined);
    const updateWindow = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", {
      tabs: { group, move, update: updateTab },
      tabGroups: { update: updateGroup },
      windows: { create, update: updateWindow }
    });

    const groupIds = await groupTabs("Example", [1, 2, 3], groupedTabs, "new-window");

    expect(groupIds).toEqual([5]);
    expect(create).not.toHaveBeenCalled();
    expect(move).toHaveBeenCalledWith([3, 1], {
      index: -1,
      windowId: 1
    });
    expect(group).toHaveBeenCalledWith({
      tabIds: [2, 3, 1],
      groupId: 5
    });
    expect(updateWindow).toHaveBeenCalledWith(1, { focused: true });
    expect(updateTab).toHaveBeenCalledWith(2, { active: true });
  });

  it("only updates and focuses when the pile is already in one group", async () => {
    const groupedTabs = tabs.map((tab) => ({
      ...tab,
      windowId: 1,
      groupId: 8
    }));
    const create = vi.fn();
    const group = vi.fn();
    const move = vi.fn();
    const updateTab = vi.fn(async () => undefined);
    const updateGroup = vi.fn(async () => undefined);
    const updateWindow = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", {
      tabs: { group, move, update: updateTab },
      tabGroups: { update: updateGroup },
      windows: { create, update: updateWindow }
    });

    const groupIds = await groupTabs("Example", [1, 2, 3], groupedTabs, "new-window");

    expect(groupIds).toEqual([8]);
    expect(create).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
    expect(group).not.toHaveBeenCalled();
    expect(updateGroup).toHaveBeenCalledWith(8, {
      title: "Example",
      color: "cyan"
    });
    expect(updateWindow).toHaveBeenCalledWith(1, { focused: true });
  });
});

describe("groupTabSetsInNewWindow", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("moves all selected clusters into one new window and groups each pile there", async () => {
    const groupedTabs: TabInfo[] = [
      { ...tabs[0], groupId: 4 },
      { ...tabs[1] },
      { ...tabs[2], groupId: 8 }
    ];
    const group = vi.fn(async () => 77);
    const move = vi.fn(async () => undefined);
    const update = vi.fn(async () => undefined);
    const create = vi.fn(async () => ({ id: 9 }));
    vi.stubGlobal("chrome", {
      tabs: { group, move },
      tabGroups: { update },
      windows: { create }
    });

    const groupIds = await groupTabSetsInNewWindow(
      [
        { title: "First pile", tabIds: [1, 3] },
        { title: "Second pile", tabIds: [2] }
      ],
      groupedTabs
    );

    expect(groupIds).toEqual([77, 77]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      focused: true,
      tabId: 2
    });
    expect(move).toHaveBeenCalledWith([3, 1], {
      index: -1,
      windowId: 9
    });
    expect(group).toHaveBeenCalledWith({
      tabIds: [3, 1],
      createProperties: { windowId: 9 }
    });
    expect(group).toHaveBeenCalledWith({
      tabIds: [2],
      createProperties: { windowId: 9 }
    });
    expect(update).toHaveBeenCalledWith(77, {
      title: "First pile",
      color: "cyan"
    });
    expect(update).toHaveBeenCalledWith(77, {
      title: "Second pile",
      color: "cyan"
    });
  });
});
