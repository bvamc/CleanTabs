import { describe, expect, it } from "vitest";
import { pruneSnapshots } from "../lib/snapshots";
import type { TabSnapshot } from "../lib/types";

function snapshot(index: number, source: TabSnapshot["source"]): TabSnapshot {
  return {
    id: `${source}-${index}`,
    name: `${source} ${index}`,
    createdAt: 1000 - index,
    source,
    windows: []
  };
}

describe("pruneSnapshots", () => {
  it("keeps all manual snapshots", () => {
    const snapshots = Array.from({ length: 25 }, (_, index) => snapshot(index, "manual"));
    expect(pruneSnapshots(snapshots)).toHaveLength(25);
  });

  it("keeps only the newest automatic before-close snapshots", () => {
    const snapshots = Array.from({ length: 25 }, (_, index) =>
      snapshot(index, "auto-before-close")
    );

    const pruned = pruneSnapshots(snapshots);

    expect(pruned).toHaveLength(20);
    expect(pruned.map((item) => item.id)).not.toContain("auto-before-close-24");
  });

  it("sorts snapshots newest first after pruning", () => {
    const pruned = pruneSnapshots([
      snapshot(5, "manual"),
      snapshot(1, "auto-before-close"),
      snapshot(3, "manual")
    ]);

    expect(pruned.map((item) => item.createdAt)).toEqual([999, 997, 995]);
  });
});
