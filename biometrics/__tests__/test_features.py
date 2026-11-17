"""The biometrics side of the new sleep tracking switch reads settingsDB.json
the way the server writes it, and treats anything unexpected as off."""
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from get_logger import data_folder
from features import biometrics_v2_enabled, unchecked_cap_presence_enabled


class BiometricsV2EnabledTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.path = os.path.join(self.folder.name, 'settingsDB.json')

    def _write(self, text: str):
        with open(self.path, 'w') as handle:
            handle.write(text)

    def test_true_only_when_the_switch_is_on(self):
        self._write(json.dumps({'features': {'biometricsV2': True, 'sleepScore': True}}))
        self.assertTrue(biometrics_v2_enabled(self.path))

    def test_off_when_the_switch_is_off(self):
        self._write(json.dumps({'features': {'biometricsV2': False}}))
        self.assertFalse(biometrics_v2_enabled(self.path))

    def test_off_for_settings_from_a_version_without_the_switch(self):
        self._write(json.dumps({'features': {'sleepScore': True}}))
        self.assertFalse(biometrics_v2_enabled(self.path))
        self._write(json.dumps({'timeZone': 'UTC'}))
        self.assertFalse(biometrics_v2_enabled(self.path))

    def test_off_for_values_that_are_not_exactly_true(self):
        for value in ('true', 1, None, {}):
            with self.subTest(value=value):
                self._write(json.dumps({'features': {'biometricsV2': value}}))
                self.assertFalse(biometrics_v2_enabled(self.path))

    def test_off_when_the_file_is_missing_or_broken(self):
        self.assertFalse(biometrics_v2_enabled(self.path))
        self._write('{"features": {"biometricsV2": tr')
        self.assertFalse(biometrics_v2_enabled(self.path))
        self._write('[]')
        self.assertFalse(biometrics_v2_enabled(self.path))

    def test_off_when_features_is_not_an_object(self):
        for features in (None, [], 'on', True):
            with self.subTest(features=features):
                self._write(json.dumps({'features': features}))
                self.assertFalse(biometrics_v2_enabled(self.path))

    def test_default_path_sits_under_the_data_folder(self):
        import features
        self.assertEqual(features._settings_path(), f'{data_folder()}lowdb/settingsDB.json')

    def test_default_path_follows_data_folder(self):
        import features
        os.makedirs(os.path.join(self.folder.name, 'lowdb'))
        settings = os.path.join(self.folder.name, 'lowdb', 'settingsDB.json')
        with open(settings, 'w') as handle:
            json.dump({'features': {'biometricsV2': True}}, handle)
        with mock.patch.dict(os.environ, {'DATA_FOLDER': self.folder.name}):
            self.assertEqual(features._settings_path(), settings)
            self.assertTrue(biometrics_v2_enabled())
        with mock.patch.dict(os.environ, {'DATA_FOLDER': os.path.join(self.folder.name, 'none')}):
            self.assertFalse(biometrics_v2_enabled())


class UncheckedCapPresenceEnabledTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.path = os.path.join(self.folder.name, 'settingsDB.json')

    def _write(self, text: str):
        with open(self.path, 'w') as handle:
            handle.write(text)

    def test_true_only_when_its_own_switch_is_exactly_true(self):
        self._write(json.dumps({'features': {'biometricsV2': True, 'uncheckedCapPresence': True}}))
        self.assertTrue(unchecked_cap_presence_enabled(self.path))
        for value in (False, 'true', 1, None):
            with self.subTest(value=value):
                self._write(json.dumps({'features': {'biometricsV2': True, 'uncheckedCapPresence': value}}))
                self.assertFalse(unchecked_cap_presence_enabled(self.path))

    def test_new_sleep_tracking_alone_does_not_turn_it_on(self):
        self._write(json.dumps({'features': {'biometricsV2': True}}))
        self.assertFalse(unchecked_cap_presence_enabled(self.path))
        self.assertTrue(biometrics_v2_enabled(self.path))

    def test_off_when_the_file_is_missing_or_broken(self):
        self.assertFalse(unchecked_cap_presence_enabled(self.path))
        self._write('{"features": {"uncheckedCapPresence": tr')
        self.assertFalse(unchecked_cap_presence_enabled(self.path))
        self._write(json.dumps({'features': ['uncheckedCapPresence']}))
        self.assertFalse(unchecked_cap_presence_enabled(self.path))


if __name__ == '__main__':
    unittest.main()
