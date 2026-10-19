"""
This script processes the 8 Sleep Pod's CBOR-encoded biometric data in
real-time.

It consumes the pod firmware's own NATS JetStream ('raw' stream on
localhost), which carries sensor records as they are produced. If NATS is
unavailable (older firmware, nats-py not installed, or the stream is
missing), or connects but carries no sensor records for two minutes, it also
reads the latest .RAW file in /persistent with the byte-accurate CBOR reader.

Key functionalities:
- Pulls records from NATS JetStream with an ephemeral consumer, deduplicated by
  stream and firmware sequence number.
- Fallback: watches the `/persistent` directory for new .RAW files using
  `watchdog`, tracking only the most recently modified file.
- Filters and processes `piezo-dual` sensor data, ensuring only recent
  entries are used; forwards `frzTemp` records as sensor temperatures.
- Loads parsed piezoelectric sensor data into `load_piezo_row` and queues it
  for processing by `StreamProcessor` in a separate thread.
- Closes its consumer and file handles on shutdown.

Usage:
This is set up to run as a systemctl service, but you can manually run it with:
/home/dac/venv/bin/python /home/dac/free-sleep/biometrics/stream/stream.py
"""

import sys
import platform
import cbor2
import asyncio
from uuid import uuid4
import math
from datetime import datetime, timedelta, timezone
from collections import deque

if platform.system().lower() == 'linux':
    sys.path.append('/home/dac/free-sleep/biometrics/')
    sys.path.append('/home/dac/free-sleep/biometrics/stream/')

import time
import os
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
import queue
import threading

from get_logger import get_logger
logger = get_logger('free-sleep-stream')

import vendored  # noqa: F401

import calibration
from features import biometrics_v2_enabled
from presence.model import on_this_pod
from presence.params import baselines_from_calibration, learned_levels, params_from_calibration
from presence.sensors import TYPE_NAME_LENGTH, printable_type, read_cap, unknown_cap_type
from stream_processor import LatestCap, StreamProcessor
from load_raw_files import load_piezo_row, _read_raw_record, _find_next_raw_record
from service_health import update_health, update_sensor_temps, update_pump_health
from pump_speed import PumpSpeed
from raw_decoder import decode_row
from firmware_telemetry import firmware_delivery

# Bound pending work when processing falls behind.
piezo_record_queue = queue.Queue(maxsize=120)
# Newest capacitance reading, for capacitance presence.
latest_cap = LatestCap()
# When the pump ran fast, from frzHealth frames, for the newer vitals.
pump_speed = PumpSpeed()
_pump_frame_warned = False
_firmware_ingest_warning_at = None
_record_warning_at = {}  # per source, so RAW and NATS warnings do not hide each other
# A vitals switch that fails is retried every refresh; only the first failure is an error.
_vitals_switch_failed = False
# Capacitance presence runs only while capacitance records keep arriving, so a
# Pod without them keeps piezo presence with the switch on.
CAP_FRESH_SECONDS = 60
# Capacitance types this version cannot read, each warned about once, up to a cap.
_unknown_cap_logged = set()
_unknown_cap_overflow_logged = False
UNKNOWN_CAP_LOG_LIMIT = 16
UNKNOWN_CAP_NAME_LENGTH = TYPE_NAME_LENGTH
# Reasons live presence waits on an unchecked format, each logged once.
_experimental_logged = set()

