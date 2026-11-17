#!/usr/bin/env python3
"""Prints a release's GitHub notes: its CHANGELOG section, then what was
checked before release. Run from the repository root. Fails when a commit
in the release from a GitHub account other than yours has no credit by
handle in the section."""
import re
import subprocess
import sys


def section(changelog, version):
    pattern = re.compile(r"^## \[" + re.escape(version) + r"\][^\n]*\n(.*?)(?=^## \[|\Z)", re.S | re.M)
    match = pattern.search(changelog)
    if not match:
        sys.exit("no CHANGELOG section for %s" % version)
    return match.group(1).strip()


def git(*args):
    result = subprocess.run(["git", *args], capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else None


def outside_commits(version):
    """(hash, author email) of commits by others since the previous release
    tag, or [] outside a git checkout."""
    if git("rev-parse", "--git-dir") is None:
        return []
    tip = "v" + version if git("rev-parse", "-q", "--verify", "refs/tags/v" + version) else "HEAD"
    previous = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", tip + "^")
    revs = previous + ".." + tip if previous else tip
    me = git("config", "user.email")
    lines = (git("log", "--format=%h %ae", revs) or "").splitlines()
    return [line.split(" ", 1) for line in lines if line.split(" ", 1)[1] != me]


def github_handle(email):
    match = re.match(r"(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$", email)
    return match.group(1) if match else None


def missing_credit(body, commits):
    """Handles with no credit in body, and hashes whose author has no handle
    to look for."""
    missing, unknown = set(), []
    for sha, email in commits:
        name = github_handle(email)
        if name is None:
            unknown.append(sha)
        elif not re.search(r"(@|github\.com/)" + re.escape(name) + r"(?![\w-])", body, re.I):
            missing.add("@" + name)
    return sorted(missing), unknown


def main(argv):
    version, checked_path = argv[1], argv[2]
    with open("CHANGELOG.md") as handle:
        body = section(handle.read(), version)
    missing, unknown = missing_credit(body, outside_commits(version))
    if unknown:
        sys.stderr.write("check the credit for these commits by hand: %s\n" % " ".join(unknown))
    if missing:
        sys.exit("CHANGELOG %s does not credit: %s" % (version, ", ".join(missing)))
    with open(checked_path) as handle:
        checked = handle.read().strip()
    sys.stdout.write("%s\n\n### Checked before release\n\n%s\n" % (body, checked))


if __name__ == "__main__":
    main(sys.argv)
