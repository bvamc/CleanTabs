import type { TabCluster, TabInfo } from "./types";

export type SmartNameStatus = "disabled" | "loading" | "ready" | "unavailable" | "error";

export interface SmartClusterName {
  label: string;
  reason: string;
}

export type SmartNameMap = Record<string, SmartClusterName>;

type LanguageModelAvailability = "available" | "downloadable" | "downloading" | "unavailable";

interface LanguageModelSession {
  prompt(input: string): Promise<string>;
  destroy?: () => void;
}

interface LanguageModelFactory {
  availability?: (options?: LanguageModelOptions) => Promise<LanguageModelAvailability> | LanguageModelAvailability;
  create(options?: {
    initialPrompts?: Array<{
      role: "system" | "user" | "assistant";
      content: string;
    }>;
    expectedInputs?: Array<{ type: "text"; languages: string[] }>;
    expectedOutputs?: Array<{ type: "text"; languages: string[] }>;
  }): Promise<LanguageModelSession>;
}

interface LanguageModelOptions {
  expectedInputs?: Array<{ type: "text"; languages: string[] }>;
  expectedOutputs?: Array<{ type: "text"; languages: string[] }>;
}

interface SmartClusterPayload {
  id: string;
  currentLabel: string;
  domains: string[];
  keywords: string[];
  tabs: Array<{
    title: string;
    domain: string;
    path: string;
  }>;
}

const CACHE_KEY = "cleantab.smartNameCache.v1";
const CLUSTER_CACHE_KEY = "cleantab.smartClusterCache.v2";
const MAX_CLUSTERS_PER_PROMPT = 12;
const MAX_TABS_PER_CLUSTER = 10;
const MAX_TABS_FOR_CLUSTERING = 90;
const MAX_TITLE_LENGTH = 90;
const MAX_LABEL_LENGTH = 34;
const MAX_REASON_LENGTH = 70;
const LANGUAGE_MODEL_OPTIONS: LanguageModelOptions = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }]
};
const STOP_WORDS = new Set([
  "about",
  "account",
  "after",
  "again",
  "ai",
  "and",
  "app",
  "are",
  "buy",
  "can",
  "com",
  "complete",
  "dashboard",
  "design",
  "docs",
  "for",
  "from",
  "get",
  "google",
  "git",
  "github",
  "guide",
  "have",
  "how",
  "https",
  "into",
  "loading",
  "login",
  "new",
  "open",
  "page",
  "pricing",
  "pro",
  "project",
  "startup",
  "search",
  "tab",
  "tech",
  "the",
  "this",
  "video",
  "with",
  "www",
  "youtube"
]);
const GENERIC_HOST_FAMILIES = new Set([
  "github.com",
  "google.com",
  "youtube.com",
  "youtu.be"
]);
const LOCATION_WORDS = new Set([
  "bengaluru",
  "california",
  "london",
  "newyork",
  "seattle",
  "washington"
]);

export function getSmartNameAvailability(): Promise<LanguageModelAvailability> {
  const model = getLanguageModel();
  if (!model) return Promise.resolve("unavailable");

  try {
    const availability = model.availability?.(LANGUAGE_MODEL_OPTIONS);
    if (!availability) return Promise.resolve("available");
    return Promise.resolve(availability).catch(() => "unavailable");
  } catch {
    return Promise.resolve("unavailable");
  }
}

export function clearSmartNameCaches() {
  try {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(CLUSTER_CACHE_KEY);
  } catch {
    // Cache clearing is best-effort; generation can continue with current memory state.
  }
}

export async function generateSmartClusterNames(
  clusters: TabCluster[],
  tabs: TabInfo[]
): Promise<SmartNameMap> {
  const targetClusters = clusters
    .filter((cluster) => cluster.tabIds.length >= 3)
    .slice(0, MAX_CLUSTERS_PER_PROMPT);

  if (targetClusters.length === 0) return {};

  const payloads = targetClusters.map((cluster) => buildPayload(cluster, tabs));
  const cache = readCache();
  const cached: SmartNameMap = {};
  const missing: SmartClusterPayload[] = [];

  for (const payload of payloads) {
    const cacheKey = cacheKeyForPayload(payload);
    const cachedName = cache[cacheKey];
    if (cachedName) {
      cached[payload.id] = cachedName;
    } else {
      missing.push(payload);
    }
  }

  if (missing.length === 0) return cached;

  const model = getLanguageModel();
  if (!model) return cached;

  const availability = await getSmartNameAvailability();
  if (availability === "unavailable" || availability === "downloading") return cached;

  let session: LanguageModelSession | null = null;
  try {
    session = await model.create({
      ...LANGUAGE_MODEL_OPTIONS,
      initialPrompts: [
        {
          role: "system",
          content:
            "You name browser tab clusters for a local tab cleanup tool. Return compact, useful labels. Do not invent details."
        }
      ]
    });
    const raw = await session.prompt(buildPrompt(missing));
    const generated = parseSmartNames(raw, missing);

    for (const payload of missing) {
      const smartName = generated[payload.id];
      if (smartName) {
        cache[cacheKeyForPayload(payload)] = smartName;
      }
    }
    writeCache(cache);

    return { ...cached, ...generated };
  } catch {
    return cached;
  } finally {
    session?.destroy?.();
  }
}

