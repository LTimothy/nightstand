"""Data folder selection, log timestamps and exception logging."""
import logging
import os
import sys
import unittest
import unittest.mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import get_logger as gl

gl._get_file_handler = lambda *args: logging.NullHandler()


class _Collect(logging.Handler):
    def __init__(self):
        super().__init__()
        self.messages = []

    def emit(self, record):
        self.messages.append(record.getMessage())


class DataFolderTest(unittest.TestCase):
    def test_data_folder_env_wins_and_gains_a_trailing_slash(self):
        with unittest.mock.patch.dict(os.environ, {'DATA_FOLDER': '/tmp/nightstand-data'}):
            self.assertEqual(gl.data_folder(), '/tmp/nightstand-data/')
        with unittest.mock.patch.dict(os.environ, {'DATA_FOLDER': '/tmp/nightstand-data/'}):
            self.assertEqual(gl.data_folder(), '/tmp/nightstand-data/')

    def test_pod_path_on_linux_without_env(self):
        with unittest.mock.patch.dict(os.environ, {'DATA_FOLDER': ''}), \
                unittest.mock.patch.object(gl.platform, 'system', return_value='Linux'):
            self.assertEqual(gl.data_folder(), '/persistent/free-sleep-data/')

    def test_repo_mirror_elsewhere_without_env(self):
        with unittest.mock.patch.dict(os.environ, {'DATA_FOLDER': ''}), \
                unittest.mock.patch.object(gl.platform, 'system', return_value='Darwin'):
            folder = gl.data_folder()
        self.assertTrue(os.path.isabs(folder))
        self.assertTrue(folder.endswith(os.path.join('server', 'free-sleep-data', '')))
        expected = os.path.abspath(os.path.join(os.path.dirname(gl.__file__), '..', 'server', 'free-sleep-data'))
        self.assertEqual(folder, expected + os.sep)


class FormatterTest(unittest.TestCase):
    def test_timestamps_are_utc_as_labelled(self):
        record = logging.LogRecord('t', logging.INFO, 'f.py', 1, 'hello', None, None)
        record.created = 0
        self.assertTrue(gl.FORMATTER.format(record).startswith('1970-01-01 00:00:00 UTC'))


class ErrorTracebackTest(unittest.TestCase):
    def test_exception_is_followed_by_its_traceback(self):
        logger = gl.BaseLogger('traceback-test')
        handler = _Collect()
        logger.addHandler(handler)
        try:
            raise ValueError('boom')
        except ValueError as error:
            logger.error(error)
        self.assertEqual(handler.messages[0], 'boom')
        self.assertIn('Traceback', handler.messages[1])
        self.assertIn('ValueError: boom', handler.messages[1])
        self.assertNotIn('None', handler.messages)

    def test_plain_message_logs_once(self):
        logger = gl.BaseLogger('plain-test')
        handler = _Collect()
        logger.addHandler(handler)
        logger.error('just text')
        self.assertEqual(handler.messages, ['just text'])


def _console(logger):
    return [h for h in logger.handlers if type(h) is logging.StreamHandler]


class LevelTest(unittest.TestCase):
    def build(self, **env):
        with unittest.mock.patch.dict(os.environ, env):
            for key in ('LOG_LEVEL', 'JOURNAL_STREAM'):
                if key not in env:
                    os.environ.pop(key, None)
            logger = gl.BaseLogger('level-test')
            gl._build_logger(logger, 'free-sleep-stream')
        return logger

    def test_unset_level_keeps_debug(self):
        logger = self.build()
        self.assertEqual(logger.level, logging.DEBUG)
        self.assertEqual(_console(logger)[0].level, logging.DEBUG)

    def test_log_level_is_honoured_in_any_case(self):
        self.assertEqual(self.build(LOG_LEVEL='info').level, logging.INFO)
        self.assertEqual(self.build(LOG_LEVEL='WARNING').level, logging.WARNING)
        self.assertEqual(self.build(LOG_LEVEL='nonsense').level, logging.DEBUG)

    def test_journal_gets_only_warnings_and_errors(self):
        logger = self.build(JOURNAL_STREAM='8:12345')
        self.assertEqual(logger.level, logging.DEBUG)
        self.assertEqual(_console(logger)[0].level, logging.WARNING)

    def test_journal_level_never_drops_below_the_configured_one(self):
        logger = self.build(JOURNAL_STREAM='8:12345', LOG_LEVEL='error')
        self.assertEqual(_console(logger)[0].level, logging.ERROR)


if __name__ == '__main__':
    unittest.main()
