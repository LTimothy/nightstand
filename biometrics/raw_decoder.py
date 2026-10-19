"""Decode every inner record without losing the RAW envelope identity."""
import io
import time

import cbor2

MAX_PAYLOAD_BYTES = 1024 * 1024


def decode_payload(payload, sequence=None, received_at=None):
    if not isinstance(payload, bytes) or len(payload) > MAX_PAYLOAD_BYTES:
        return
    received_at = time.time() if received_at is None else received_at
    handle = io.BytesIO(payload)
    decoder = cbor2.CBORDecoder(handle)
    # Every CBOR object consumes at least one byte, so payload size bounds work.
    for index in range(len(payload)):
        try:
            record = decoder.decode()
        except Exception:
            # Keep the complete prefix when the remaining inner bytes are invalid.
            break
        if isinstance(record, dict) and 'type' not in record and {'seq', 'data'} <= record.keys():
            # A whole envelope inside a payload means a wrong length swallowed the next record.
            raise ValueError('RAW envelope inside a payload')
        if isinstance(record, dict):
            record['_firmware'] = {'sequence': sequence, 'index': index, 'receivedAt': received_at}
            if sequence is not None:
                record.setdefault('seq', sequence)
            yield record


def decode_row(row, received_at=None):
    if not isinstance(row, dict):
        return
    if 'data' in row:
        yield from decode_payload(row['data'], row.get('seq'), received_at)
    else:
        record = dict(row)
        record['_firmware'] = {'sequence': row.get('seq'), 'index': 0,
                               'receivedAt': time.time() if received_at is None else received_at}
        yield record


def plain_records(payload):
    """Every record of a payload, without the envelope identity the live path keeps."""
    for record in decode_payload(payload):
        record.pop('_firmware', None)
        yield record
