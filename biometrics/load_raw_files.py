import numpy as np
import struct
from datetime import datetime, timedelta, timezone
import cbor2
from pathlib import Path
from typing import Optional
import gc
import sys
import os
import io
from collections import Counter

# Add the current directory to sys.path
sys.path.append(os.getcwd())
from data_types import *
from get_logger import get_logger
from raw_decoder import decode_payload, plain_records
from presence.detector import piezo_range
from presence.piezo import piezo_layout
from presence.sensors import FORMATS, read_cap, unknown_cap_type

logger = get_logger()


def _read_raw_record(f, with_sequence=False):
    """
    Manually parse one outer {seq, data} CBOR record using f.read().

    The cbor2 C extension (_cbor2) reads files in internal 4096-byte chunks,
    so cbor2.load(f) advances f.tell() by 4096 bytes regardless of the actual
    record size. RAW file records are typically 17-5000 bytes (Pod 5
    piezo-dual records are ~2700 bytes), so nearly every record gets skipped
    silently and the pipeline sees almost no data.

    This function parses the outer {seq: uint, data: bytes} wrapper
    byte-by-byte with f.read(), keeping f.tell() accurate after each record.

    With with_sequence=True, returns the envelope map, including seq.
    Otherwise returns the raw inner data bytes, or None for empty placeholder records
    (the Pod firmware writes data=b'' records as sequence-number markers).
    Raises EOFError at end of file or on a record cut short, ValueError on malformed data.
    """
    b = f.read(1)
    if not b:
        raise EOFError
    # Skip NUL padding between records, the firmware pads RAW files, and
    # treating each padding byte as a malformed record would log one error
    # per byte while scanning past it.
    while b[0] == 0x00:
        b = f.read(1)
        if not b:
            raise EOFError
    if b[0] != 0xa2:
        raise ValueError('Expected outer map 0xa2, got 0x%02x' % b[0])
    key = f.read(4)
    if len(key) < 4:
        raise EOFError
    if key != b'\x63\x73\x65\x71':  # text(3) "seq"
        raise ValueError('Expected seq key')
    hdr = f.read(1)
    if not hdr:
        raise EOFError
    val = hdr[0]
    if val <= 0x17:
        sequence = val
    elif val in (0x18, 0x19, 0x1a, 0x1b):
        size = {0x18: 1, 0x19: 2, 0x1a: 4, 0x1b: 8}[val]
        encoded = f.read(size)
        if len(encoded) < size:
            raise EOFError
        sequence = int.from_bytes(encoded, 'big')
    else:
        raise ValueError('Unexpected seq encoding: 0x%02x' % val)
    key = f.read(5)
    if len(key) < 5:
        raise EOFError
    if key != b'\x64\x64\x61\x74\x61':  # text(4) "data"
        raise ValueError('Expected data key')
    bs = f.read(1)
    if not bs:
        raise EOFError
    if bs[0] >> 5 != 2:
        raise ValueError('Expected data byte string')
    ai = bs[0] & 0x1f
    if ai <= 23:
        length = ai
    elif ai == 24:
        lb = f.read(1)
        if not lb:
            raise EOFError
        length = lb[0]
    elif ai == 25:
        lb = f.read(2)
        if len(lb) < 2:
            raise EOFError
        length = struct.unpack('>H', lb)[0]
    elif ai == 26:
        lb = f.read(4)
        if len(lb) < 4:
            raise EOFError
        length = struct.unpack('>I', lb)[0]
    else:
        raise ValueError('Unsupported length encoding: %d' % ai)
    # Check the live file's current end before allocating for a corrupt length.
    payload_start = f.tell()
    available = f.seek(0, io.SEEK_END) - payload_start
    f.seek(payload_start)
    if length > available:
        raise EOFError
    data = f.read(length)
    if len(data) < length:
        raise EOFError
    if not data:
        return None  # empty placeholder record, caller should skip
    return {'seq': sequence, 'data': data} if with_sequence else data