# How often the NATS consumer loop reports itself healthy. Matches the 60s
# cadence of BiometricProcessor._presence_heartbeat_interval; frequent enough
# that a stall shows up on the health page within a minute, without posting a
# request on every loop iteration.
STREAM_HEALTH_INTERVAL_SECONDS = 60
RECENT_RECORD_WINDOW = timedelta(minutes=2)
NATS_URL = 'nats://127.0.0.1:4222'
NATS_STREAM = 'raw'
SOURCE_IDLE_SECONDS = 30 * 60
NATS_REQUEST_SECONDS = 5
NATS_RETRY_MAX_SECONDS = 30
# A connected stream that carries no sensor records this long gets RAW files read alongside it.
NATS_SILENT_SECONDS = RECENT_RECORD_WINDOW.total_seconds()
RAW_POLL_SECONDS = 1
# The durable consumer earlier versions created; it never expires on its own.
LEGACY_CONSUMER = 'free_sleep_stream_live'
_legacy_consumer_checked = False
_stream_started_at = time.monotonic()
_last_sensor_record = None
# Where a new session resumes, so a reconnect does not replay what was read.
_last_stream_sequence = None
_last_stream_message_at = 0.0
PROCESSED_SEQUENCE_LIMIT = 5000
processed_sequences = set()
processed_sequence_order = deque(maxlen=PROCESSED_SEQUENCE_LIMIT)


def _safe_getmtime(path: str) -> float:
    try:
        if os.path.exists(path):
            return os.path.getmtime(path)
    except FileNotFoundError:
        logger.warning(f'File path not found, ignoring... {path}')
        pass
    return 0  # Default for missing files


def _mark_sequence_processed(sequence):
    if sequence is None:
        return
    if len(processed_sequence_order) == processed_sequence_order.maxlen:
        oldest = processed_sequence_order.popleft()
        processed_sequences.discard(oldest)
    processed_sequence_order.append(sequence)
    processed_sequences.add(sequence)


def _decode_raw_row(row):
    return decode_row(row)


def _queue_decoded_piezo_record(decoded_data) -> bool:
    if not isinstance(decoded_data, dict):
        logger.warning(f'Skipping unexpected nested CBOR value: {type(decoded_data)}')
        return False
    if decoded_data.get('type') != 'piezo-dual':
        return False
    if 'ts' not in decoded_data:
        logger.warning(f'Skipping piezo-dual record without timestamp: {decoded_data.keys()}')
        return False

    record_time = datetime.fromtimestamp(decoded_data['ts'])
    if datetime.now() - record_time > RECENT_RECORD_WINDOW:
        return False

    metadata = decoded_data.get('_firmware')
    sequence = ((metadata['sequence'], metadata['index']) if metadata and metadata['sequence'] is not None
                else decoded_data.get('seq'))
    if sequence in processed_sequences:
        return False

    load_piezo_row(decoded_data, 'right')
    _put_latest(decoded_data)
    _mark_sequence_processed(sequence)
    return True


def _warn_unknown_cap(kind: str) -> None:
    global _unknown_cap_overflow_logged
    if kind in _unknown_cap_logged:
        return
    if len(_unknown_cap_logged) < UNKNOWN_CAP_LOG_LIMIT:
        _unknown_cap_logged.add(kind)
        logger.warning(f'Capacitance records of type {kind} are not a format this version reads, '
                       'live presence stays on the vibration sensor')
    elif not _unknown_cap_overflow_logged:
        _unknown_cap_overflow_logged = True
        logger.warning('More unknown capacitance types not shown')


def _store_decoded_cap_record(decoded_data) -> bool:
    """Keep the newest capacitance channels; True for every capacitance record, stored or not."""
    reading = read_cap(decoded_data)
    if reading is None:
        kind = unknown_cap_type(decoded_data)
        if kind is None:
            return False
        _warn_unknown_cap(printable_type(kind))
        return True
    ts = reading.ts
    if not _is_number(ts):
        return True
    try:
        recorded_at = datetime.fromtimestamp(ts)
    except (ValueError, OverflowError, OSError):
        return True
    if datetime.now() - recorded_at > RECENT_RECORD_WINDOW:
        return True
    if reading.left is not None and reading.right is not None:
        latest_cap.update(ts, reading.left, reading.right, reading.cap_format)
    return True


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _presence_v2_inputs(stream_processor=None):
    """Capacitance detector inputs when it should run, else None.

    (params, baselines) for a checked format on a Pod 5; (params, baselines,
    format) otherwise, which runs only once both sides have a learned level
    and piezo records are seen to come once a second.
    """
    if not biometrics_v2_enabled():
        return None
    if not latest_cap.is_fresh(time.time(), CAP_FRESH_SECONDS):
        return None
    cap_format = latest_cap.cap_format()
    if cap_format is None:
        return None
    cap_format = on_this_pod(cap_format, logger)
    profiles = calibration.load_presence_profiles()
    params = params_from_calibration(profiles, cap_format)
    baselines = baselines_from_calibration(profiles, cap_format)
    if params is None or baselines is None:
        return None
    if cap_format.validated:
        return params, baselines
    if not _experimental_ready(stream_processor, profiles, cap_format):
        return None
    return params, baselines, cap_format


