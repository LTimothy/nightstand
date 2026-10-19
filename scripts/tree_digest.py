#!/usr/bin/env python3
"""Prints a SHA-256 over a release tree, for checking a downloaded release.

Covers every file and symlink by its path relative to the tree and its
content, ignoring timestamps and permissions, which archives do not keep
reliably. The digest is the SHA-256 of the sorted lines
"relative/path NUL sha256(content) LF", where a symlink's content is "link:"
followed by its target. releases.json at the top is left out because it
carries the digest.

  tree_digest.py DIR         digest of an unpacked tree (the Pod)
  tree_digest.py --tar FILE  digest of the tree a tar archive holds, read
                             without unpacking it ("-" reads stdin). The
                             release ritual reads git archive this way,
                             because unpacking on a Mac turns a committed
                             "._name" file into file metadata.

Runs on the Mac at release time and on the Pod before an install, so it
sticks to the standard library and to Python versions older Pods ship.
"""
import hashlib
import os
import stat
import sys
import tarfile

EXCLUDE = {b"releases.json"}
CHUNK = 1024 * 1024


def _stream_digest(handle):
    inner = hashlib.sha256()
    while True:
        block = handle.read(CHUNK)
        if not block:
            break
        inner.update(block)
    return inner.hexdigest()


def _link_digest(target):
    return hashlib.sha256(b"link:" + target).hexdigest()


def _dir_entries(root):
    root = os.fsencode(root)
    if not os.path.isdir(root):
        raise SystemExit("not a directory: %s" % os.fsdecode(root))

    def fail(error):
        raise error

    for dirpath, dirnames, filenames in os.walk(root, onerror=fail):
        # A symlink to a directory is listed here and not followed.
        names = [name for name in dirnames if os.path.islink(os.path.join(dirpath, name))]
        names.extend(filenames)
        for name in names:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep.encode(), b"/")
            mode = os.lstat(full).st_mode
            if stat.S_ISLNK(mode):
                yield rel, _link_digest(os.readlink(full))
                continue
            # Root digests trees another user writes: never block on a FIFO
            # or follow a link swapped in after the lstat.
            if stat.S_ISREG(mode):
                descriptor = os.open(full, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(descriptor, "rb") as handle:
                    if stat.S_ISREG(os.fstat(descriptor).st_mode):
                        yield rel, _stream_digest(handle)
                        continue
            raise ValueError("not a regular file, directory or link: %s" % os.fsdecode(rel))


def _tar_entries(path):
    handle = sys.stdin.buffer if path == "-" else open(path, "rb")
    try:
        with tarfile.open(fileobj=handle, mode="r|") as archive:
            for member in archive:
                rel = member.name.encode("utf-8", "surrogateescape")
                while rel.startswith(b"./"):
                    rel = rel[2:]
                rel = rel.rstrip(b"/")
                if member.isdir() or not rel:
                    continue
                if member.issym():
                    yield rel, _link_digest(member.linkname.encode("utf-8", "surrogateescape"))
                elif member.isfile():
                    yield rel, _stream_digest(archive.extractfile(member))
                else:
                    raise SystemExit("unexpected archive entry: %s" % member.name)
    finally:
        if handle is not sys.stdin.buffer:
            handle.close()


def tree_digest(entries):
    """Returns the hex digest of (relative path bytes, content digest) pairs.
    Paths are bytes so the result does not depend on the locale."""
    lines = sorted((rel, digest) for rel, digest in entries if rel not in EXCLUDE)
    outer = hashlib.sha256()
    for rel, digest in lines:
        outer.update(rel + b"\0" + digest.encode("ascii") + b"\n")
    return outer.hexdigest()


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--tar":
        print(tree_digest(_tar_entries(sys.argv[2])))
    elif len(sys.argv) == 2 and not sys.argv[1].startswith("--"):
        try:
            print(tree_digest(_dir_entries(sys.argv[1])))
        except ValueError as error:
            raise SystemExit(str(error))
    else:
        raise SystemExit("usage: tree_digest.py DIR | tree_digest.py --tar FILE")