def _find_next_raw_record(handle, after, end):
    """Find a complete record after a bad offset, leaving a live partial tail intact.

    end is the file size taken before the failed read: a record still partial
    then has no complete successor within it, so an append is never skipped.
    """
    header = b'\xa2\x63seq'
    offset = after + 1
    while offset < end:
        handle.seek(offset)
        chunk = handle.read(min(65536, end - offset))
        if not chunk:
            break
        index = chunk.find(header)
        if index < 0:
            offset += max(1, len(chunk) - len(header) + 1)
            continue
        candidate = offset + index
        handle.seek(candidate)
        try:
            payload = _read_raw_record(handle)
            if handle.tell() <= end:
                # A payload may bundle several records; the first must be a typed record.
                record = next(decode_payload(payload), None) if payload is not None else None
                if (payload is None or (isinstance(record, dict)
                        and isinstance(record.get('type'), str) and record['type'])):
                    handle.seek(candidate)
                    return candidate
        except (EOFError, ValueError, cbor2.CBORDecodeError):
            pass
        offset = candidate + 1
    handle.seek(after)
    return None


def get_current_files(folder_path: str):
    # Scan the live folder where frankenfirmware writes RAW files AND the
    # archive that hardlinks them before frank truncates its rolling buffer
    # (~75 min). Without the archive a daily analyze run sees only the last
    # hour. The archive is raw-archive/ under the data folder
    # (/persistent/free-sleep-data/raw-archive/ on the Pod), filled by
    # scripts/archive-raw.sh on a systemd timer. Both entries point to the
    # same inode until frank deletes its own, so dedupe by filename.
    candidates: dict[str, str] = {}
    archive_path = os.path.join(logger.folder_path, 'raw-archive')
    for folder in (folder_path, archive_path):
        if not folder:
            continue
        try:
            for f in Path(folder).glob('*.RAW'):
                if f.is_file() and f.name != 'SEQNO.RAW' and f.name not in candidates:
                    candidates[f.name] = str(f.resolve())
        except (OSError, FileNotFoundError):
            continue
    # Name order, so the same archive always decodes in the same order.
    return [candidates[name] for name in sorted(candidates)]


def _decode_piezo_data(raw_bytes: bytes) -> np.ndarray:
    return np.frombuffer(raw_bytes, dtype=np.int32)


# Pod 5 writes -1 for a capacitance value it could not read.
NO_CAP_READING = -1


def _cap_values_missing(record: dict) -> dict:
    """Per side, whether any raw capSense2 value is missing."""
    missing = {}
    for side in ('left', 'right'):
        channel = record.get(side)
        missing[side] = isinstance(channel, dict) and NO_CAP_READING in (channel.get('values') or ())
    return missing


def _normalize_cap_sense2(record: dict) -> dict:
    """
    Convert a Pod 5 'capSense2' record to the legacy 'capSense' shape.

    Pod 5 firmware writes each side as {'values': [8 floats], 'status'}
    instead of the older {'out', 'cen', 'in', 'status'}. The 8 values arrive
    as 4 near-identical pairs; the 4th pair sits near zero (reference-like),
    so map the first three pair-means onto out/cen/in. The downstream
    baseline/presence math only needs channels that are consistent between
    calibration and detection and shift under load, it computes z-scores
    against a baseline built from this same mapping, so the exact channel
    semantics don't matter.

    Unrecognized shapes are returned unchanged (still typed 'capSense2') and
    fall out at the type filter instead of crashing the load loop.
    """
    converted = {}
    for side in ('left', 'right'):
        channel = record.get(side)
        if not isinstance(channel, dict):
            return record
        values = channel.get('values')
        if not isinstance(values, (list, tuple)) or len(values) < 6:
            return record
        converted[side] = {
            'out': (values[0] + values[1]) / 2,
            'cen': (values[2] + values[3]) / 2,
            'in': (values[4] + values[5]) / 2,
            'status': channel.get('status', 'good'),
        }
    record.update(converted)
    record['type'] = 'capSense'
    return record


def load_piezo_row(data: dict, side: Side):
    # if side == 'left':
    if 'left1' in data:
        data['left1'] = _decode_piezo_data(data['left1'])
    if 'left2' in data:
        data['left2'] = _decode_piezo_data(data['left2'])
    # else:
    if 'right1' in data:
        data['right1'] = _decode_piezo_data(data['right1'])
    if 'right2' in data:
        data['right2'] = _decode_piezo_data(data['right2'])