def _experimental_ready(stream_processor, profiles, cap_format) -> bool:
    if not learned_levels(profiles, cap_format):
        reason = "until the nightly analysis has learned both sides' occupied levels"
    elif stream_processor is None or stream_processor.cadence.ok() is not True:
        reason = 'until piezo records are seen to come once a second'
    else:
        return True
    if (cap_format.name, reason) not in _experimental_logged:
        _experimental_logged.add((cap_format.name, reason))
        logger.info(f'With {cap_format.name} capacitance, the vibration sensor keeps deciding who is in bed, '
                    f'and the legacy estimators keep taking vitals, {reason}')
    return False


def _refresh_presence_mode(stream_processor) -> None:
    # A failed read is not an answer: only the definite conditions in _presence_v2_inputs hand presence back.
    try:
        inputs = _presence_v2_inputs(stream_processor)
    except Exception as error:
        logger.warning(f'Could not work out the presence mode, keeping the current one: {error}')
        return
    _switch_presence_mode(stream_processor, inputs)


def _refresh_vitals_mode(stream_processor) -> None:
    # biometrics_v2_enabled reads as off on any error, the same answer presence gets.
    global _vitals_switch_failed
    try:
        stream_processor.use_vitals_v2(biometrics_v2_enabled())
    except Exception as error:
        if not _vitals_switch_failed:
            _vitals_switch_failed = True
            logger.error(f'Could not switch the vitals path, keeping the current one; retried each minute, '
                         f'later failures are not reported: {error}')
        else:
            logger.debug(f'Could not switch the vitals path, keeping the current one: {error}')


def _note_pump_speed(frame) -> None:
    # A frame the pump gate cannot read must not stop the reader; the first one is reported.
    global _pump_frame_warned
    try:
        pump_speed.note(frame)
    except Exception as error:
        if not _pump_frame_warned:
            _pump_frame_warned = True
            logger.warning(f'Could not read the pump speed from a frzHealth frame, more are not reported: {error}')
        else:
            logger.debug(f'Could not read the pump speed from a frzHealth frame: {error}')


def _switch_presence_mode(stream_processor, inputs) -> None:
    # A failed switch keeps the current mode; it must never end the processing thread.
    try:
        stream_processor.use_presence_v2(inputs)
    except Exception as error:
        logger.error(f'Could not switch presence mode, keeping the current one: {error}')


def _drop_stale_presence_v2(stream_processor) -> None:
    """Hand presence back to piezo as soon as capacitance stops, not at the next refresh."""
    if stream_processor.presence is not None and not latest_cap.is_fresh(time.time(), CAP_FRESH_SECONDS):
        _switch_presence_mode(stream_processor, None)


def _put_latest(record):
    try:
        piezo_record_queue.put_nowait(record)
    except queue.Full:
        try:
            piezo_record_queue.get_nowait()
            piezo_record_queue.task_done()
        except queue.Empty:
            pass
        piezo_record_queue.put_nowait(record)


