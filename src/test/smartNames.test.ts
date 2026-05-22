import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateSmartClusterNames,
  generateSmartTabClusters,
  getSmartNameAvailability
} from "../lib/smartNames";
import type { TabCluster, TabInfo } from "../lib/types";

function tab(overrides: Partial<TabInfo>): TabInfo {
  return {
    id: overrides.id ?? 1,
    windowId: overrides.windowId ?? 1,
    index: overrides.index ?? 0,
    title: overrides.title ?? "Example",
    url: overrides.url ?? "https://example.com",
    active: false,
    pinned: false,
    ...overrides
  };
}

function cluster(overrides: Partial<TabCluster>): TabCluster {
  return {
    id: overrides.id ?? "domain:example.com",
    label: overrides.label ?? "Example (example.com)",
    confidence: overrides.confidence ?? 0.86,
    explanation: overrides.explanation ?? "Grouped tabs from example.com.",
    tabIds: overrides.tabIds ?? [1, 2, 3],
    domains: overrides.domains ?? ["example.com"],
    keywords: overrides.keywords ?? ["example"],
    ...overrides
  };
}

function stubLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    })
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("smartNames", () => {
  it("reports unavailable when the browser has no local model API", async () => {
    expect(await getSmartNameAvailability()).toBe("unavailable");
  });

  it("returns an empty map when the local model is unavailable", async () => {
    vi.stubGlobal("LanguageModel", {
      availability: vi.fn().mockResolvedValue("unavailable"),
      create: vi.fn()
    });

    await expect(generateSmartClusterNames([cluster({})], [])).resolves.toEqual({});
  });

  it("generates compact names from local model JSON", async () => {
    stubLocalStorage();
    const prompt = vi.fn().mockResolvedValue(
      JSON.stringify([
        {
          id: "domain:github.com",
          label: "CleanTab Issues",
          reason: "Several GitHub issue tabs."
        }
      ])
    );
    const destroy = vi.fn();
    vi.stubGlobal("LanguageModel", {
      availability: vi.fn().mockResolvedValue("available"),
      create: vi.fn().mockResolvedValue({ prompt, destroy })
    });

    const names = await generateSmartClusterNames(
      [
        cluster({
          id: "domain:github.com",
          label: "Github / Issues (github.com)",
          tabIds: [1, 2, 3],
          domains: ["github.com"],
          keywords: ["github", "issues"]
        })
      ],
      [
        tab({ id: 1, title: "CleanTab issue 12", url: "https://github.com/org/cleantab/issues/12?secret=1" }),
        tab({ id: 2, title: "CleanTab issue 13", url: "https://github.com/org/cleantab/issues/13" }),
        tab({ id: 3, title: "Pull requests", url: "https://github.com/org/cleantab/pulls" })
      ]
    );

    expect(names["domain:github.com"]).toEqual({
      label: "CleanTab Issues",
      reason: "Several GitHub issue tabs."
    });
    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt.mock.calls[0][0]).not.toContain("secret=1");
    const languageModel = globalThis as typeof globalThis & {
      LanguageModel: {
        availability: ReturnType<typeof vi.fn>;
        create: ReturnType<typeof vi.fn>;
      };
    };
    expect(languageModel.LanguageModel.availability).toHaveBeenCalledWith({
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }]
    });
    expect(languageModel.LanguageModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedInputs: [{ type: "text", languages: ["en"] }],
        expectedOutputs: [{ type: "text", languages: ["en"] }]
      })
    );
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("generates topic clusters from model output and ignores bad tab ids", async () => {
    stubLocalStorage();
    vi.stubGlobal("LanguageModel", {
      availability: vi.fn().mockResolvedValue("available"),
      create: vi.fn().mockResolvedValue({
        prompt: vi.fn().mockResolvedValue(
          JSON.stringify([
            {
              label: "CleanTab Planning",
              reason: "Product and implementation tabs.",
              tabIds: [1, 2, 99]
            },
            {
              label: "React Reference",
              reason: "React docs and examples.",
              tabIds: [3, 4]
            }
          ])
        ),
        destroy: vi.fn()
      })
    });

    const clusters = await generateSmartTabClusters([
      tab({ id: 1, title: "CleanTab PRD", url: "https://docs.google.com/document/d/abc?token=secret" }),
      tab({ id: 2, title: "CleanTab GitHub issue", url: "https://github.com/org/cleantab/issues/1" }),
      tab({ id: 3, title: "React useEffect", url: "https://react.dev/reference/react/useEffect" }),
      tab({ id: 4, title: "React hooks", url: "https://react.dev/reference/react" })
    ]);

    expect(clusters).toHaveLength(2);
    expect(clusters[0].label).toBe("CleanTab Planning");
    expect(clusters[0].tabIds).toEqual([1, 2]);
    expect(clusters[1].tabIds).toEqual([3, 4]);
  });

  it("does not ask AI to regroup existing Chrome groups", async () => {
    stubLocalStorage();
    const prompt = vi.fn().mockResolvedValue(
      JSON.stringify([
        {
          label: "React Reference",
          reason: "React docs and examples.",
          tabIds: [1, 2, 3, 4]
        }
      ])
    );
    vi.stubGlobal("LanguageModel", {
      availability: vi.fn().mockResolvedValue("available"),
      create: vi.fn().mockResolvedValue({
        prompt,
        destroy: vi.fn()
      })
    });

    const clusters = await generateSmartTabClusters([
      tab({ id: 1, title: "Already grouped one", url: "https://example.com/a", groupId: 7 }),
      tab({ id: 2, title: "Already grouped two", url: "https://example.com/b", groupId: 7 }),
      tab({ id: 3, title: "React useEffect", url: "https://react.dev/reference/react/useEffect" }),
      tab({ id: 4, title: "React hooks", url: "https://react.dev/reference/react" })
    ]);

    expect(prompt.mock.calls[0][0]).not.toContain('"id":1');
    expect(prompt.mock.calls[0][0]).not.toContain('"id":2');
    expect(clusters[0].tabIds).toEqual([3, 4]);
  });

  it("rejects vague cross-product clusters from the model", async () => {
    stubLocalStorage();
    vi.stubGlobal("LanguageModel", {
      availability: vi.fn().mockResolvedValue("available"),
      create: vi.fn().mockResolvedValue({
        prompt: vi.fn().mockResolvedValue(
          JSON.stringify([
            {
              label: "Google Gemini Exploration",
              reason: "AI and design exploration tabs.",
              tabIds: [1, 2, 3, 4, 5]
            },
            {
              label: "Google Flights Seattle",
              reason: "Seattle related planning.",
              tabIds: [6, 7]
            }
          ])
        ),
        destroy: vi.fn()
      })
    });

    const clusters = await generateSmartTabClusters([
      tab({ id: 1, title: "Pricing - Raindrop.io", url: "https://raindrop.io/pro/buy" }),
      tab({ id: 2, title: "Loading...", url: "https://app.raindrop.io/my/123" }),
      tab({ id: 3, title: "ai-video-generation by infsh-skills/skills", url: "https://skills.sh/infsh-skills/skills/ai-video-generation" }),
      tab({ id: 4, title: "Stitch - Design with AI", url: "https://stitch.withgoogle.com" }),
      tab({ id: 5, title: "How To Pick And Analyze Stocks - YouTube", url: "https://youtube.com/watch?v=1" }),
      tab({ id: 6, title: "Best Tech Jobs & Startup Jobs in Seattle", url: "https://builtinseattle.com/jobs?city=Seattle" }),
      tab({ id: 7, title: "Bengaluru to Seattle | Google Flights", url: "https://google.com/travel/flights/search" })
    ]);

    expect(clusters).toEqual([]);
  });

  it("does not trust broad sites without a shared repo or product signal", async () => {
    stubLocalStorage();
    vi.stubGlobal("LanguageModel", {
      availability: vi.fn().mockResolvedValue("available"),
      create: vi.fn().mockResolvedValue({
        prompt: vi.fn().mockResolvedValue(
          JSON.stringify([
            {
              label: "GitHub Work",
              reason: "Both are GitHub tabs.",
              tabIds: [1, 2]
            }
          ])
        ),
        destroy: vi.fn()
      })
    });

    const clusters = await generateSmartTabClusters([
      tab({ id: 1, title: "rails pull request", url: "https://github.com/rails/rails/pull/1" }),
      tab({ id: 2, title: "react issue", url: "https://github.com/facebook/react/issues/2" })
    ]);

    expect(clusters).toEqual([]);
  });
});
