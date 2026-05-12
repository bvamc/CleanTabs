import { describe, expect, it } from "vitest";
import { analyzeTabs, getDomain, getTitleKeywords } from "../lib/analyzeTabs";
import type { TabInfo } from "../lib/types";

const now = new Date("2026-05-12T12:00:00Z").getTime();

function tab(overrides: Partial<TabInfo>): TabInfo {
  return {
    id: overrides.id ?? 1,
    windowId: overrides.windowId ?? 1,
    index: overrides.index ?? 0,
    title: overrides.title ?? "Example",
    url: overrides.url ?? "https://example.com",
    active: overrides.active ?? false,
    pinned: overrides.pinned ?? false,
    lastAccessed: overrides.lastAccessed ?? now,
    ...overrides
  };
}

describe("analyzeTabs", () => {
  it("groups tabs by domain and extracts readable labels", () => {
    const analysis = analyzeTabs(
      [
        tab({ id: 1, title: "React docs hooks", url: "https://react.dev/reference/react" }),
        tab({ id: 2, title: "React docs effects", url: "https://react.dev/learn" }),
        tab({ id: 3, title: "GitHub issue", url: "https://github.com/org/repo/issues/1" })
      ],
      now
    );

    expect(analysis.clusters).toHaveLength(2);
    expect(analysis.clusters[0].domains).toEqual(["react.dev"]);
    expect(analysis.clusters[0].label).toContain("react.dev");
  });

  it("suggests closing duplicate tabs while keeping one copy", () => {
    const analysis = analyzeTabs(
      [
        tab({ id: 1, index: 0, url: "https://example.com/a#top" }),
        tab({ id: 2, index: 1, url: "https://example.com/a" }),
        tab({ id: 3, index: 2, url: "https://example.com/b" })
      ],
      now
    );

    const duplicate = analysis.suggestions.find((suggestion) => suggestion.type === "duplicate");
    expect(duplicate?.tabIds).toEqual([2]);
    expect(analysis.stats.duplicateTabs).toBe(1);
  });

  it("suggests stale tabs but excludes pinned and active tabs", () => {
    const stale = now - 1000 * 60 * 60 * 24 * 8;
    const analysis = analyzeTabs(
      [
        tab({ id: 1, lastAccessed: stale }),
        tab({ id: 2, lastAccessed: stale, pinned: true }),
        tab({ id: 3, lastAccessed: stale, active: true })
      ],
      now
    );

    const staleSuggestion = analysis.suggestions.find((suggestion) => suggestion.type === "stale");
    expect(staleSuggestion?.tabIds).toEqual([1]);
    expect(analysis.stats.staleTabs).toBe(1);
  });

  it("ignores internal browser pages", () => {
    const analysis = analyzeTabs(
      [
        tab({ id: 1, url: "chrome://extensions", title: "Extensions" }),
        tab({ id: 2, url: "https://news.ycombinator.com", title: "Hacker News" })
      ],
      now
    );

    expect(analysis.clusters).toHaveLength(1);
    expect(analysis.clusters[0].domains).toEqual(["news.ycombinator.com"]);
  });
});

describe("tab text helpers", () => {
  it("parses domains safely", () => {
    expect(getDomain("https://www.example.com/path")).toBe("example.com");
    expect(getDomain("not a url")).toBe("unknown");
  });

  it("extracts keywords from long titles", () => {
    expect(getTitleKeywords("Very long React Hooks Reference Documentation", "https://react.dev")).toContain(
      "react"
    );
  });
});
