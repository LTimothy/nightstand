"""Pin the tree digest format, which the Mac and the Pod must compute alike."""
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts' / 'tree_digest.py'


def expected(entries):
    outer = hashlib.sha256()
    for rel, data in sorted(entries.items()):
        outer.update(rel.encode() + b'\0' + hashlib.sha256(data).hexdigest().encode() + b'\n')
    return outer.hexdigest()


class TreeDigestTests(unittest.TestCase):
    def digest(self, root):
        return subprocess.run([sys.executable, str(SCRIPT), str(root)], check=True,
                              capture_output=True, text=True).stdout.strip()

    def test_matches_the_documented_format(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'server' / 'dist').mkdir(parents=True)
            (root / 'a.txt').write_bytes(b'one')
            (root / 'server' / 'dist' / 'b.js').write_bytes(b'two\n')
            (root / 'empty').write_bytes(b'')
            (root / 'releases.json').write_bytes(b'{}')
            os.symlink('a.txt', str(root / 'link'))
            os.symlink('server', str(root / 'dirlink'))
            self.assertEqual(self.digest(root), expected({
                'a.txt': b'one',
                'server/dist/b.js': b'two\n',
                'empty': b'',
                'link': b'link:a.txt',
                'dirlink': b'link:server',
            }))

    def test_reads_large_files_in_pieces_with_the_same_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data = os.urandom(3 * 1024 * 1024 + 7)
            (root / 'big.map').write_bytes(data)
            self.assertEqual(self.digest(root), expected({'big.map': data}))

    def test_an_empty_tree_still_has_a_digest(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(self.digest(tmp), hashlib.sha256(b'').hexdigest())

    def test_a_tar_stream_gives_the_digest_of_the_tree_it_unpacks_to(self):
        # The Mac reads git archive's tar directly: unpacking it there would
        # turn a committed "._name" file into metadata and drop it, while the
        # Pod's unzip keeps it as a file.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'tree'
            (root / 'server' / 'public').mkdir(parents=True)
            (root / 'a.txt').write_bytes(b'one')
            (root / 'server' / 'public' / '._icon.svg').write_bytes(b'\0\5\26\7apple')
            (root / 'releases.json').write_bytes(b'{}')
            os.symlink('a.txt', str(root / 'link'))
            archive = Path(tmp) / 'tree.tar'
            with tarfile.open(str(archive), 'w', format=tarfile.PAX_FORMAT,
                              pax_headers={'comment': 'abc123'}) as tar:
                for name in ['server', 'server/public', 'server/public/._icon.svg', 'a.txt', 'link', 'releases.json']:
                    tar.add(str(root / name), arcname=name, recursive=False)
            with open(str(archive), 'rb') as handle:
                from_tar = subprocess.run([sys.executable, str(SCRIPT), '--tar', '-'], stdin=handle,
                                          check=True, capture_output=True, text=True).stdout.strip()
            self.assertEqual(from_tar, self.digest(root))
            self.assertEqual(from_tar, expected({
                'a.txt': b'one',
                'server/public/._icon.svg': b'\0\5\26\7apple',
                'link': b'link:a.txt',
            }))

    def test_a_fifo_is_refused_without_blocking(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'scripts').mkdir()
            os.mkfifo(str(root / 'scripts' / 'pipe'))
            result = subprocess.run([sys.executable, str(SCRIPT), str(root)],
                                    capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('not a regular file, directory or link: scripts/pipe', result.stderr)

    def test_a_missing_directory_is_an_error_not_an_empty_digest(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run([sys.executable, str(SCRIPT), str(Path(tmp) / 'absent')],
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, '')


if __name__ == '__main__':
    unittest.main()