def _delete_other_side(decoded_data: dict, side: Side, sensor_count: int):
    """Drop the other side's data to save memory; records without per-sensor keys pass through."""
    del_side = 'right' if side == 'left' else 'left'
    if decoded_data['type'] == 'capSense':
        decoded_data.pop(del_side, None)
        return
    if sensor_count == 1:
        decoded_data.pop(f'{side}2', None)
    decoded_data.pop(f'{del_side}1', None)
    decoded_data.pop(f'{del_side}2', None)


def _capture_presence(record: dict):
    """Both sides' presence inputs, taken before normalization and _delete_other_side drop them."""
    if record.get('type') == 'piezo-dual':
        return 'piezo', record.get('left1'), record.get('right1'), piezo_layout(record)
    reading = read_cap(record)
    if reading is not None:
        if reading.left is not None and reading.right is not None:
            return 'cap', reading.left, reading.right, reading.cap_format.name
        return None
    kind = unknown_cap_type(record)
    return None if kind is None else ('unknown', kind)


def _cap_format_name(record) -> Optional[str]:
    """The record's capacitance format name, 'unknown' for capacitance no format reads, else None."""
    kind = record.get('type') if isinstance(record, dict) else None
    if kind in FORMATS:
        return kind
    return 'unknown' if unknown_cap_type(record) is not None else None


def _in_window(record: dict, start_time, end_time) -> bool:
    try:
        return start_time <= datetime.fromtimestamp(record['ts'], timezone.utc) <= end_time
    except (KeyError, TypeError, ValueError, OverflowError, OSError):
        return False


def _record_range(raw):
    if raw is None:
        return None
    try:
        return piezo_range(np.frombuffer(raw, dtype=np.int32))
    except (TypeError, ValueError):
        # The dropped side's bytes never reached the loader's decode, so they must not fail the record.
        return None


def _feed_presence(collector, capture, ts: int):
    if capture[0] == 'cap':
        _, left, right, name = capture
        collector.add_cap(ts, left, right)
        collector.note_cap_format(name)
    else:
        _, left, right, layout = capture
        collector.add_piezo(ts, _record_range(left), _record_range(right))
        collector.note_piezo_layout(layout)


def _ingest_record(decoded_data: dict, data: dict, start_time, end_time, side: Side, sensor_count: int,
                   presence_collector=None, cap_formats=None, check_file_span=False, unknown_caps=None):
    """Shared normalization and collection; False skips a RAW file outside the window."""
    load_raw_types = data.keys()
    format_name = _cap_format_name(decoded_data) if cap_formats is not None else None
    presence_capture = _capture_presence(decoded_data) if presence_collector is not None else None
    unknown_kind = None
    if presence_capture is not None and presence_capture[0] == 'unknown':
        # An unknown type never passes the type filter below.
        unknown_kind = presence_capture[1]
        presence_capture = None
    # Pod 5 writes 'capSense2' records; normalize them to the
    # legacy 'capSense' shape before the type filter so Pod 5
    # capacitance data isn't silently dropped.
    if decoded_data.get('type') == 'capSense2':
        missing = _cap_values_missing(decoded_data)
        decoded_data = _normalize_cap_sense2(decoded_data)
        if decoded_data['type'] == 'capSense':
            # Movement skips these rows; presence and calibration
            # read only out, cen and in.
            for cap_side, value in missing.items():
                decoded_data[cap_side]['no_reading'] = value
    if not decoded_data['type'] in load_raw_types:
        # Never loaded, but still what the Pod writes in this window.
        if (format_name == 'unknown' or unknown_kind is not None) and \
                _in_window(decoded_data, start_time, end_time):
            if format_name == 'unknown':
                cap_formats[format_name] += 1
            if unknown_kind is not None:
                if unknown_caps is not None:
                    unknown_caps[unknown_kind] += 1
                else:
                    try:
                        presence_collector.note_unknown_cap(unknown_kind)
                    except Exception as error:
                        logger.error(error)
        return None
    _delete_other_side(decoded_data, side, sensor_count)
    record_time = datetime.fromtimestamp(decoded_data['ts'], timezone.utc)
    if check_file_span:
        timestamp_end = record_time + timedelta(minutes=15)
        if not (start_time <= record_time <= end_time or start_time <= timestamp_end <= end_time):
            return False

    # A file spans ~15 minutes and can straddle either window edge.
    if not start_time <= record_time <= end_time:
        return True
    if format_name is not None:
        cap_formats[format_name] += 1

    if decoded_data['type'] == 'piezo-dual':
        load_piezo_row(decoded_data, side)

    decoded_data['ts'] = record_time.strftime("%Y-%m-%d %H:%M:%S")
    data[decoded_data['type']].append(decoded_data)

    if presence_capture is not None:
        try:
            _feed_presence(presence_collector, presence_capture, int(record_time.timestamp()))
        except Exception as error:
            logger.error(error)
    return True


