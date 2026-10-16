"""Root-owned copies of the scripts root runs."""
import errno
import importlib.util
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / 'scripts' / 'system_scripts.py'


class SystemScriptsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.system = self.base / 'system'

    def tearDown(self):
        self.tmp.cleanup()

    def tool(self, *args):
        return subprocess.run([sys.executable, '-B', str(TOOL)] + [str(arg) for arg in args],
                              capture_output=True, text=True,
                              env=dict(os.environ, NIGHTSTAND_SYSTEM_DIR=str(self.system)))

    def tree(self, name, scripts):
        tree = self.base / name
        for rel, (content, mode) in scripts.items():
            path = tree / 'scripts' / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
            path.chmod(mode)
        return tree

    def publish(self, tree):
        result = self.tool('publish', tree)
        self.assertEqual(result.returncode, 0, result.stderr)
        return Path(result.stdout.strip())

    def live(self):
        link = self.system / 'live'
        return os.readlink(str(link)) if link.is_symlink() else None

    def test_publish_copies_the_scripts_root_runs_and_nothing_else(self):
        tree = self.tree('a', {
            'update.sh': ('echo a\n', 0o700), 'write_result.py': ('pass\n', 0o600),
            'systemd/x.service': ('[Unit]\n', 0o644), 'migrate/y.sh': ('echo y\n', 0o755),
            'tests/test_x.py': ('', 0o644), '__pycache__/x.cpython-39.pyc': ('', 0o644)})
        copy = self.publish(tree)
        self.assertEqual(copy.parent, self.system / 'copies')
        self.assertRegex(copy.name, r'^[0-9a-f]{64}$')
        found = sorted(str(path.relative_to(copy)) for path in copy.rglob('*') if path.is_file())
        self.assertEqual(found, ['scripts/migrate/y.sh', 'scripts/systemd/x.service',
                                 'scripts/update.sh', 'scripts/write_result.py'])
        self.assertEqual(stat.S_IMODE((copy / 'scripts/update.sh').stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE((copy / 'scripts/write_result.py').stat().st_mode), 0o644)
        for folder in (self.system, self.system / 'copies', copy, copy / 'scripts', copy / 'scripts/systemd'):
            self.assertEqual(stat.S_IMODE(folder.stat().st_mode), 0o755, folder)
        self.assertEqual(self.publish(tree), copy)
        self.assertEqual([path.name for path in (self.system / 'copies').iterdir()], [copy.name])

    def test_find_matches_by_content_not_by_permissions(self):
        tree = self.tree('a', {'update.sh': ('echo a\n', 0o755)})
        copy = self.publish(tree)
        (tree / 'scripts/update.sh').chmod(0o644)
        self.assertEqual(self.tool('find', tree).stdout.strip(), str(copy))
        (tree / 'scripts/update.sh').write_text('echo edited by the server user\n')
        self.assertEqual(self.tool('find', tree).returncode, 1)

    def test_follow_moves_to_a_matching_copy_and_otherwise_keeps_the_current_one(self):
        current = self.publish(self.tree('current', {'update.sh': ('echo 3.7.1\n', 0o755)}))
        previous_tree = self.tree('previous', {'update.sh': ('echo 3.7.0\n', 0o755)})
        previous = self.publish(previous_tree)
        older = self.tree('older', {'update.sh': ('echo 3.6.1, never copied\n', 0o755)})
        self.assertEqual(self.tool('point', current).returncode, 0)
        self.assertEqual(self.live(), 'copies/' + current.name)
        self.assertEqual(self.tool('follow', previous_tree).returncode, 0)
        self.assertEqual(self.live(), 'copies/' + previous.name)
        result = self.tool('follow', older)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('keeps running the current ones', result.stderr)
        self.assertEqual(self.live(), 'copies/' + previous.name)

    def test_point_takes_only_a_published_copy(self):
        tree = self.tree('a', {'update.sh': ('echo a\n', 0o755)})
        self.assertNotEqual(self.tool('point', tree).returncode, 0)
        self.assertIsNone(self.live())

    def test_a_failed_publish_leaves_no_copy(self):
        if os.geteuid() == 0:
            self.skipTest('root reads files without read permission')
        tree = self.tree('a', {'update.sh': ('echo a\n', 0o755), 'unreadable.sh': ('echo b\n', 0o000)})
        self.assertNotEqual(self.tool('publish', tree).returncode, 0)
        copies = self.system / 'copies'
        self.assertEqual(list(copies.iterdir()) if copies.exists() else [], [])

    def test_refuses_a_folder_other_users_can_write(self):
        self.system.mkdir()
        self.system.chmod(0o777)
        result = self.tool('publish', self.tree('a', {'update.sh': ('echo a\n', 0o755)}))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('refusing', result.stderr)

    def test_prune_keeps_the_live_copy_and_the_three_newest(self):
        copies = []
        for index in range(6):
            copies.append(self.publish(self.tree('t%d' % index, {'update.sh': ('echo %d\n' % index, 0o755)})))
            os.utime(str(copies[-1]), (1000 + index, 1000 + index))
        self.tool('point', copies[0])
        self.assertEqual(self.tool('prune').returncode, 0)
        self.assertEqual(sorted(path.name for path in (self.system / 'copies').iterdir()),
                         sorted(copy.name for copy in [copies[0]] + copies[3:]))


    def test_re_publishing_a_copy_keeps_it_from_being_pruned_first(self):
        trees = [self.tree('t%d' % index, {'update.sh': ('echo %d\n' % index, 0o755)}) for index in range(5)]
        copies = []
        for index, tree in enumerate(trees):
            copies.append(self.publish(tree))
            os.utime(str(copies[-1]), (1000 + index, 1000 + index))
        self.tool('point', copies[4])
        self.assertEqual(self.publish(trees[0]), copies[0])
        self.assertEqual(self.tool('prune').returncode, 0)
        self.assertIn(copies[0].name, [path.name for path in (self.system / 'copies').iterdir()])

    def test_never_copies_what_a_symlink_points_at(self):
        secret = self.base / 'secret'
        secret.write_text('root only\n')
        tree = self.tree('a', {'update.sh': ('echo a\n', 0o755)})
        (tree / 'scripts/link.sh').symlink_to(secret)
        (tree / 'scripts/sub').symlink_to(self.base)
        copy = self.publish(tree)
        found = sorted(str(path.relative_to(copy)) for path in copy.rglob('*') if path.is_file())
        self.assertEqual(found, ['scripts/update.sh'])

    def test_a_file_swapped_for_a_symlink_mid_publish_is_never_followed(self):
        secret = self.base / 'secret'
        secret.write_text('root only\n')
        tree = self.tree('a', {'update.sh': ('echo a\n', 0o755), 'swapped.sh': ('echo b\n', 0o755)})
        target = str(tree / 'scripts/swapped.sh')
        real_lstat = os.lstat
        swapped = []

        def racing_lstat(path, *args, **kwargs):
            result = real_lstat(path, *args, **kwargs)
            if str(path) == target and not swapped:
                swapped.append(True)
                os.unlink(target)
                os.symlink(str(secret), target)
            return result
        spec = importlib.util.spec_from_file_location('system_scripts_under_test', str(TOOL))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.SYSTEM = str(self.system)
        with patch.object(module.os, 'lstat', racing_lstat):
            try:
                copy = Path(module.publish(str(tree)))
            except SystemExit:
                return
        for path in copy.rglob('*'):
            if path.is_file():
                self.assertNotIn('root only', path.read_text(), path)

    def test_refuses_a_hard_link_to_a_file_outside_the_tree(self):
        secret = self.base / 'secret'
        secret.write_text('root only\n')
        tree = self.tree('a', {'update.sh': ('echo a\n', 0o755)})
        os.link(str(secret), str(tree / 'scripts/linked.sh'))
        result = self.tool('publish', tree)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.system / 'copies').is_dir() and any(
            not path.name.startswith('.') for path in (self.system / 'copies').iterdir()))

    def test_refuses_a_tree_other_users_can_change_unless_told_it_is_the_old_updaters_stage(self):
        tree = self.tree('a', {'update.sh': ('echo a\n', 0o755), 'sub/x.sh': ('echo x\n', 0o755)})
        (tree / 'scripts/sub').chmod(0o777)
        result = self.tool('publish', tree)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('refusing', result.stderr)
        self.assertFalse((self.system / 'copies').is_dir() and any(
            not path.name.startswith('.') for path in (self.system / 'copies').iterdir()))
        handoff = self.tool('publish', '--any-owner', tree)
        self.assertEqual(handoff.returncode, 0, handoff.stderr)
        self.assertTrue((Path(handoff.stdout.strip()) / 'scripts/sub/x.sh').is_file())

    def test_refuses_a_tree_another_user_owns(self):
        tree = self.tree('a', {'update.sh': ('echo a\n', 0o755)})
        spec = importlib.util.spec_from_file_location('system_scripts_owner', str(TOOL))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.SYSTEM = str(self.system)
        with patch.object(module.os, 'geteuid', lambda: os.getuid() + 1):
            with self.assertRaises(SystemExit) as raised:
                module.publish(str(tree))
        self.assertIn('refusing', str(raised.exception))
        self.assertFalse(self.system.exists())


    def test_skips_sockets_and_fifos_and_refuses_a_file_that_turns_into_one(self):
        tree = self.tree('a', {'update.sh': ('echo a\n', 0o755)})
        plain = self.publish(self.tree('b', {'update.sh': ('echo a\n', 0o755)}))
        os.mkfifo(str(tree / 'scripts/pipe'))
        cwd = os.getcwd()
        listener = socket.socket(socket.AF_UNIX)
        self.addCleanup(listener.close)
        try:
            os.chdir(str(tree / 'scripts'))
            listener.bind('server.sock')
        finally:
            os.chdir(cwd)
        self.assertEqual(self.publish(tree), plain)
        found = self.tool('find', tree)
        self.assertEqual((found.returncode, found.stdout.strip()), (0, str(plain)))
        module = self.module()
        real_open = os.open

        def swapped(path, *args, **kwargs):
            if path == 'update.sh':
                raise OSError(errno.ENXIO, 'No such device or address')
            return real_open(path, *args, **kwargs)
        with patch.object(module.os, 'open', swapped):
            with self.assertRaises(SystemExit) as raised:
                module.digest(str(tree))
            self.assertIsNone(module.find(str(tree)))
        self.assertIn('refusing', str(raised.exception))

    def test_refuses_a_regular_name_that_is_a_fifo_once_opened(self):
        tree = self.tree('a', {'update.sh': ('echo a\n', 0o755)})
        module = self.module()
        real_fstat = os.fstat

        def fifo(fd):
            info = real_fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                return info
            values = list(info)
            values[stat.ST_MODE] = stat.S_IFIFO | 0o600
            return os.stat_result(values)
        with patch.object(module.os, 'fstat', fifo):
            with self.assertRaises(SystemExit) as raised:
                module.digest(str(tree))
        self.assertIn('refusing', str(raised.exception))

    def test_prune_skips_what_a_deploy_removes_mid_sweep(self):
        for name in 'abcde':
            self.publish(self.tree(name, {'update.sh': ('echo %s\n' % name, 0o755)}))
        module = self.module()
        copies = self.system / 'copies'
        gone = sorted(path.name for path in copies.iterdir())[0]
        real_lstat, real_rmtree = os.lstat, module.shutil.rmtree

        def lstat(path, *args, **kwargs):
            if os.path.basename(str(path)) == gone:
                raise FileNotFoundError(errno.ENOENT, 'gone')
            return real_lstat(path, *args, **kwargs)

        def rmtree(path, *args, **kwargs):
            real_rmtree(path, *args, **kwargs)
            raise FileNotFoundError(errno.ENOENT, 'gone')
        with patch.object(module.os, 'lstat', lstat):
            module.prune()
        with patch.object(module.shutil, 'rmtree', rmtree):
            module.prune()
        self.assertLessEqual(len(list(copies.iterdir())), module.KEEP + 1)

    def test_refuses_files_a_group_other_than_root_can_change(self):
        tree = self.tree('a', {'update.sh': ('echo a\n', 0o755)})
        (tree / 'scripts/update.sh').chmod(0o775)
        module = self.module()
        info = os.stat(str(tree))
        self.assertNotEqual(info.st_gid, 0)
        with self.assertRaises(SystemExit) as raised:
            module.publish(str(tree))
        self.assertIn('refusing', str(raised.exception))
        # A release unpacked by root keeps git's 0664 modes with group root.
        real_fstat = os.fstat
        (tree / 'scripts/data.txt').write_text('x\n')
        (tree / 'scripts/data.txt').chmod(0o664)
        with patch.object(module.os, 'fstat', lambda fd: _with_gid(real_fstat(fd), 0)):
            copy = Path(module.publish(str(tree)))
        self.assertEqual(stat.S_IMODE((copy / 'scripts/update.sh').stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE((copy / 'scripts/data.txt').stat().st_mode), 0o644)

    def test_prune_removes_download_folders_over_a_day_old(self):
        self.publish(self.tree('a', {'update.sh': ('echo a\n', 0o755)}))
        old, new = self.system / '.download.old', self.system / '.download.new'
        for folder in (old, new):
            (folder / 'tree').mkdir(parents=True)
        os.utime(str(old), (time.time() - 2 * 86400,) * 2)
        self.assertEqual(self.tool('prune').returncode, 0)
        self.assertFalse(old.exists())
        self.assertTrue((new / 'tree').is_dir())

    def module(self):
        spec = importlib.util.spec_from_file_location('system_scripts_module', str(TOOL))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.SYSTEM = str(self.system)
        return module


def _with_gid(info, gid):
    values = list(info)
    values[stat.ST_GID] = gid
    return os.stat_result(values)

if __name__ == '__main__':
    unittest.main()