export async function generateSmartTabClusters(tabs: TabInfo[]): Promise<TabCluster[]> {
  const candidates = tabs
    .filter((tab) => tab.url && !isInternalUrl(tab.url) && !isAlreadyGrouped(tab))
    .slice(0, MAX_TABS_FOR_CLUSTERING);

  if (candidates.length < 2) return [];

  const cacheKey = stableHash(JSON.stringify(candidates.map(tabPayloadForClustering)));
  const cached = readClusterCache()[cacheKey];
  if (cached) return cached;

  const model = getLanguageModel();
  if (!model) return [];

  const availability = await getSmartNameAvailability();
  if (availability === "unavailable" || availability === "downloading") return [];

  let session: LanguageModelSession | null = null;
  try {
    session = await model.create({
      ...LANGUAGE_MODEL_OPTIONS,
      initialPrompts: [
        {
          role: "system",
          content:
            "You organize browser tabs into actionable cleanup groups for a local-only tab manager. Use only provided tab ids. Return JSON only. Group strictly by granular intention (e.g. 'React UI Libraries', not just a broad 'Coding'). Do not mix unrelated domains unless they share highly specific keywords."
        }
      ]
    });
    const raw = await session.prompt(buildClusterPrompt(candidates));
    const clusters = parseSmartClusters(raw, candidates);
    if (clusters.length > 0) {
      const cache = readClusterCache();
      cache[cacheKey] = clusters;
      writeClusterCache(cache);
    }
    return clusters;
  } catch {
    return [];
  } finally {
    session?.destroy?.();
  }
}

function getLanguageModel(): LanguageModelFactory | undefined {
  return (globalThis as typeof globalThis & { LanguageModel?: LanguageModelFactory }).LanguageModel;
}

function buildPayload(cluster: TabCluster, tabs: TabInfo[]): SmartClusterPayload {
  const ids = new Set(cluster.tabIds);
  const clusterTabs = tabs
    .filter((tab) => ids.has(tab.id))
    .slice(0, MAX_TABS_PER_CLUSTER)
    .map((tab) => ({
      title: sanitizeTitle(tab.title),
      domain: domainForUrl(tab.url),
      path: pathForUrl(tab.url)
    }));

  return {
    id: cluster.id,
    currentLabel: cluster.label,
    domains: cluster.domains.slice(0, 3),
    keywords: cluster.keywords.slice(0, 5),
    tabs: clusterTabs
  };
}

function buildPrompt(payloads: SmartClusterPayload[]): string {
  return [
    "Return only JSON in this shape:",
    '[{"id":"cluster id","label":"2-5 word useful name","reason":"short reason based on titles/domains"}]',
    "Rules: keep labels under 34 characters; avoid private-looking exact titles; prefer task/project names over site names when obvious.",
    "Clusters:",
    JSON.stringify(payloads)
  ].join("\n");
}

function buildClusterPrompt(tabs: TabInfo[]): string {
  return [
    "Group browser tabs only when they clearly belong to the same concrete task, product, repository, document set, or research thread.",
    "Return only JSON in this shape:",
    '[{"label":"2-5 word group name","reason":"short actionable reason","tabIds":[1,2,3]}]',
    "Rules: precision over recall. Leave tabs out when unsure. Do not group tabs merely because they mention AI, Google, video, pricing, docs, or design. Do not mix unrelated products. Extremely strict rule: A cross-domain tab MUST share highly specific proper nouns with the rest of the group. Each group needs 2-8 tabs. Keep labels under 34 characters.",
    "Tabs:",
    JSON.stringify(tabs.map(tabPayloadForClustering))
  ].join("\n");
}