def _ingest_live_record(record, source='RAW') -> bool:
    """Hand a record on; True when it is a fresh sensor record."""
    global _last_sensor_record, _firmware_ingest_warning_at
    if not isinstance(record, dict):
        return False
    try:
        firmware_delivery.ingest(record, source)
    except Exception as error:
        now = time.monotonic()
        if _firmware_ingest_warning_at is None or now - _firmware_ingest_warning_at >= 60:
            _firmware_ingest_warning_at = now
            logger.warning(f'Could not ingest firmware telemetry: {error}')
    kind = record.get('type')
    timestamp = record.get('ts')
    fresh = (kind in ('piezo-dual', 'capSense', 'capSense2', 'frzTemp', 'frzHealth', 'frzTherm', 'bedTemp', 'bedTemp2')
             and _is_number(timestamp) and math.isfinite(timestamp)
             and abs(time.time() - timestamp) <= RECENT_RECORD_WINDOW.total_seconds())
    if fresh:
        _last_sensor_record = time.monotonic()
    if kind == 'frzTemp':
        update_sensor_temps(record)
    elif kind == 'frzHealth':
        _note_pump_speed(record)
        update_pump_health(record)
    elif not _store_decoded_cap_record(record):
        _queue_decoded_piezo_record(record)
    return fresh


def _ingest_or_skip(record, source='RAW') -> bool:
    """_ingest_live_record, skipping a record it cannot process so later records still arrive."""
    try:
        return _ingest_live_record(record, source)
    except Exception as error:
        now = time.monotonic()
        if source not in _record_warning_at or now - _record_warning_at[source] >= 60:
            _record_warning_at[source] = now
            logger.warning(f'Skipping a {source} record that could not be processed: {error}')
        return False


def _report_stream_health(processing_thread) -> bool:
    if not processing_thread.is_alive():
        update_health('stream', 'failed', 'processing thread stopped')
        return False
    last_record = _last_sensor_record if _last_sensor_record is not None else _stream_started_at
    if time.monotonic() - last_record >= SOURCE_IDLE_SECONDS:
        update_health('stream', 'failed', 'No sensor data from the Pod for 30 minutes')
    else:
        update_health('stream', 'healthy' if _last_sensor_record is not None else 'started', '')
    return True


class LatestRawFileHandler(FileSystemEventHandler):
    """Monitors only the latest RAW file and processes CBOR-encoded lines separately."""

    def __init__(self, directory):
        self.directory = directory
        self.latest_file = None
        self.latest_file_obj = None
        self.last_pos = 0  # Track last read position
        self.track_latest_file()

    def track_latest_file(self):
        """Finds the most recent RAW file in the directory and starts tracking it."""
        raw_files = [f for f in os.listdir(self.directory) if f.endswith(".RAW") and not f.endswith('SEQNO.RAW')]
        if not raw_files:
            return

        # Get the latest file by modification time
        raw_files.sort(
            key=lambda f: _safe_getmtime(os.path.join(self.directory, f)),
            reverse=True
        )

        latest_file = os.path.join(self.directory, raw_files[0])

        if latest_file != self.latest_file:
            # Read what the old file gained since the last pass before leaving it.
            if self.latest_file_obj:
                try:
                    self.follow_latest_file()
                except Exception as error:
                    logger.warning(f'Could not finish reading {self.latest_file}: {error}')
                self.latest_file_obj.close()
            self.latest_file = latest_file
            logger.debug(f"Now tracking: {self.latest_file}")

            # Open the new file for reading in binary mode
            self.latest_file_obj = open(self.latest_file, "rb")
            self.last_pos = 0  # Reset position for new file

    def on_created(self, event):
        """Triggered when a new .RAW file is created."""
        if event.is_directory or not event.src_path.endswith(".RAW"):
            return
        self.track_latest_file()

    def follow_latest_file(self):
        """Reads and decodes new CBOR-encoded lines from the latest file."""
        if not self.latest_file_obj:
            return

        # Move to the last known position before reading
        self.latest_file_obj.seek(self.last_pos)

        while True:
            end = os.fstat(self.latest_file_obj.fileno()).st_size
            try:
                # Manual reader instead of cbor2.load(), the C extension
                # reads in 4096-byte chunks and skips most records (see
                # _read_raw_record in load_raw_files.py). last_pos advances
                # past every parsed record, including skipped ones, so they
                # aren't re-parsed on the next follow pass.
                data_bytes = _read_raw_record(self.latest_file_obj, with_sequence=True)
                if data_bytes is None:
                    self.last_pos = self.latest_file_obj.tell()
                    continue  # empty placeholder record

                decoded_records = list(_decode_raw_row(data_bytes))

            except (EOFError, ValueError, cbor2.CBORDecodeError) as error:
                next_pos = _find_next_raw_record(self.latest_file_obj, self.last_pos, end)
                if next_pos is not None:
                    logger.warning(f'Skipped {next_pos - self.last_pos} bytes in {self.latest_file} '
                                   f'at offset {self.last_pos} after RAW decode failure: {error}')
                    self.last_pos = next_pos
                    continue
                # No complete later record: retry this offset after an append.
                if not isinstance(error, EOFError):
                    logger.error(f'Error reading record: {error}')
                break

            self.last_pos = self.latest_file_obj.tell()
            for decoded_data in decoded_records:
                _ingest_or_skip(decoded_data)


