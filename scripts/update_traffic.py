#!/usr/bin/env python3
"""Fetch GitHub traffic data and accumulate into traffic/traffic.json."""

import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

REPO = "suyoumo/ClawProBench"
PROJECT_ROOT = Path(__file__).resolve().parents[1]
TRAFFIC_FILE = PROJECT_ROOT / "traffic" / "traffic.json"
README_FILE = PROJECT_ROOT / "README.md"


def get_token() -> str:
    """Get GitHub token from env or git config."""
    token = os.environ.get("GITHUB_TOKEN", "")
    if token:
        return token
    result = subprocess.run(
        ["git", "config", "--global", "github.token"],
        capture_output=True, text=True
    )
    token = result.stdout.strip()
    if not token:
        print("Error: No GitHub token found. Set GITHUB_TOKEN env or run: git config --global github.token <token>")
        sys.exit(1)
    return token


def fetch_traffic(endpoint: str, token: str) -> dict:
    """Fetch traffic data from GitHub API."""
    import urllib.request
    import urllib.error

    url = f"https://api.github.com/repos/{REPO}/traffic/{endpoint}"
    req = urllib.request.Request(url)
    req.add_header("Authorization", f"token {token}")
    req.add_header("Accept", "application/vnd.github.v3+json")

    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print(f"Error fetching {endpoint}: {e.code} {e.reason}")
        return {}


def load_traffic() -> dict:
    """Load existing traffic data."""
    if TRAFFIC_FILE.exists():
        with open(TRAFFIC_FILE) as f:
            return json.load(f)
    return {
        "repo": REPO,
        "since": datetime.now().strftime("%Y-%m-%d"),
        "clones": {"total": 0, "uniques": 0, "daily": []},
        "views": {"total": 0, "uniques": 0, "daily": []},
    }


def accumulate(existing: dict, new_data: dict, key: str) -> dict:
    """Accumulate new daily data into existing totals."""
    result = {"total": existing["total"], "uniques": existing["uniques"], "daily": list(existing["daily"])}
    existing_dates = {d["date"] for d in result["daily"]}

    for entry in new_data.get(key, []):
        date = entry["timestamp"][:10]
        if date not in existing_dates:
            result["daily"].append({"date": date, "count": entry["count"], "uniques": entry["uniques"]})
            result["total"] += entry["count"]
            result["uniques"] += entry["uniques"]
            existing_dates.add(date)

    result["daily"].sort(key=lambda x: x["date"])
    return result


def format_count(n: int) -> str:
    """Format number with k suffix."""
    if n >= 1000:
        return f"{n / 1000:.1f}k"
    return str(n)


def update_readme_badges(traffic: dict) -> None:
    """Update Clones and Views badges in README.md."""
    if not README_FILE.exists():
        return

    content = README_FILE.read_text()
    clones_badge = f"[![Clones](https://img.shields.io/badge/clones-{format_count(traffic['clones']['total'])}-blue)](https://github.com/{REPO})"
    views_badge = f"[![Views](https://img.shields.io/badge/views-{format_count(traffic['views']['total'])}-green)](https://github.com/{REPO})"

    # Replace old badges with new ones
    import re
    content = re.sub(r'\[!\[Clones\]\(https://img\.shields\.io/badge/clones-[^)]+\)\]\([^)]+\)', clones_badge, content)
    content = re.sub(r'\[!\[Views\]\(https://img\.shields\.io/badge/views-[^)]+\)\]\([^)]+\)', views_badge, content)

    README_FILE.write_text(content)


def main():
    token = get_token()

    print(f"Fetching traffic data for {REPO}...")
    views_data = fetch_traffic("views", token)
    clones_data = fetch_traffic("clones", token)

    if not views_data or not clones_data:
        print("Error: Failed to fetch traffic data")
        sys.exit(1)

    traffic = load_traffic()
    traffic["clones"] = accumulate(traffic["clones"], clones_data, "clones")
    traffic["views"] = accumulate(traffic["views"], views_data, "views")

    TRAFFIC_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(TRAFFIC_FILE, "w") as f:
        json.dump(traffic, f, indent=2)

    # Update README badges
    update_readme_badges(traffic)

    print(f"Updated traffic data:")
    print(f"  Clones: {format_count(traffic['clones']['total'])} ({traffic['clones']['uniques']} unique)")
    print(f"  Views:  {format_count(traffic['views']['total'])} ({traffic['views']['uniques']} unique)")
    print(f"  Data saved to {TRAFFIC_FILE}")
    print(f"  README badges updated")


if __name__ == "__main__":
    main()
