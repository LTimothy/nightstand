"""Root-owned copies of the scripts root runs."""
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

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
            'update.sh': ('echo a\n', 0o775), 'write_result.py': ('pass\n', 0o664),
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
        self.assertEqual(list((self.system / 'copies').iterdir()), [])

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


if __name__ == '__main__':
    unittest.main()