def process_biometrics(stop_event=None):
    stop_event = stop_event or threading.Event()
    while not stop_event.is_set():
        try:
            piezo_record = piezo_record_queue.get(timeout=5)
            break
        except queue.Empty:
            continue
    else:
        return
    if piezo_record is None:
        piezo_record_queue.task_done()
        return
    stream_processor = StreamProcessor(piezo_record, debug=False, cap_source=latest_cap, pump=pump_speed)
    _refresh_presence_mode(stream_processor)
    _refresh_vitals_mode(stream_processor)
    ix = 0
    while not stop_event.is_set():
        ix += 1
        if ix == 60:
            _refresh_presence_mode(stream_processor)
            _refresh_vitals_mode(stream_processor)
            ix = 0
        try:
            piezo_record = piezo_record_queue.get(timeout=5)

            if piezo_record is None:
                # Stop if None is received
                break

            _drop_stale_presence_v2(stream_processor)
            stream_processor.process_piezo_record(piezo_record)
            piezo_record_queue.task_done()
        except queue.Empty:
            # Just continue if the queue is empty, do not exit the loop
            logger.info("No new data, retrying...")
        except Exception as error:
            logger.error(error)
            update_health('stream', 'failed', repr(error))


def watch_directory(directory="/persistent"):
    """Monitors the directory for new RAW files and processes only the latest one."""
    logger.info('Stream processor starting...')
    update_health('stream', 'started', '')
    handler = LatestRawFileHandler(directory)
    observer = Observer()
    observer.schedule(handler, directory, recursive=False)
    observer.start()

    # Start biometric processing in a separate thread
    stop_event = threading.Event()
    processing_thread = threading.Thread(target=process_biometrics, args=(stop_event,), daemon=True)
    processing_thread.start()

    logger.debug('Stream processor set up successfully, running...')
    last_health_update = time.monotonic()
    try:
        while True:
            time.sleep(1)
            handler.track_latest_file()  # Check if a newer file exists
            handler.follow_latest_file()  # Read new CBOR entries line-by-line
            if time.monotonic() - last_health_update >= STREAM_HEALTH_INTERVAL_SECONDS:
                if not _report_stream_health(processing_thread):
                    raise RuntimeError('processing thread stopped')
                last_health_update = time.monotonic()
    except KeyboardInterrupt:
        pass
    except Exception as error:
        logger.error(error)
        update_health('stream', 'failed', repr(error))
        raise
    finally:
        observer.stop()
        observer.join()
        if handler.latest_file_obj is not None:
            handler.latest_file_obj.close()
        stop_event.set()
        _put_latest(None)
        processing_thread.join(timeout=5)
        _drain_queue(piezo_record_queue)


class _RawFiles:
    """The newest RAW file in a directory, opened on first use."""

    def __init__(self, directory):
        self.directory = directory
        self.handler = None

    def poll(self):
        try:
            if self.handler is None:
                self.handler = LatestRawFileHandler(self.directory)
            self.handler.track_latest_file()
            self.handler.follow_latest_file()
        except OSError as error:
            logger.debug(f'RAW files unavailable: {error}')

    def close(self):
        if self.handler is not None and self.handler.latest_file_obj is not None:
            self.handler.latest_file_obj.close()


