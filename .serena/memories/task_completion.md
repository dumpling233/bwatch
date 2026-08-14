# Task Completion

- For code changes: run `npm.cmd test` before final response.
- For PRD/log changes: run `python .agent\skills\prd-keeper\scripts\check_prd_keeper.py --log-file docs\prd\prd_log\YYYYMMDD-{git-user}.md`.
- For deliverable VSIX updates: run `npx.cmd vsce package` after tests pass.
- Final response should mention code change, PRD/log status, verification results, and known risks/warnings.