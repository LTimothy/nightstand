"""Bounded, independent reads of the firmware's local JetStream history."""
import asyncio
import json
import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import cbor2
from get_logger import get_logger
from raw_decoder import plain_records
import vendored  # noqa: F401

logger = get_logger()

NATS_URL = 'nats://127.0.0.1:4222'
STREAM = 'raw'
START_MARGIN = timedelta(minutes=2)
# Records can be published later than their own time; one RAW file spans 15 minutes.
END_MARGIN = timedelta(minutes=15)
CONNECT_TIMEOUT = 2.0
# Connecting and reading the stream info together; past this the source counts as unavailable.
SETUP_TIMEOUT = 5.0
REQUEST_TIMEOUT = 2.0
# Records are pending but none has arrived for this long.
STALL_TIMEOUT = 30.0
BATCH_SIZE = 256

# Per hour of window, counted as at least one hour. A Pod 5 publishes about 12,500
# messages an hour; the loader keeps about 10,800 of them (one piezo and two
# capacitance records a second), about 18 MB by its own estimate. Messages get
# four times that, kept records and bytes about twice, so only a broken stream trips them.
BASE_SECONDS = 60.0
SECONDS_PER_HOUR = 20.0
MESSAGES_PER_HOUR = 50_000
KEPT_RECORDS_PER_HOUR = 21_600
KEPT_BYTES_PER_HOUR = 40 * 1024 * 1024


class NatsUnavailableError(Exception):
    """The optional client or firmware history source is unavailable."""


@dataclass(frozen=True)
class WindowLimits:
    seconds: float
    messages: int
    kept_records: int
    kept_bytes: int


def window_limits(start_time, end_time):
    hours = max((end_time - start_time + START_MARGIN + END_MARGIN).total_seconds() / 3600, 1.0)
    return WindowLimits(
        seconds=BASE_SECONDS + SECONDS_PER_HOUR * hours,
        messages=math.ceil(MESSAGES_PER_HOUR * hours),
        kept_records=math.ceil(KEPT_RECORDS_PER_HOUR * hours),
        kept_bytes=math.ceil(KEPT_BYTES_PER_HOUR * hours),
    )


def _payload_records(payload):
    row = cbor2.loads(payload)
    return plain_records(row['data'] if isinstance(row, dict) and 'data' in row else payload)


async def _connect(nats, note_error):
    # max_reconnect_attempts=0 retries forever in nats-py; 1 with no wait gives two quick attempts.
    connection = await nats.connect(NATS_URL, connect_timeout=CONNECT_TIMEOUT, allow_reconnect=False,
                                    max_reconnect_attempts=1, reconnect_time_wait=0, error_cb=note_error)
    try:
        jetstream = connection.jetstream(timeout=REQUEST_TIMEOUT)
        info = await jetstream.stream_info(STREAM)
    except BaseException:
        try:
            await asyncio.wait_for(connection.close(), REQUEST_TIMEOUT)
        except Exception:
            pass
        raise
    return connection, jetstream, info


