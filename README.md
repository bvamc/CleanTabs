# CleanTab

CleanTab is a local-first Chrome extension for cleaning messy browser sessions.

V1 is a trust-first cockpit:

- Visualize current tabs as explainable topic groups.
- Save manual workspace snapshots.
- Get local cleanup suggestions for duplicates, stale tabs, same-domain piles, and reference tabs.
- Close only explicitly selected tabs.
- Create an automatic restore snapshot before every close action.

No cloud sync, telemetry, accounts, or remote model calls are used.

## Development

```bash
npm install
npm test
npm run build
```

To try the extension:

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Enable Developer Mode.
4. Load the generated `dist/` folder as an unpacked extension.
5. Click the CleanTab extension action to open the side panel.

## V1 Boundaries

CleanTab uses local heuristics first. Local SLM grouping, command palette hotkeys,
cloud sync, browser-agnostic support, and auto-closing whole groups are intentionally
left for later releases.