class _Diagnostics:
    """Per-source capacitance diagnostics, applied only for the source whose result is used."""

    def __init__(self, cap_formats, presence_collector):
        self.cap_formats = cap_formats
        self.presence_collector = presence_collector
        self.formats = Counter() if cap_formats is not None else None
        self.unknown_caps = Counter() if presence_collector is not None else None

    def __bool__(self):
        return bool(self.formats) or bool(self.unknown_caps)

    def apply(self):
        if self.formats is not None:
            self.cap_formats.update(self.formats)
        for kind, count in (self.unknown_caps or {}).items():
            for _ in range(count):
                try:
                    self.presence_collector.note_unknown_cap(kind)
                except Exception as error:
                    logger.error(error)


# Per kept record beyond its piezo arrays: the dict, nested capacitance dict and time string.
KEPT_RECORD_OVERHEAD = 1024


def _kept_size(record: dict) -> int:
    return KEPT_RECORD_OVERHEAD + sum(value.nbytes for value in record.values() if isinstance(value, np.ndarray))


def _load_nats_window(data: dict, start_time, end_time, side: Side, sensor_count: int, presence_collector,
                      diagnostics: _Diagnostics):
    """Fill data from the local JetStream history, keeping only what the RAW path keeps."""
    import nats_source
    logger.info('No RAW records in the window; trying local NATS JetStream stream raw')
    limits = nats_source.window_limits(start_time, end_time)
    rows = list(data.values())
    kept = kept_bytes = 0
    records = nats_source.iter_window_records(start_time, end_time, limits)
    try:
        for decoded_data in records:
            try:
                _ingest_record(decoded_data, data, start_time, end_time, side, sensor_count,
                               presence_collector, diagnostics.formats, unknown_caps=diagnostics.unknown_caps)
            except Exception as error:
                logger.error(error)
                continue
            total = sum(map(len, rows))
            if total == kept:
                continue
            kept = total
            # Normalization works in place, so the kept row is decoded_data itself.
            kept_bytes += _kept_size(decoded_data)
            if kept > limits.kept_records or kept_bytes > limits.kept_bytes:
                raise RuntimeError(f'NATS history kept more than {limits.kept_records} records or '
                                   f'{limits.kept_bytes} bytes; window is incomplete')
    except nats_source.NatsUnavailableError as error:
        logger.warning(str(error))
    finally:
        records.close()


def _decode_cbor_file(file_path: str, data: dict, start_time, end_time, side: Side, sensor_count: int, presence_collector=None,
                      cap_formats=None, unknown_caps=None):
    checked_timespan = False
    with open(file_path, 'rb') as raw_data:
        while True:
            start = raw_data.tell()
            end = os.fstat(raw_data.fileno()).st_size
            try:
                # Manual reader instead of cbor2.load(), the C extension
                # reads in 4096-byte chunks and skips most records (see
                # _read_raw_record docstring).
                data_bytes = _read_raw_record(raw_data)
                if data_bytes is None:
                    continue  # empty placeholder record
                records = list(plain_records(data_bytes))
            except (EOFError, ValueError, cbor2.CBORDecodeError) as error:
                # Resync at the next whole record, as the live reader does.
                next_pos = _find_next_raw_record(raw_data, start, end)
                if next_pos is None:
                    if not isinstance(error, EOFError):
                        logger.warning(f'Stopped reading {file_path} at offset {start} after a RAW decode failure: {error}')
                    break
                logger.warning(f'Skipped {next_pos - start} bytes in {file_path} at offset {start} after a RAW decode failure: {error}')
                continue
            for decoded_data in records:
                try:
                    accepted = _ingest_record(decoded_data, data, start_time, end_time, side, sensor_count,
                                              presence_collector, cap_formats, check_file_span=not checked_timespan,
                                              unknown_caps=unknown_caps)
                except Exception as error:
                    logger.error(error)
                    continue
                if accepted is False:
                    return
                if accepted is True:
                    checked_timespan = True
    gc.collect()
    return data