function tabPayloadForClustering(tab: TabInfo) {
  return {
    id: tab.id,
    title: sanitizeTitle(tab.title),
    domain: domainForUrl(tab.url),
    path: pathForUrl(tab.url),
    pinned: tab.pinned,
    active: tab.active
  };
}

function parseSmartNames(raw: string, payloads: SmartClusterPayload[]): SmartNameMap {
  const payloadIds = new Set(payloads.map((payload) => payload.id));
  const parsed = parseJsonArray(raw);
  if (!Array.isArray(parsed)) return {};

  const names: SmartNameMap = {};
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === "string" ? item.id : "";
    const label = typeof item.label === "string" ? normalizeText(item.label, MAX_LABEL_LENGTH) : "";
    const reason = typeof item.reason === "string" ? normalizeText(item.reason, MAX_REASON_LENGTH) : "";
    if (!payloadIds.has(id) || label.length < 2) continue;
    names[id] = {
      label,
      reason: reason || "Named locally from tab titles and domains."
    };
  }

  return names;
}

function parseSmartClusters(raw: string, tabs: TabInfo[]): TabCluster[] {
  const parsed = parseJsonArray(raw);
  if (!Array.isArray(parsed)) return [];

  const tabIds = new Set(tabs.map((tab) => tab.id));
  const used = new Set<number>();
  const clusters: TabCluster[] = [];

  parsed.slice(0, 10).forEach((item, index) => {
    if (!isRecord(item)) return;
    const rawIds = Array.isArray(item.tabIds) ? item.tabIds : [];
    const ids = Array.from(
      new Set(
        rawIds
          .filter((id): id is number => typeof id === "number" && tabIds.has(id) && !used.has(id))
      )
    );
    if (ids.length < 2) return;

    const label =
      typeof item.label === "string"
        ? normalizeText(item.label, MAX_LABEL_LENGTH)
        : `Smart group ${clusters.length + 1}`;
    const reason =
      typeof item.reason === "string"
        ? normalizeText(item.reason, MAX_REASON_LENGTH)
        : "Grouped locally from tab titles and domains.";
    const clusterTabs = tabs.filter((tab) => ids.includes(tab.id));
    const validation = validateCluster(clusterTabs, label, reason);
    if (!validation.valid) return;

    const dominantDomainFamily = mostCommon(clusterTabs.map((t) => hostFamily(domainForUrl(t.url))));
    const isGeneric = GENERIC_HOST_FAMILIES.has(dominantDomainFamily);
    
    // STRICTLY Prune outliers
    const prunedIds = ids.filter((id) => {
      const tab = clusterTabs.find((t) => t.id === id);
      if (!tab) return false;
      const tabTokens = significantTokens(`${tab.title} ${domainForUrl(tab.url)} ${pathForUrl(tab.url)}`);
      const sharesToken = validation.keywords.some((k) => tabTokens.includes(k));
      const sharesDomain = hostFamily(domainForUrl(tab.url)) === dominantDomainFamily && !isGeneric;
      return sharesToken || sharesDomain;
    });

    if (prunedIds.length < 2) return;

    const prunedTabs = tabs.filter((tab) => prunedIds.includes(tab.id));
    const domains = Array.from(new Set(prunedTabs.map((tab) => domainForUrl(tab.url)))).slice(0, 4);

    prunedIds.forEach((id) => used.add(id));

    clusters.push({
      id: `smart:${index}:${stableHash(prunedIds.join(","))}`,
      label: label || `Smart group ${clusters.length + 1}`,
      confidence: validation.confidence,
      explanation: reason || validation.explanation,
      tabIds: prunedIds,
      domains,
      keywords: validation.keywords
    });
  });

  return clusters.sort((first, second) => second.tabIds.length - first.tabIds.length);
}

