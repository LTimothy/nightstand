#!/usr/bin/env python3
"""Root-owned copies of the scripts root runs.

The install trees belong to the server user, so root runs their scripts from
copies only root can write: SYSTEM/copies/<sha256>/scripts, named by the
SHA-256 of the paths and contents copied, with SYSTEM/live pointing at the
copy the units run. A tree whose scripts match a copy byte for byte uses that
copy. A tree with none, from a release before copies or edited since, never
runs as root.

  system_scripts.py publish TREE   copy TREE/scripts and print the copy
  system_scripts.py find TREE      print the copy matching TREE, or exit 1
  system_scripts.py point COPY     make COPY the one root runs
  system_scripts.py follow TREE    make TREE's copy the one root runs, if any
  system_scripts.py prune          keep the live copy and the three newest

Standard library only, for the Python versions Pods ship.
"""
import hashlib
import os
import shutil
import stat
import sys
import tempfile

SYSTEM = os.environ.get('NIGHTSTAND_SYSTEM_DIR', '/usr/local/lib/nightstand')
KEEP = 3


def _owned_dir(path):
    os.makedirs(path, exist_ok=True)
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        sys.exit('refusing %s: it must be a folder only this user can write' % path)
    os.chmod(path, 0o755)
    return path


def _sync_dir(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _files(tree):
    scripts = os.path.join(tree, 'scripts')
    if not os.path.isdir(scripts) or os.path.islink(scripts):
        sys.exit('no scripts folder in %s' % tree)
    found = []
    for directory, dirs, names in os.walk(scripts):
        dirs[:] = [name for name in dirs if name != '__pycache__'
                   and not (directory == scripts and name == 'tests')
                   and not os.path.islink(os.path.join(directory, name))]
        for name in names:
            path = os.path.join(directory, name)
            if not name.endswith('.pyc') and stat.S_ISREG(os.lstat(path).st_mode):
                found.append((os.path.relpath(path, tree).replace(os.sep, '/'), path))
    if not found:
        sys.exit('no scripts in %s' % tree)
    return sorted(found)


def _entry(rel, data):
    return rel.encode() + b'\0' + hashlib.sha256(data).hexdigest().encode() + b'\n'


def digest(tree):
    outer = hashlib.sha256()
    for rel, path in _files(tree):
        with open(path, 'rb') as handle:
            outer.update(_entry(rel, handle.read()))
    return outer.hexdigest()


def publish(tree):
    copies = _owned_dir(os.path.join(_owned_dir(SYSTEM), 'copies'))
    work = tempfile.mkdtemp(prefix='.incoming-', dir=copies)
    try:
        outer = hashlib.sha256()
        for rel, path in _files(tree):
            with open(path, 'rb') as handle:
                data = handle.read()
                executable = os.fstat(handle.fileno()).st_mode & 0o111
            target = os.path.join(work, rel)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, 'wb') as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(target, 0o755 if executable else 0o644)
            outer.update(_entry(rel, data))
        for directory, _, _ in os.walk(work):
            os.chmod(directory, 0o755)
            _sync_dir(directory)
        final = os.path.join(copies, outer.hexdigest())
        if os.path.isdir(final):
            shutil.rmtree(work)
        else:
            os.rename(work, final)
            _sync_dir(copies)
        return final
    except BaseException:
        shutil.rmtree(work, ignore_errors=True)
        raise


def find(tree):
    try:
        copy = os.path.join(SYSTEM, 'copies', digest(tree))
    except SystemExit:
        return None
    return copy if os.path.isdir(copy) else None


def point(copy):
    copies = os.path.realpath(os.path.join(SYSTEM, 'copies'))
    real = os.path.realpath(copy)
    if os.path.dirname(real) != copies or not os.path.isdir(os.path.join(real, 'scripts')):
        sys.exit('not a published copy: %s' % copy)
    _owned_dir(SYSTEM)
    link = os.path.join(SYSTEM, 'live')
    temporary = '%s.%d' % (link, os.getpid())
    if os.path.lexists(temporary):
        os.unlink(temporary)
    os.symlink(os.path.join('copies', os.path.basename(real)), temporary)
    os.replace(temporary, link)
    _sync_dir(SYSTEM)


def follow(tree):
    copy = find(tree)
    if copy is None:
        print('No root-owned copy matches the scripts in %s; root keeps running the current ones' % tree,
              file=sys.stderr)
        return
    point(copy)


def prune():
    copies = os.path.join(SYSTEM, 'copies')
    if not os.path.isdir(copies):
        return
    live = os.path.basename(os.path.realpath(os.path.join(SYSTEM, 'live')))
    published = sorted((name for name in os.listdir(copies) if not name.startswith('.')),
                       key=lambda name: os.lstat(os.path.join(copies, name)).st_mtime, reverse=True)
    for name in published[KEEP:]:
        if name != live:
            shutil.rmtree(os.path.join(copies, name))


def main(argv):
    command, args = (argv[0], argv[1:]) if argv else ('', [])
    if command == 'publish' and len(args) == 1:
        print(publish(args[0]))
    elif command == 'find' and len(args) == 1:
        copy = find(args[0])
        if copy is None:
            return 1
        print(copy)
    elif command == 'point' and len(args) == 1:
        point(args[0])
    elif command == 'follow' and len(args) == 1:
        follow(args[0])
    elif command == 'prune' and not args:
        prune()
    else:
        sys.exit(__doc__)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