def _rename_keys(data: dict):
    key_mapping = {
        'log': 'logs',
        'piezo-dual': 'piezo_dual',
        'capSense': 'cap_senses',
        'frzTemp': 'freeze_temps',
        'bedTemp': 'bed_temps',
    }
    for old_key, new_key in key_mapping.items():
        if old_key in data:
            data[new_key] = data.pop(old_key)


def _debug_data(data: dict):
    for key in data:
        if isinstance(data[key], list) and len(data[key]) > 0:
            logger.info(f'{key} - {data[key][0]}')
        elif not isinstance(data[key], list):
            logger.warning(f'Unexpected type for loading raw file {type(data[key])}')


def load_raw_files(folder_path: str, start_time: datetime, end_time: datetime, side: Side, sensor_count=2, raw_data_types: List[RawDataTypes] = None,
                   presence_collector=None, cap_formats=None):
    """Decode RAW records, or local NATS history, in [start_time, end_time] for one side.

    presence_collector, when given, also receives both sides' capacitance
    channels (any format presence.sensors reads) and per-record piezo ranges
    (see presence.replay.FrameCollector), and the type of each capacitance
    record in the window that no format reads.
    It sees only the types listed in raw_data_types, so a caller that feeds
    one lists both 'capSense' and 'piezo-dual'.
    cap_formats, when given, is a Counter that receives one count per
    capacitance record loaded from the window, by format name, and one
    'unknown' per record in the window of a capacitance type no format reads.
    """
    try:
        data = {}
        if raw_data_types is None:
            raw_data_types = ['bedTemp', 'capSense', 'frzTemp', 'log', 'piezo-dual']

        for field in raw_data_types:
            data[field] = []
        logger.info(f'Loading RAW files from {folder_path} | {start_time.isoformat()} -> {end_time.isoformat()}')

        file_paths = get_current_files(folder_path)
        raw_diagnostics = _Diagnostics(cap_formats, presence_collector)

        for file_path in file_paths:
            if os.path.isfile(file_path):
                _decode_cbor_file(file_path, data, start_time, end_time, side, sensor_count, presence_collector,
                                  raw_diagnostics.formats, raw_diagnostics.unknown_caps)
            else:
                logger.warning(f'File path deleted before parsed! {file_path}')

        if any(data.values()):
            raw_diagnostics.apply()
        else:
            nats_diagnostics = _Diagnostics(cap_formats, presence_collector)
            _load_nats_window(data, start_time, end_time, side, sensor_count, presence_collector, nats_diagnostics)
            if any(data.values()):
                nats_diagnostics.apply()
                logger.info('Loaded sensor records from local NATS JetStream stream raw')
            else:
                # Diagnostics from whichever source saw the window.
                (raw_diagnostics if raw_diagnostics or not nats_diagnostics else nats_diagnostics).apply()
                if len(file_paths) == 0:
                    logger.error('No file paths detected!')
                    raise FileNotFoundError(
                        f'No RAW files found in {folder_path} and no sensor records in local NATS JetStream '
                        f'stream raw for {start_time.isoformat()} to {end_time.isoformat()}')

        _rename_keys(data)
        data_found = False
        for key in data.keys():
            if len(data[key]) > 0:
                data_found = True
            logger.debug(f"{key} - Rows found: {len(data[key])}")

        if not data_found:
            logger.warning('No data found! Mattress topper may be disconnected!')
        gc.collect()
        _debug_data(data)

        return data
    except Exception as error:
        logger.error(error)
        _debug_data(data)

        raise error