function validateCluster(
  tabs: TabInfo[],
  label: string,
  reason: string
): { valid: boolean; confidence: number; explanation: string; keywords: string[] } {
  const domains = tabs.map((tab) => domainForUrl(tab.url));
  const sameDomainCount = largestCount(domains);
  const hostFamilies = tabs.map((tab) => hostFamily(domainForUrl(tab.url)));
  const sameFamilyCount = largestCount(hostFamilies);
  const dominantFamily = mostCommon(hostFamilies);
  const isGenericFamily = GENERIC_HOST_FAMILIES.has(dominantFamily);
  const productTokens = commonProductTokens(tabs);
  const labelTokens = significantTokens(`${label} ${reason}`);
  const labelOverlap = labelTokens.filter((token) => productTokens.includes(token));
  const domainCoverage = Math.max(sameDomainCount, sameFamilyCount) / tabs.length;
  const hasStrongDomainCohesion =
    ((tabs.length === 2 && sameFamilyCount === 2) || domainCoverage >= 0.6) &&
    (!isGenericFamily || productTokens.some((token) => isEntityToken(token, tabs)));
  const hasStrongTokenCohesion =
    productTokens.length >= 2 ||
    (productTokens.length === 1 &&
      labelOverlap.includes(productTokens[0]) &&
      isEntityToken(productTokens[0], tabs));

  if (!hasStrongDomainCohesion && !hasStrongTokenCohesion) {
    return { valid: false, confidence: 0, explanation: "", keywords: [] };
  }

  if (tabs.length > 4 && domainCoverage < 0.6 && productTokens.length < 2) {
    return { valid: false, confidence: 0, explanation: "", keywords: [] };
  }

  const confidence = Math.min(
    0.92,
    0.64 + (sameDomainCount / tabs.length) * 0.18 + (productTokens.length > 0 ? 0.1 : 0)
  );

  return {
    valid: true,
    confidence,
    explanation: hasStrongTokenCohesion
      ? `Shared topic: ${productTokens.slice(0, 2).join(", ")}.`
      : `Shared site: ${mostCommon(domains)}.`,
    keywords: productTokens.slice(0, 5)
  };
}

function commonProductTokens(tabs: TabInfo[]): string[] {
  const counts = new Map<string, number>();
  for (const tab of tabs) {
    const tokens = new Set(significantTokens(`${tab.title} ${domainForUrl(tab.url)} ${pathForUrl(tab.url)}`));
    for (const token of tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .filter(([, count]) => count >= 2)
    .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))
    .map(([token]) => token)
    .slice(0, 6);
}

function significantTokens(value: string): string[] {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/[\s-]+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 2 && !STOP_WORDS.has(token) && !LOCATION_WORDS.has(token))
    )
  );
}

function isEntityToken(token: string, tabs: TabInfo[]): boolean {
  if (LOCATION_WORDS.has(token)) return false;
  return tabs.some((tab) => significantTokens(`${domainForUrl(tab.url)} ${pathForUrl(tab.url)}`).includes(token));
}

function largestCount(values: string[]): number {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts.entries()).sort((first, second) => second[1] - first[1])[0]?.[0] ?? "";
}

function hostFamily(domain: string): string {
  const parts = domain.split(".").filter(Boolean);
  if (parts.length <= 2) return domain;
  return parts.slice(-2).join(".");
}

function parseJsonArray(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function readCache(): Record<string, SmartClusterName> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? (parsed as Record<string, SmartClusterName>) : {};
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, SmartClusterName>) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(trimCache(cache)));
  } catch {
    // Cache failure should never affect cleanup.
  }
}

function readClusterCache(): Record<string, TabCluster[]> {
  try {
    const raw = localStorage.getItem(CLUSTER_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? (parsed as Record<string, TabCluster[]>) : {};
  } catch {
    return {};
  }
}

function writeClusterCache(cache: Record<string, TabCluster[]>) {
  try {
    localStorage.setItem(CLUSTER_CACHE_KEY, JSON.stringify(Object.fromEntries(Object.entries(cache).slice(-24))));
  } catch {
    // Cache failure should never affect cleanup.
  }
}

function trimCache(cache: Record<string, SmartClusterName>): Record<string, SmartClusterName> {
  return Object.fromEntries(Object.entries(cache).slice(-80));
}

function cacheKeyForPayload(payload: SmartClusterPayload): string {
  return `${payload.id}:${stableHash(JSON.stringify(payload))}`;
}

function stableHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(index) | 0;
  }
  return Math.abs(hash).toString(36);
}

function sanitizeTitle(title: string): string {
  return normalizeText(title.replace(/\s+/g, " "), MAX_TITLE_LENGTH);
}

function normalizeText(value: string, maxLength: number): string {
  return value
    .replace(/["{}[\]\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function domainForUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function pathForUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname.split("/").filter(Boolean).slice(0, 3).join("/");
  } catch {
    return "";
  }
}

function isInternalUrl(url: string): boolean {
  return /^(chrome|chrome-extension|edge|about):/i.test(url);
}

function isAlreadyGrouped(tab: TabInfo): boolean {
  return tab.groupId !== undefined && tab.groupId >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
