#!/usr/bin/env python3
"""Root-owned copies of the scripts root runs.

The install trees belong to the server user, so root runs their scripts from
copies only root can write: SYSTEM/copies/<sha256>/scripts, named by the
SHA-256 of the paths and contents copied, with SYSTEM/live pointing at the
copy the units run. A tree whose scripts match a copy byte for byte uses that
copy. A tree with none, from a release before copies or edited since, never
runs as root.

  system_scripts.py publish TREE   copy TREE/scripts and print the copy;
                                   TREE must be this user's alone
  system_scripts.py publish --any-owner TREE
                                   the same for the stage an updater from
                                   before copies hands off from
  system_scripts.py find TREE      print the copy matching TREE, or exit 1
  system_scripts.py point COPY     make COPY the one root runs
  system_scripts.py follow TREE    make TREE's copy the one root runs, if any
  system_scripts.py prune          keep the live copy and the three newest,
                                   and remove download folders over a day old

Standard library only, for the Python versions Pods ship.
"""
import errno
import hashlib
import os
import shutil
import stat
import sys
import tempfile
import time

SYSTEM = os.environ.get('NIGHTSTAND_SYSTEM_DIR', '/usr/local/lib/nightstand')
KEEP = 3
# Older than any running operation's download folder.
STALE_DOWNLOAD = 24 * 3600


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


def _refuse(tree, why):
    sys.exit('refusing %s: %s' % (tree, why))


def _scripts(tree, owner=None):
    """TREE/scripts as sorted (path, data, executable), read through descriptors
    that never follow a symlink. With OWNER, refuse anything another user owns
    or can change."""
    def check(info, path):
        if owner is not None and (info.st_uid != owner or info.st_mode & 0o002
                                  or (info.st_mode & 0o020 and info.st_gid != 0)):
            _refuse(tree, '%s is not owned and writable by this user alone' % path)

    try:
        top = os.open(tree, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError:
        sys.exit('no scripts folder in %s' % tree)
    found = []
    try:
        check(os.fstat(top), tree)
        for directory, dirs, names, directory_fd in os.fwalk('scripts', dir_fd=top):
            check(os.fstat(directory_fd), directory)
            dirs[:] = [name for name in dirs if name != '__pycache__'
                       and not (directory == 'scripts' and name == 'tests')]
            for name in names:
                if name.endswith('.pyc'):
                    continue
                # Sockets, FIFOs and devices are no scripts; never open them.
                if not stat.S_ISREG(os.stat(name, dir_fd=directory_fd, follow_symlinks=False).st_mode):
                    continue
                try:
                    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
                except OSError as error:
                    if error.errno == errno.ELOOP:
                        continue
                    _refuse(tree, '%s/%s changed while it was read' % (directory, name))
                with os.fdopen(descriptor, 'rb') as handle:
                    info = os.fstat(descriptor)
                    if not stat.S_ISREG(info.st_mode):
                        _refuse(tree, '%s/%s changed while it was read' % (directory, name))
                    if info.st_nlink != 1:
                        _refuse(tree, '%s/%s is a hard link' % (directory, name))
                    check(info, directory + '/' + name)
                    found.append((directory + '/' + name, handle.read(), info.st_mode & 0o111))
    except OSError as error:
        _refuse(tree, str(error))
    finally:
        os.close(top)
    if not found:
        sys.exit('no scripts in %s' % tree)
    return sorted(found)


def _entry(rel, data):
    return rel.encode() + b'\0' + hashlib.sha256(data).hexdigest().encode() + b'\n'


def digest(tree):
    outer = hashlib.sha256()
    for rel, data, _ in _scripts(tree):
        outer.update(_entry(rel, data))
    return outer.hexdigest()


def publish(tree, any_owner=False):
    # Only the old updater's handoff publishes a stage the server user owns.
    scripts = _scripts(tree, None if any_owner else os.geteuid())
    copies = _owned_dir(os.path.join(_owned_dir(SYSTEM), 'copies'))
    work = tempfile.mkdtemp(prefix='.incoming-', dir=copies)
    try:
        outer = hashlib.sha256()
        for rel, data, executable in scripts:
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
            os.utime(final)
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
    except (SystemExit, OSError):
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
    # Download folders an interrupted install, update or deploy left behind.
    stale = time.time() - STALE_DOWNLOAD
    for name in os.listdir(SYSTEM) if os.path.isdir(SYSTEM) else []:
        path = os.path.join(SYSTEM, name)
        try:
            info = os.lstat(path)
        except FileNotFoundError:
            continue
        if name.startswith('.download.') and stat.S_ISDIR(info.st_mode) and info.st_mtime < stale:
            shutil.rmtree(path, ignore_errors=True)
    copies = os.path.join(SYSTEM, 'copies')
    if not os.path.isdir(copies):
        return
    live = os.path.basename(os.path.realpath(os.path.join(SYSTEM, 'live')))
    ages = []
    for name in os.listdir(copies):
        try:
            if not name.startswith('.'):
                ages.append((os.lstat(os.path.join(copies, name)).st_mtime, name))
        except FileNotFoundError:
            continue
    for _, name in sorted(ages, reverse=True)[KEEP:]:
        if name != live:
            try:
                shutil.rmtree(os.path.join(copies, name))
            except FileNotFoundError:
                continue


def main(argv):
    command, args = (argv[0], argv[1:]) if argv else ('', [])
    if command == 'publish' and len(args) == 1:
        print(publish(args[0]))
    elif command == 'publish' and len(args) == 2 and args[0] == '--any-owner':
        print(publish(args[1], any_owner=True))
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
