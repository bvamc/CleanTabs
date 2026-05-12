import type {
  CleanupSuggestion,
  TabAnalysis,
  TabCluster,
  TabInfo,
  TabStats
} from "./types";

const STALE_TAB_MS = 1000 * 60 * 60 * 24 * 7;
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "http",
  "https",
  "www",
  "com",
  "app",
  "docs",
  "login",
  "dashboard"
]);

export function analyzeTabs(tabs: TabInfo[], now = Date.now()): TabAnalysis {
  const usableTabs = tabs.filter((tab) => tab.url && !isInternalUrl(tab.url));
  const clusters = buildClusters(usableTabs);
  const suggestions = buildSuggestions(usableTabs, clusters, now);
  const stats = buildStats(tabs, clusters, suggestions);

  return { clusters, suggestions, stats };
}

export function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

export function getTitleKeywords(title: string, url: string): string[] {
  const domain = getDomain(url).split(".")[0] ?? "";
  const words = `${title} ${domain}`
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));

  return Array.from(new Set(words)).slice(0, 6);
}

function buildClusters(tabs: TabInfo[]): TabCluster[] {
  const domainGroups = new Map<string, TabInfo[]>();
  for (const tab of tabs) {
    const domain = getDomain(tab.url);
    const current = domainGroups.get(domain) ?? [];
    current.push(tab);
    domainGroups.set(domain, current);
  }

  const clusters: TabCluster[] = Array.from(domainGroups.entries())
    .map(([domain, group]) => {
      const keywords = topKeywords(group);
      return {
        id: `domain:${domain}`,
        label: labelForGroup(domain, keywords),
        confidence: group.length >= 3 ? 0.86 : 0.68,
        explanation:
          group.length >= 3
            ? `Grouped ${group.length} tabs from ${domain}.`
            : `Small domain group from ${domain}.`,
        tabIds: group.map((tab) => tab.id),
        domains: [domain],
        keywords
      };
    })
    .sort((a, b) => b.tabIds.length - a.tabIds.length || a.label.localeCompare(b.label));

  return clusters;
}

function buildSuggestions(
  tabs: TabInfo[],
  clusters: TabCluster[],
  now: number
): CleanupSuggestion[] {
  const suggestions: CleanupSuggestion[] = [];
  const byUrl = new Map<string, TabInfo[]>();

  for (const tab of tabs) {
    const key = normalizeUrl(tab.url);
    const current = byUrl.get(key) ?? [];
    current.push(tab);
    byUrl.set(key, current);
  }

  for (const [url, group] of byUrl.entries()) {
    if (group.length > 1) {
      const closable = group
        .slice()
        .sort((a, b) => Number(b.active) - Number(a.active) || a.index - b.index)
        .slice(1)
        .map((tab) => tab.id);
      suggestions.push({
        id: `duplicate:${url}`,
        type: "duplicate",
        title: `${group.length} duplicate tabs`,
        reason: "Same URL appears more than once. Keep one copy and close the rest.",
        tabIds: closable
      });
    }
  }

  for (const cluster of clusters) {
    if (cluster.tabIds.length >= 5) {
      suggestions.push({
        id: `pile:${cluster.id}`,
        type: "same-domain-pile",
        title: `${cluster.label} pile`,
        reason: `${cluster.tabIds.length} tabs share the same domain. Review this cluster first.`,
        tabIds: cluster.tabIds
      });
    }
  }

  const staleTabs = tabs.filter((tab) => {
    if (tab.pinned || tab.active || !tab.lastAccessed) return false;
    return now - tab.lastAccessed > STALE_TAB_MS;
  });

  if (staleTabs.length > 0) {
    suggestions.push({
      id: "stale:week-old",
      type: "stale",
      title: `${staleTabs.length} stale tabs`,
      reason: "These tabs have not been accessed in over a week and are not pinned.",
      tabIds: staleTabs.map((tab) => tab.id)
    });
  }

  const likelyReferenceTabs = tabs.filter((tab) => {
    const url = tab.url.toLowerCase();
    return /docs|reference|api|readme|github\.com|stackoverflow\.com/.test(url);
  });

  if (likelyReferenceTabs.length > 0) {
    suggestions.push({
      id: "reference:known-sites",
      type: "likely-reference",
      title: `${likelyReferenceTabs.length} reference tabs`,
      reason: "Docs, code, and Q&A pages are often worth snapshotting before cleanup.",
      tabIds: likelyReferenceTabs.map((tab) => tab.id)
    });
  }

  return suggestions.filter((suggestion) => suggestion.tabIds.length > 0);
}

function buildStats(
  tabs: TabInfo[],
  clusters: TabCluster[],
  suggestions: CleanupSuggestion[]
): TabStats {
  return {
    totalTabs: tabs.length,
    totalWindows: new Set(tabs.map((tab) => tab.windowId)).size,
    duplicateTabs: suggestions
      .filter((suggestion) => suggestion.type === "duplicate")
      .reduce((count, suggestion) => count + suggestion.tabIds.length, 0),
    staleTabs:
      suggestions.find((suggestion) => suggestion.type === "stale")?.tabIds.length ?? 0,
    largestClusterSize: clusters[0]?.tabIds.length ?? 0
  };
}

function topKeywords(tabs: TabInfo[]): string[] {
  const counts = new Map<string, number>();
  for (const tab of tabs) {
    for (const keyword of getTitleKeywords(tab.title, tab.url)) {
      counts.set(keyword, (counts.get(keyword) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([keyword]) => keyword)
    .slice(0, 4);
}

function labelForGroup(domain: string, keywords: string[]): string {
  if (keywords.length === 0) return domain;
  const readable = keywords
    .slice(0, 2)
    .map((keyword) => keyword.charAt(0).toUpperCase() + keyword.slice(1))
    .join(" / ");
  return `${readable} (${domain})`;
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    if (parsed.pathname !== "/") {
      parsed.pathname = parsed.pathname.replace(/\/$/, "");
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function isInternalUrl(url: string): boolean {
  return /^(chrome|chrome-extension|edge|about):/i.test(url);
}