def _stream_sequence(message):
    try:
        sequence = message.metadata.sequence.stream
    except Exception:
        return None
    return sequence if isinstance(sequence, int) and not isinstance(sequence, bool) else None


def _resume_sequence(state):
    """The next stream sequence to read when the last one is recent and still in the stream, else None."""
    global _last_stream_sequence
    if _last_stream_sequence is not None:
        resume = _last_stream_sequence + 1
        try:
            if (time.monotonic() - _last_stream_message_at <= RECENT_RECORD_WINDOW.total_seconds()
                    and state.first_seq <= resume <= state.last_seq + 1):
                return resume
        except (AttributeError, TypeError):
            pass
    _last_stream_sequence = None
    return None


async def _remove_legacy_consumer(jetstream, not_found):
    global _legacy_consumer_checked
    if _legacy_consumer_checked:
        return
    _legacy_consumer_checked = True
    try:
        await jetstream.delete_consumer(NATS_STREAM, LEGACY_CONSUMER)
        logger.info('Removed the NATS consumer an earlier version left behind')
    except not_found:
        pass
    except Exception as error:
        logger.debug(f'Could not remove the earlier NATS consumer: {error}')


async def _nats_session(processing_thread, raw_files=None):
    """Read all subjects with an independently owned consumer and no acknowledgments."""
    global _last_stream_sequence, _last_stream_message_at
    import nats
    from nats.js.api import AckPolicy, ConsumerConfig, DeliverPolicy, RetentionPolicy
    from nats.js.errors import NotFoundError

    connection = jetstream = consumer_name = None

    async def note_error(error):
        logger.debug(f'NATS client: {error}')

    try:
        # Retry outside the client so RAW fallback and health keep running during an outage.
        connection = await nats.connect(NATS_URL, connect_timeout=2, allow_reconnect=False,
                                        max_reconnect_attempts=1, reconnect_time_wait=0,
                                        error_cb=note_error)
        jetstream = connection.jetstream(timeout=NATS_REQUEST_SECONDS)
        info = await jetstream.stream_info(NATS_STREAM)
        if info.config.retention != RetentionPolicy.LIMITS:
            raise RuntimeError('NATS raw stream retention must be limits for a read-only consumer')
        await _remove_legacy_consumer(jetstream, NotFoundError)
        resume = _resume_sequence(getattr(info, 'state', None))
        if resume is None:
            start = {'deliver_policy': DeliverPolicy.BY_START_TIME,
                     'opt_start_time': datetime.now(timezone.utc) - RECENT_RECORD_WINDOW}
        else:
            start = {'deliver_policy': DeliverPolicy.BY_START_SEQUENCE, 'opt_start_seq': resume}
        consumer_name = 'nightstand_live_' + uuid4().hex
        created = await jetstream.add_consumer(NATS_STREAM, config=ConsumerConfig(
            name=consumer_name,
            ack_policy=AckPolicy.NONE,
            inactive_threshold=60.0,
            mem_storage=True,
            **start,
        ))
        consumer_name = created.name
        subscription = await jetstream.pull_subscribe_bind(
            stream=NATS_STREAM, consumer=consumer_name,
            pending_msgs_limit=50, pending_bytes_limit=4 * 1024 * 1024)
        logger.info(f'Consuming NATS JetStream stream={NATS_STREAM}')
        last_health_update = time.monotonic()
        last_nats_record = time.monotonic()
        reading_raw = False
        while True:
            if time.monotonic() - last_health_update >= STREAM_HEALTH_INTERVAL_SECONDS:
                if not _report_stream_health(processing_thread):
                    raise RuntimeError('processing thread stopped')
                last_health_update = time.monotonic()
            silent = raw_files is not None and time.monotonic() - last_nats_record >= NATS_SILENT_SECONDS
            if silent != reading_raw:
                reading_raw = silent
                logger.info('No sensor records from NATS for 2 minutes, reading RAW files as well' if silent
                            else 'Sensor records are arriving from NATS again')
            if silent:
                raw_files.poll()
            try:
                messages = await subscription.fetch(25, timeout=RAW_POLL_SECONDS if silent else NATS_REQUEST_SECONDS)
            except asyncio.TimeoutError:
                # An inactive consumer may have expired while no sensors were publishing.
                await jetstream.consumer_info(NATS_STREAM, consumer_name)
                continue
            for message in messages:
                sequence = _stream_sequence(message)
                if sequence is not None:
                    if _last_stream_sequence is not None and sequence <= _last_stream_sequence:
                        continue
                    _last_stream_sequence = sequence
                    _last_stream_message_at = time.monotonic()
                try:
                    row = cbor2.loads(message.data)
                    for record in _decode_raw_row(row):
                        if _ingest_or_skip(record, 'NATS'):
                            last_nats_record = time.monotonic()
                except Exception as error:
                    logger.warning(f'Error decoding NATS raw message, skipping: {error}')
    finally:
        try:
            if jetstream is not None and consumer_name is not None:
                await asyncio.wait_for(jetstream.delete_consumer(NATS_STREAM, consumer_name), NATS_REQUEST_SECONDS)
        except Exception as error:
            logger.warning(f'Could not remove live NATS consumer: {error}')
        finally:
            if connection is not None:
                await asyncio.wait_for(connection.close(), NATS_REQUEST_SECONDS)


