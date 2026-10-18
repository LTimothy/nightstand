import traceback
from typing import Literal, get_args, Optional, Tuple, List
import platform
import logging
from logging.handlers import RotatingFileHandler
from datetime import datetime
import os
import sys
import time


LoggerName = Literal['sleep-analyzer', 'calibrate-sensor', 'free-sleep-stream']
LOGGER_NAMES: List[LoggerName] = list(get_args(LoggerName))


class BaseLogger(logging.Logger):
    date: str
    start_time: str
    folder_path: str

    def __init__(self, name):
        super().__init__(name)

    def runtime(self):
        return str(datetime.now() - datetime.strptime(self.start_time, '%Y-%m-%d %H:%M:%S'))

    def error(self, msg, *args, **kwargs):
        super().error(msg, *args, **kwargs)
        if isinstance(msg, BaseException):
            trace = ''.join(traceback.format_exception(type(msg), msg, msg.__traceback__))
            super().error(trace.rstrip())


def _get_logger_instance(name: str = None) -> Tuple[BaseLogger, LoggerName]:
    if name is None:
        loggers = list(logging.root.manager.loggerDict.keys())
        for name in LOGGER_NAMES:
            if name in loggers:
                logger: BaseLogger= logging.getLogger(name)
                return logger, name
        raise Exception('Default logger not found!')

    logger: BaseLogger= logging.getLogger(name)
    return logger, name



_LEVELS = {'DEBUG': logging.DEBUG, 'INFO': logging.INFO, 'WARNING': logging.WARNING,
           'WARN': logging.WARNING, 'ERROR': logging.ERROR}


def _get_log_level():
    # Unset or unknown keeps DEBUG, the level the files have always had.
    return _LEVELS.get(os.getenv('LOG_LEVEL', '').strip().upper(), logging.DEBUG)


class FixedWidthFormatter(logging.Formatter):
    converter = time.gmtime

    def format(self, record):
        # Format timestamp
        timestamp = self.formatTime(record, datefmt='%Y-%m-%d %H:%M:%S')

        # Fixed-width formatting for LEVEL (8 chars) and FILE:LINE (30 chars)
        level = f"{record.levelname:<8}"
        file_info = f"{record.filename}:{record.lineno}"
        file_info_padded = f"{file_info:<40}"  # Left-align to 40 chars

        # Combine formatted parts
        formatted_message = f"{timestamp} UTC | {level} | {file_info_padded} | {record.getMessage()}"
        return formatted_message


FORMATTER = FixedWidthFormatter()


def _get_file_handler(data_folder_path: str, name: str):
    folder_path = f'{data_folder_path}logs/'

    if not os.path.isdir(folder_path):
        os.makedirs(folder_path)

    handler = RotatingFileHandler(
        filename=f"{folder_path}/{name}.log",
        mode='a',
        maxBytes=15 * 1024 * 1024,  # 15MB max file size
        # backupCount must be >= 1 for RotatingFileHandler to actually cap the
        # size. With backupCount=0 it never rotates and the file grows forever
        # (this let free-sleep-stream.log reach ~8GB and fill /persistent).
        # free-sleep-stream.log (DEBUG piezo/presence logging) is the noisiest
        # of these and fills ~10MB every ~2 hours, so 30MB only held ~1 day of
        # history. 4 backups => at most ~75MB per logger, ~3 days for that one;
        # /persistent has 13GB free so this is negligible.
        backupCount=4,
        encoding="utf-8",
    )
    handler.setFormatter(FORMATTER)
    return handler


def _get_console_handler(level):
    handler = logging.StreamHandler()
    # Under systemd stderr goes to the journal, and the log file already has every line.
    handler.setLevel(max(level, logging.WARNING) if os.getenv('JOURNAL_STREAM') else level)
    # Use the custom FixedWidthFormatter
    handler.setFormatter(FORMATTER)
    return handler


def data_folder() -> str:
    """The persistent data folder, with a trailing slash.

    DATA_FOLDER wins when set (the server passes its own to the jobs it
    starts). Otherwise the Pod path on Linux, or the repo's local mirror
    under server/free-sleep-data elsewhere.
    """
    folder = os.environ.get('DATA_FOLDER')
    if not folder:
        if platform.system().lower() == 'linux':
            folder = '/persistent/free-sleep-data/'
        else:
            folder = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'server', 'free-sleep-data')
    return os.path.join(os.path.normpath(folder), '')


def _build_logger(logger: BaseLogger, name: LoggerName):
    logger.date = datetime.now().strftime('%Y-%m-%d')
    logger.start_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    logger.propagate = False
    logger.folder_path = data_folder()

    level = _get_log_level()
    logger.setLevel(level)
    logger.addHandler(_get_console_handler(level))
    logger.addHandler(_get_file_handler(logger.folder_path, name))





def get_logger(name: Optional[LoggerName] = None) -> BaseLogger:
    """
    Returns:
        BaseLogger: Custom logger with fixed-width formatting
    """
    logging.setLoggerClass(BaseLogger)
    logger, name = _get_logger_instance(name)
    if not logger.handlers:
        _build_logger(logger, name)

    return logger

