# CleanTab Privacy

CleanTab is designed to run locally in Chrome.

- No accounts.
- No telemetry.
- No cloud sync.
- No remote model calls.
- Snapshots are stored in Chrome extension storage.
- Group drafts and display preferences are stored locally in the browser.
- When Chrome's on-device LanguageModel API is available, CleanTab sends only tab titles, domains, paths, ids, and pinned/active flags to that local API.

The extension permissions are limited to tab cleanup and organization:

- `tabs` reads, focuses, moves, restores, and closes tabs.
- `tabGroups` creates and updates Chrome tab groups.
- `storage` stores snapshots and local settings.
- `alarms` periodically checks or warms the local on-device model when smart names are enabled.
