"""A checked capacitance format counts as checked only on a Pod 5, read from the hub's device label."""
import logging
import os
import sys
import tempfile
import unittest
import unittest.mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from presence import model
from presence.model import is_pod5, on_this_pod
from presence.sensors import CAPSENSE, CAPSENSE2

LOGGER = logging.getLogger('presence-model-test')


class ModelTestCase(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = folder.name
        logged = unittest.mock.patch.object(model, '_unknown_logged', False)
        logged.start()
        self.addCleanup(logged.stop)

    def label(self, text, name='device-label', mode='w'):
        path = os.path.join(self.folder, name)
        with open(path, mode) as handle:
            handle.write(text)
        return path

    def missing(self, name='missing'):
        return os.path.join(self.folder, name)


class IsPod5Test(ModelTestCase):
    def test_the_hub_revision_decides_as_on_the_server(self):
        for revision, expected in (('G53', True), ('G45', True), ('G43', True), ('H10', True), ('G42', False), ('G00', False), ('F99', False)):
            with self.subTest(revision=revision):
                self.assertIs(is_pod5([self.label(f'AAAA-BB-{revision}-CCCC\n')]), expected)

    def test_the_first_label_found_is_read(self):
        self.assertIs(is_pod5([self.missing(), self.label('AAAA-BB-G53-CCCC')]), True)
        self.assertIs(is_pod5([self.label('AAAA-BB-G10-CCCC', 'first'), self.label('AAAA-BB-G53-CCCC')]), False)

    def test_no_label_is_unknown(self):
        self.assertIsNone(is_pod5([self.missing(), self.missing('other')]))

    def test_a_label_without_a_revision_is_unknown(self):
        for text in ('', 'AAAA', 'AAAA-BB', 'AAAA-BB--CCCC'):
            with self.subTest(text=text):
                self.assertIsNone(is_pod5([self.label(text)]))

    def test_an_unreadable_label_is_unknown(self):
        os.mkdir(self.missing('folder'))
        self.assertIsNone(is_pod5([self.missing('folder')]))
        self.assertIsNone(is_pod5([self.label(b'\xff\xfe-\xff-G53', mode='wb')]))


class OnThisPodTest(ModelTestCase):
    def test_capsense2_on_a_pod_5_is_checked_and_unchanged(self):
        self.assertIs(on_this_pod(CAPSENSE2, LOGGER, [self.label('AAAA-BB-G53-CCCC')]), CAPSENSE2)

    def test_capsense2_on_any_other_pod_is_unchecked(self):
        cap_format = on_this_pod(CAPSENSE2, LOGGER, [self.label('AAAA-BB-G10-CCCC')])
        self.assertFalse(cap_format.validated)
        self.assertEqual((cap_format.name, cap_format.unit), (CAPSENSE2.name, CAPSENSE2.unit))
        self.assertEqual(cap_format, on_this_pod(CAPSENSE2, LOGGER, [self.label('AAAA-BB-G10-CCCC')]))
        self.assertTrue(CAPSENSE2.validated)

    def test_an_unchecked_format_stays_unchecked_without_reading_the_label(self):
        with unittest.mock.patch.object(model, 'is_pod5') as read:
            self.assertIs(on_this_pod(CAPSENSE, LOGGER), CAPSENSE)
        read.assert_not_called()

    def test_an_unknown_model_keeps_capsense2_checked_and_says_so_once(self):
        with self.assertLogs(LOGGER, level='INFO') as logs:
            self.assertIs(on_this_pod(CAPSENSE2, LOGGER, [self.missing()]), CAPSENSE2)
            self.assertIs(on_this_pod(CAPSENSE2, LOGGER, [self.missing()]), CAPSENSE2)
        self.assertEqual(len(logs.output), 1)
        self.assertIn('Could not read the Pod model', logs.output[0])


if __name__ == '__main__':
    unittest.main()
