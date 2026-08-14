#!/usr/bin/env python3
"""Validate the project-local prd-keeper structure."""

from __future__ import annotations

import argparse
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
SKILL = ROOT / ".agent" / "skills" / "prd-keeper"
PRD_ROOT = ROOT / "docs" / "prd"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def fail(message: str, errors: list[str]) -> None:
    errors.append(message)


def git_writer() -> str:
    for key in ["user.name", "user.email"]:
        try:
            result = subprocess.run(
                ["git", "config", key],
                cwd=ROOT,
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        except OSError:
            continue
        value = result.stdout.strip()
        if value:
            return value
    return "unknown"


def safe_writer(value: str) -> str:
    safe = re.sub(r'[\\/:*?"<>|\s]+', "-", value.strip())
    safe = safe.strip(".-")
    return safe or "unknown"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--log-file",
        help="Expected PRD log file, e.g. docs/prd/prd_log/20260520-zhuzhuolin.md",
    )
    args = parser.parse_args()

    log_path: Path | None = None
    if args.log_file:
        log_path = Path(args.log_file)
        if not log_path.is_absolute():
            log_path = ROOT / log_path

    errors: list[str] = []
    required = [
        SKILL / "SKILL.md",
        SKILL / "routing.yaml",
        SKILL / "rules" / "agent-behavior.md",
        SKILL / "rules" / "prd-governance.md",
        SKILL / "workflows" / "setup-agent-entry.md",
        SKILL / "workflows" / "profile-project.md",
        SKILL / "workflows" / "progressive-adoption.md",
        SKILL / "workflows" / "change-managed.md",
        SKILL / "workflows" / "maintain-prd.md",
        SKILL / "workflows" / "task-closure.md",
        SKILL / "references" / "project-map.md",
        SKILL / "references" / "gotchas.md",
        SKILL / "scripts" / "new_prd_log.py",
        PRD_ROOT / "README.md",
        PRD_ROOT / "product-overview.md",
        PRD_ROOT / "architecture.md",
        PRD_ROOT / "modules" / "README.md",
        PRD_ROOT / "modules" / "prd-keeper.md",
        PRD_ROOT / "prd_log",
        ROOT / "AGENTS.md",
        ROOT / "CODEX.md",
        ROOT / "CLAUDE.md",
    ]
    if log_path is not None:
        required.append(log_path)

    for path in required:
        if not path.exists():
            fail(f"Missing required file: {path.relative_to(ROOT)}", errors)

    if not errors:
        skill_text = read(SKILL / "SKILL.md")
        if not skill_text.startswith("---\nname: prd-keeper\n"):
            fail("SKILL.md frontmatter is invalid or not first.", errors)
        if "## Always Read" not in skill_text or "## Common Tasks" not in skill_text:
            fail("SKILL.md must contain Always Read and Common Tasks sections.", errors)

        routing = read(SKILL / "routing.yaml")
        progressive_route = re.search(r"(?ms)^  progressive_adoption:\n(?P<body>.*?)(?=^  [A-Za-z0-9_]+:|\Z)", routing)
        if progressive_route is None:
            fail("routing.yaml must define progressive_adoption route.", errors)
        elif "workflows/progressive-adoption.md" not in progressive_route.group("body"):
            fail("progressive_adoption route must read workflows/progressive-adoption.md.", errors)

        change_route = re.search(r"(?ms)^  change_managed:\n(?P<body>.*?)(?=^  [A-Za-z0-9_]+:|\Z)", routing)
        if change_route is None:
            fail("routing.yaml must define change_managed route.", errors)
        elif "workflows/progressive-adoption.md" not in change_route.group("body"):
            fail("change_managed route must read workflows/progressive-adoption.md.", errors)

        for rel in re.findall(r"(?:rules|workflows|references)/[A-Za-z0-9._/-]+", routing + "\n" + skill_text):
            if not (SKILL / rel).exists():
                fail(f"Route references missing file: {rel}", errors)

        shell_needles = [
            ".agent/skills/prd-keeper/SKILL.md",
            ".agent/skills/prd-keeper/routing.yaml",
            "docs/prd/README.md",
            "docs/prd/prd_log",
        ]
        for shell in ["AGENTS.md", "CODEX.md", "CLAUDE.md"]:
            text = read(ROOT / shell)
            for needle in shell_needles:
                if needle not in text:
                    fail(f"{shell} missing bootstrap text: {needle}", errors)

        if log_path is not None:
            log_root = PRD_ROOT / "prd_log"
            try:
                log_path.relative_to(log_root)
            except ValueError:
                fail(f"PRD log must be inside docs/prd/prd_log: {log_path}", errors)
            if not re.fullmatch(r'\d{8}-[^\\/:*?"<>|\s]+\.md', log_path.name):
                fail("PRD log filename must use YYYYMMDD-{git-user}.md.", errors)
            expected_writer = safe_writer(git_writer())
            if not log_path.name.endswith(f"-{expected_writer}.md"):
                fail(f"PRD log filename author must match git config user.name: {expected_writer}", errors)

            task_log = read(log_path)
            for heading in ["### 编写人", "### 请求", "### 影响模块", "### 代码变更", "### PRD 更新", "### 验证", "### 风险/后续事项"]:
                if heading not in task_log:
                    fail(f"PRD log missing heading: {heading}", errors)
            if "Pending" in task_log or "待验证" in task_log or "待补充" in task_log:
                fail("PRD log still contains pending validation.", errors)

    if errors:
        print("prd-keeper validation failed:")
        for item in errors:
            print(f"- {item}")
        return 1

    print("prd-keeper validation passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
