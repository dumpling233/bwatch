# Conventions

- Follow PRD keeper for non-trivial work: read relevant PRD before code, update PRD/log after behavior or interface changes.
- Keep VSCode API boundaries in extension/provider classes; keep Bilibili response normalization in `src/bilibiliClient.ts` so Node tests can cover it.
- Webview UI is plain JS/CSS; no frontend framework.
- Auto refresh interval must be clamped to at least 15 seconds in config/UI behavior.
- Bilibili APIs are treated as unstable external services; failures should show unknown/error state and avoid crashing the extension.
- User-facing replies should be Chinese.