async def _window_records(start_time, end_time, message_limit, deadline):
    try:
        import nats
        from nats.js.api import AckPolicy, ConsumerConfig, DeliverPolicy, RetentionPolicy
    except ImportError as error:
        raise NatsUnavailableError('nats-py is not installed; NATS history is unavailable') from error

    connection = None
    jetstream = None
    consumer_name = None
    client_error = None

    async def note_error(error):
        nonlocal client_error
        if client_error is None:
            client_error = error

    def check_client_error():
        if client_error is not None:
            raise RuntimeError(f'NATS history client error; window is incomplete: {client_error}') from client_error

    try:
        try:
            connection, jetstream, info = await asyncio.wait_for(_connect(nats, note_error), SETUP_TIMEOUT)
        except Exception as error:
            raise NatsUnavailableError(f'NATS stream {STREAM} is unavailable: {error!r}') from error
        # A refused first attempt is reported here too; only errors after connecting can drop records.
        client_error = None
        # Delivering with no acknowledgments must not remove firmware records.
        if info.config.retention != RetentionPolicy.LIMITS:
            raise RuntimeError('NATS raw stream retention must be limits for a read-only history consumer')
        if not info.state.messages:
            return
        last_sequence = info.state.last_seq
        created = await jetstream.add_consumer(STREAM, config=ConsumerConfig(
            name='nightstand_window_' + uuid4().hex,
            deliver_policy=DeliverPolicy.BY_START_TIME,
            opt_start_time=start_time - START_MARGIN,
            ack_policy=AckPolicy.NONE,
            inactive_threshold=60.0,
            mem_storage=True,
        ))
        # Older servers name the consumer themselves.
        consumer_name = created.name
        # Pull by hand: nats-py's fetch waits on each message separately, about four times slower.
        batch = []
        ended = asyncio.Event()
        status = None

        async def receive(message):
            nonlocal status
            code = message.headers.get('Status') if message.headers else None
            if code == '100':
                return
            if code:
                status = f"{code} {message.headers.get('Description', '')}".strip()
                ended.set()
            else:
                batch.append(message)
                if len(batch) >= BATCH_SIZE or message.metadata.sequence.stream >= last_sequence:
                    ended.set()

        inbox = connection.new_inbox()
        await connection.subscribe(inbox, cb=receive, pending_msgs_limit=BATCH_SIZE * 2,
                                   pending_bytes_limit=16 * 1024 * 1024)
        next_subject = f'$JS.API.CONSUMER.MSG.NEXT.{STREAM}.{consumer_name}'
        request = json.dumps({'batch': BATCH_SIZE, 'expires': int(REQUEST_TIMEOUT * 1e9)}).encode()
        loop = asyncio.get_running_loop()
        last_delivery = loop.time()
        count = seen_sequence = 0
        while True:
            # Python 3.9's wait_for can swallow the caller's cancel, so the deadline is checked here too.
            if loop.time() >= deadline:
                raise TimeoutError('NATS history total timeout; window is incomplete')
            check_client_error()
            batch = []
            status = None
            ended.clear()
            await connection.publish(next_subject, request, reply=inbox)
            try:
                await asyncio.wait_for(ended.wait(), min(2 * REQUEST_TIMEOUT, max(deadline - loop.time(), 0.0)))
            except asyncio.TimeoutError:
                pass
            check_client_error()
            messages = batch
            # 404 and 408 end a request early, 409 is a temporary conflict; anything else is a failure.
            if status is not None and status[:3] not in ('404', '408', '409'):
                raise RuntimeError(f'NATS history request failed: {status}; window is incomplete')
            if not messages:
                pending = await jetstream.consumer_info(STREAM, consumer_name)
                check_client_error()
                if pending.num_pending == 0:
                    return
                if loop.time() - last_delivery > STALL_TIMEOUT:
                    raise TimeoutError('NATS history stalled with records pending; window is incomplete')
                continue
            last_delivery = loop.time()
            for message in messages:
                metadata = message.metadata
                sequence = metadata.sequence.stream
                if sequence > last_sequence or metadata.timestamp > end_time + END_MARGIN:
                    return
                if sequence <= seen_sequence:
                    continue
                seen_sequence = sequence
                count += 1
                if count > message_limit:
                    raise RuntimeError(f'NATS history message limit exceeded ({message_limit}); window is incomplete')
                try:
                    records = list(_payload_records(message.data))
                except (cbor2.CBORDecodeError, ValueError, TypeError):
                    records = []
                for record in records:
                    try:
                        in_window = start_time <= datetime.fromtimestamp(record['ts'], timezone.utc) <= end_time
                    except (KeyError, TypeError, ValueError, OverflowError, OSError):
                        in_window = False
                    if in_window:
                        yield record
                if metadata.num_pending == 0 or sequence == last_sequence:
                    return
    finally:
        try:
            if jetstream is not None and consumer_name is not None:
                # Only this run's consumer is deleted. Inactivity also expires it after a killed job.
                await asyncio.wait_for(jetstream.delete_consumer(STREAM, consumer_name), REQUEST_TIMEOUT)
        except Exception as error:
            logger.warning(f'Could not remove NATS history consumer {consumer_name}: {error}')
        finally:
            if connection is not None:
                try:
                    await asyncio.wait_for(connection.close(), REQUEST_TIMEOUT)
                except Exception as error:
                    logger.warning(f'Could not close NATS history connection: {error}')


async def _next_batch(records):
    batch = []
    for _ in range(BATCH_SIZE):
        try:
            batch.append(await records.__anext__())
        except StopAsyncIteration:
            break
    return batch


def _close_loop(loop, records):
    try:
        loop.run_until_complete(records.aclose())
    finally:
        try:
            # Client tasks left by a close that timed out.
            tasks = asyncio.all_tasks(loop)
            for task in tasks:
                task.cancel()
            if tasks:
                loop.run_until_complete(asyncio.gather(*tasks, return_exceptions=True))
            loop.run_until_complete(loop.shutdown_asyncgens())
        finally:
            loop.close()


def iter_window_records(start_time, end_time, limits=None):
    """Yield decoded records in stream order, with inclusive record-time bounds.

    One batch is held at a time. The deadline includes connection, requests
    and the caller's processing; cleanup can take up to four more seconds.
    Limits fail the job instead of returning a successful partial window.
    """
    if start_time.tzinfo is None or end_time.tzinfo is None or start_time > end_time:
        raise ValueError('NATS history needs an ordered window with timezone-aware bounds')
    limits = limits or window_limits(start_time, end_time)
    if limits.seconds <= 0 or limits.messages <= 0:
        raise ValueError('NATS history limits must be positive')
    loop = asyncio.new_event_loop()
    deadline = loop.time() + limits.seconds
    records = _window_records(start_time, end_time, limits.messages, deadline)
    try:
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise TimeoutError('NATS history total timeout; window is incomplete')
            try:
                batch = loop.run_until_complete(asyncio.wait_for(_next_batch(records), remaining))
            except asyncio.TimeoutError as error:
                if loop.time() < deadline:
                    raise
                raise TimeoutError('NATS history total timeout; window is incomplete') from error
            if not batch:
                return
            for record in batch:
                if loop.time() >= deadline:
                    raise TimeoutError('NATS history total timeout; window is incomplete')
                yield record
    finally:
        _close_loop(loop, records)
