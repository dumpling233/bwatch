# Tech Stack

- Language: TypeScript for VSCode extension host and Node-tested core logic.
- Runtime/framework: VSCode Extension API, WebviewViewProvider, plain webview JS/CSS in `media/`.
- Package manager/scripts: npm via `npm.cmd` on Windows.
- Build output: TypeScript compiles to `out/`.
- Tests: Node built-in test runner over compiled `out/test/**/*.test.js`.
- Packaging: `vsce` via `npx.cmd vsce package`, producing `bwatch-0.1.0.vsix`.