async def watch_nats_stream():
    try:
        import nats  # noqa: F401
    except ImportError as error:
        raise RuntimeError('nats-py is not installed') from error

    update_health('stream', 'started', '')
    stop_event = threading.Event()
    processing_thread = threading.Thread(target=process_biometrics, args=(stop_event,), daemon=True)
    processing_thread.start()
    raw_files = _RawFiles('/persistent')
    backoff = 1
    last_error = None
    last_health_update = time.monotonic()
    try:
        while True:
            connected_at = time.monotonic()
            try:
                await _nats_session(processing_thread, raw_files)
            except Exception as error:
                if not processing_thread.is_alive():
                    _report_stream_health(processing_thread)
                    raise RuntimeError('processing thread stopped') from error
                # A Pod without NATS fails the same way every retry; only a change is worth a warning.
                message = f'NATS stream unavailable, watching RAW files before retry: {error}'
                if repr(error) != last_error:
                    logger.warning(message)
                else:
                    logger.debug(message)
                last_error = repr(error)
            if time.monotonic() - connected_at >= NATS_RETRY_MAX_SECONDS:
                backoff = 1
                last_error = None
            for _ in range(backoff):
                raw_files.poll()
                if time.monotonic() - last_health_update >= STREAM_HEALTH_INTERVAL_SECONDS:
                    if not _report_stream_health(processing_thread):
                        raise RuntimeError('processing thread stopped')
                    last_health_update = time.monotonic()
                await asyncio.sleep(1)
            backoff = min(backoff * 2, NATS_RETRY_MAX_SECONDS)
    finally:
        raw_files.close()
        stop_event.set()
        _put_latest(None)
        processing_thread.join(timeout=5)
        _drain_queue(piezo_record_queue)


def _drain_queue(records) -> None:
    while True:
        try:
            records.get_nowait()
        except queue.Empty:
            return


def watch_stream():
    global _stream_started_at, _last_sensor_record
    _stream_started_at = time.monotonic()
    _last_sensor_record = None
    try:
        asyncio.run(watch_nats_stream())
    except Exception as error:
        logger.warning(f'NATS stream unavailable, falling back to RAW file watcher: {error}')
        watch_directory("/persistent")


if __name__ == '__main__':
    from shutdown import install_shutdown_handlers
    install_shutdown_handlers()
    # Give time for the express.js server to boot
    print('Sleeping for 30 seconds before starting stream service...')
    time.sleep(30)
    # Start watching and processing live biometrics data.
    watch_stream()
