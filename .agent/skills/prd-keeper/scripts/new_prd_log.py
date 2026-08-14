#!/usr/bin/env python3
"""Create or append a dated PRD log file for the current git writer."""

from __future__ import annotations

import argparse
import re
import subprocess
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
LOG_DIR = ROOT / "docs" / "prd" / "prd_log"


def git_writer() -> str:
    for key in ["user.name", "user.email"]:
        result = subprocess.run(
            ["git", "config", key],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
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
    parser.add_argument("--title", required=True, help="Log entry title, e.g. 新增订单导出")
    args = parser.parse_args()

    writer = git_writer()
    writer_slug = safe_writer(writer)
    day = datetime.now().strftime("%Y%m%d")
    log_path = LOG_DIR / f"{day}-{writer_slug}.md"

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    entry = f"""## {datetime.now().strftime("%Y-%m-%d")} - {args.title}

### 编写人
- {writer}

### 请求
- 待补充

### 影响模块
- 待补充

### 代码变更
- 待补充

### PRD 更新
- 待补充

### 验证
- 待补充

### 风险/后续事项
- 待补充
"""
    if log_path.exists():
        existing = log_path.read_text(encoding="utf-8").rstrip()
        log_path.write_text(f"{existing}\n\n{entry}", encoding="utf-8")
    else:
        content = f"# {day}-{writer_slug} PRD / 开发变更日志\n\n{entry}"
        log_path.write_text(content, encoding="utf-8")
    print(log_path.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
