"""Local contracts for the independent live reader."""
import asyncio
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import cbor2
from test_stream_helpers import stream, recent_piezo


class Timeout(asyncio.TimeoutError):
    pass


class NotFound(Exception):
    pass


def fake_client(retention='limits', fetches=None, messages=None):
    class Config:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    message = Mock(data=cbor2.dumps(recent_piezo(seq=987)))
    message.ack = AsyncMock()
    if fetches is None:
        fetches = [messages or [message], asyncio.CancelledError()]
    subscription = Mock(fetch=AsyncMock(side_effect=fetches))
    jetstream = Mock()
    jetstream.stream_info = AsyncMock(return_value=types.SimpleNamespace(
        config=types.SimpleNamespace(subjects=['raw.log', 'raw.sens.piezo'], retention=retention),
        state=types.SimpleNamespace(first_seq=1, last_seq=100)))
    jetstream.add_consumer = AsyncMock(return_value=types.SimpleNamespace(name='owned'))
    jetstream.pull_subscribe_bind = AsyncMock(return_value=subscription)
    jetstream.delete_consumer = AsyncMock()
    jetstream.consumer_info = AsyncMock()
    connection = Mock(jetstream=Mock(return_value=jetstream), close=AsyncMock())
    connect = AsyncMock(return_value=connection)
    modules = {
        'nats': types.SimpleNamespace(connect=connect),
        'nats.errors': types.SimpleNamespace(TimeoutError=Timeout),
        'nats.js.errors': types.SimpleNamespace(NotFoundError=NotFound),
        'nats.js.api': types.SimpleNamespace(ConsumerConfig=Config,
            AckPolicy=types.SimpleNamespace(NONE='none'),
            DeliverPolicy=types.SimpleNamespace(BY_START_TIME='by_start_time',
                                                BY_START_SEQUENCE='by_start_sequence'),
            RetentionPolicy=types.SimpleNamespace(LIMITS='limits')),
    }
    return modules, connect, connection, jetstream, subscription, message


def stream_message(sequence, record):
    message = Mock(data=cbor2.dumps(record))
    message.metadata.sequence.stream = sequence
    return message


def alive():
    return Mock(is_alive=Mock(return_value=True))


def write_raw(folder, *records):
    path = Path(folder) / 'a.RAW'
    path.write_bytes(b''.join(cbor2.dumps({'seq': record.get('seq', 0), 'data': cbor2.dumps(record)})
                              for record in records))
    return path


class LiveReaderTestCase(unittest.TestCase):
    def setUp(self):
        stream._drain_queue(stream.piezo_record_queue)
        stream.processed_sequences.clear()
        stream.processed_sequence_order.clear()
        self.state = patch.multiple(stream, _legacy_consumer_checked=True, _last_stream_sequence=None,
                                    _last_stream_message_at=0.0, _last_sensor_record=None)
        self.state.start()
        self.addCleanup(self.state.stop)
        self.addCleanup(stream._drain_queue, stream.piezo_record_queue)

    def run_session(self, modules, worker=None, raw_files=None):
        with patch.dict(sys.modules, modules):
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(stream._nats_session(worker or alive(), raw_files))


class TestSession(LiveReaderTestCase):
    def test_whole_stream_ephemeral_consumer_no_ack_and_cleanup(self):
        modules, connect, connection, jetstream, subscription, message = fake_client()
        with patch.object(stream, 'update_health'):
            self.run_session(modules)
        self.assertEqual(stream.piezo_record_queue.get_nowait()['seq'], 987)
        config = jetstream.add_consumer.call_args.kwargs['config']
        self.assertIsNone(getattr(config, 'durable_name', None))
        self.assertIsNone(getattr(config, 'filter_subject', None))
        self.assertEqual(config.ack_policy, 'none')
        self.assertEqual(config.deliver_policy, 'by_start_time')
        self.assertLessEqual(config.inactive_threshold, 120)
        self.assertGreater(connect.call_args.kwargs['max_reconnect_attempts'], 0)
        self.assertIs(connect.call_args.kwargs['allow_reconnect'], False)
        self.assertEqual(jetstream.pull_subscribe_bind.call_args.kwargs['consumer'], 'owned')
        self.assertLessEqual(jetstream.pull_subscribe_bind.call_args.kwargs['pending_msgs_limit'], 100)
        message.ack.assert_not_called()
        jetstream.delete_consumer.assert_awaited_once_with('raw', 'owned')
        connection.close.assert_awaited_once()

    def test_rejects_retention_that_could_remove_firmware_records(self):
        for retention in ('interest', 'workqueue'):
            with self.subTest(retention=retention):
                modules, _, connection, jetstream, _, _ = fake_client(retention)
                with patch.dict(sys.modules, modules):
                    with self.assertRaisesRegex(RuntimeError, 'retention'):
                        asyncio.run(stream._nats_session(Mock()))
                jetstream.add_consumer.assert_not_called()
                connection.close.assert_awaited_once()

    def test_bad_message_does_not_stop_later_sensor_delivery(self):
        modules, _, connection, jetstream, subscription, message = fake_client()
        subscription.fetch.side_effect = [[Mock(data=b'\xff'), message], asyncio.CancelledError()]
        with patch.object(stream, 'update_health'):
            self.run_session(modules)
        self.assertEqual(stream.piezo_record_queue.get_nowait()['seq'], 987)
        jetstream.delete_consumer.assert_awaited_once_with('raw', 'owned')
        connection.close.assert_awaited_once()

    def test_a_record_that_fails_processing_does_not_drop_the_rest_of_its_message(self):
        modules, _, _, _, subscription, _ = fake_client()
        bad = dict(recent_piezo(seq=986), left1=b'\x01\x02\x03')
        bundle = cbor2.dumps(bad) + cbor2.dumps(recent_piezo(seq=987))
        subscription.fetch.side_effect = [[Mock(data=cbor2.dumps({'seq': 1, 'data': bundle}))],
                                          asyncio.CancelledError()]
        with patch.object(stream, 'update_health'), patch.object(stream, '_record_warning_at', {}):
            self.run_session(modules)
        self.assertEqual(stream.piezo_record_queue.get_nowait()['seq'], 987)

    def test_consumer_removed_when_binding_fails(self):
        modules, _, connection, jetstream, _, _ = fake_client()
        jetstream.pull_subscribe_bind.side_effect = RuntimeError('bind failed')
        with patch.dict(sys.modules, modules):
            with self.assertRaisesRegex(RuntimeError, 'bind failed'):
                asyncio.run(stream._nats_session(Mock()))
        jetstream.delete_consumer.assert_awaited_once_with('raw', 'owned')
        connection.close.assert_awaited_once()

    def test_bare_asyncio_timeout_from_fetch_keeps_the_session(self):
        modules, _, _, jetstream, subscription, _ = fake_client(
            fetches=[asyncio.TimeoutError(), Timeout(), asyncio.CancelledError()])
        self.run_session(modules)
        self.assertEqual(subscription.fetch.await_count, 3)
        self.assertEqual(jetstream.consumer_info.await_count, 2)

    def test_bare_records_are_not_replayed_across_reconnects(self):
        first = [stream_message(41, recent_piezo()), stream_message(42, recent_piezo())]
        modules, _, _, _, _, _ = fake_client(fetches=[first, list(first), asyncio.CancelledError()])
        self.run_session(modules)
        self.assertEqual(stream.piezo_record_queue.qsize(), 2)
        self.assertEqual(stream._last_stream_sequence, 42)

        modules, _, _, jetstream, _, _ = fake_client(
            fetches=[[stream_message(42, recent_piezo()), stream_message(43, recent_piezo())],
                     asyncio.CancelledError()])
        self.run_session(modules)
        config = jetstream.add_consumer.call_args.kwargs['config']
        self.assertEqual((config.deliver_policy, config.opt_start_seq), ('by_start_sequence', 43))
        self.assertEqual(stream.piezo_record_queue.qsize(), 3)

    def test_resume_falls_back_to_start_time_when_the_sequence_is_gone(self):
        for first_seq, last_seq, age in ((50, 60, 0), (1, 10, 0), (1, 100, 3600)):
            with self.subTest(first_seq=first_seq, last_seq=last_seq, age=age):
                stream._last_stream_sequence = 42
                stream._last_stream_message_at = stream.time.monotonic() - age
                modules, _, _, jetstream, _, _ = fake_client(fetches=[asyncio.CancelledError()])
                jetstream.stream_info.return_value.state = types.SimpleNamespace(first_seq=first_seq,
                                                                                 last_seq=last_seq)
                self.run_session(modules)
                config = jetstream.add_consumer.call_args.kwargs['config']
                self.assertEqual(config.deliver_policy, 'by_start_time')
                self.assertIsNone(stream._last_stream_sequence)

    def test_earlier_durable_consumer_is_removed_once_per_process(self):
        stream._legacy_consumer_checked = False
        modules, _, _, jetstream, _, _ = fake_client(fetches=[asyncio.CancelledError()])
        jetstream.delete_consumer.side_effect = [NotFound(), None]
        self.run_session(modules)
        modules, _, _, again, _, _ = fake_client(fetches=[asyncio.CancelledError()])
        self.run_session(modules)
        self.assertEqual(jetstream.delete_consumer.await_args_list[0].args, ('raw', 'free_sleep_stream_live'))
        again.delete_consumer.assert_awaited_once_with('raw', 'owned')


class TestSilentStream(LiveReaderTestCase):
    def test_silent_stream_reads_raw_files_and_reports_healthy(self):
        with tempfile.TemporaryDirectory() as folder:
            write_raw(folder, recent_piezo(seq=31337))
            raw_files = stream._RawFiles(folder)
            modules, _, _, _, subscription, _ = fake_client(fetches=[Timeout(), Timeout(), asyncio.CancelledError()])
            with patch.object(stream, 'NATS_SILENT_SECONDS', 0), \
                    patch.object(stream, 'STREAM_HEALTH_INTERVAL_SECONDS', 0), \
                    patch.object(stream, 'update_health') as health:
                self.run_session(modules, raw_files=raw_files)
            raw_files.close()
        self.assertEqual(stream.piezo_record_queue.get_nowait()['seq'], 31337)
        self.assertEqual(health.call_args.args[:2], ('stream', 'healthy'))
        self.assertEqual(subscription.fetch.await_count, 3)
        self.assertEqual(subscription.fetch.await_args.kwargs['timeout'], stream.RAW_POLL_SECONDS)

    def test_silent_stream_with_no_raw_files_reports_failed_and_keeps_reading(self):
        with tempfile.TemporaryDirectory() as folder:
            raw_files = stream._RawFiles(folder)
            modules, _, _, _, subscription, _ = fake_client(fetches=[Timeout(), Timeout(), asyncio.CancelledError()])
            with patch.object(stream, 'NATS_SILENT_SECONDS', 0), \
                    patch.object(stream, 'STREAM_HEALTH_INTERVAL_SECONDS', 0), \
                    patch.object(stream, 'SOURCE_IDLE_SECONDS', 0), \
                    patch.object(stream, 'update_health') as health:
                self.run_session(modules, raw_files=raw_files)
        self.assertTrue(stream.piezo_record_queue.empty())
        self.assertEqual(health.call_args.args[:2], ('stream', 'failed'))
        self.assertEqual(subscription.fetch.await_count, 3)

    def test_raw_files_are_left_alone_while_nats_delivers(self):
        raw_files = Mock()
        modules, _, _, _, _, _ = fake_client(fetches=[[stream_message(5, recent_piezo())], asyncio.CancelledError()])
        self.run_session(modules, raw_files=raw_files)
        raw_files.poll.assert_not_called()


class TestHealthAndFallback(LiveReaderTestCase):
    def test_empty_and_stale_sources_fail_health_then_recover(self):
        thread = alive()
        with patch.object(stream, 'update_health') as update, patch.object(stream.time, 'monotonic', return_value=2000), \
                patch.object(stream, '_stream_started_at', 0):
            stream._report_stream_health(thread)
            self.assertEqual(update.call_args.args[1], 'failed')
            stream._ingest_live_record({'type': 'log', 'ts': stream.time.time()})
            stream._ingest_live_record(recent_piezo(ts=stream.time.time() - 3600))
            stream._report_stream_health(thread)
            self.assertEqual(update.call_args.args[1], 'failed')
            stream._ingest_live_record(recent_piezo())
            stream._report_stream_health(thread)
            self.assertEqual(update.call_args.args[1], 'healthy')

    def test_piezo_queue_discards_oldest_under_load(self):
        for seq in range(10000, 11000):
            stream._queue_decoded_piezo_record(recent_piezo(seq=seq))
        self.assertTrue(0 < stream.piezo_record_queue.qsize() <= 120)
        self.assertGreater(stream.piezo_record_queue.get_nowait()['seq'], 10000)

    def test_reconnect_backoff_stays_bounded_and_raw_fallback_runs(self):
        with tempfile.TemporaryDirectory() as folder:
            write_raw(folder, recent_piezo(seq=700000))
            handler = stream.LatestRawFileHandler(folder)
            attempts = []
            sleeps = []
            worker = alive()

            async def session(_worker, _raw_files):
                attempts.append(len(sleeps))
                if len(attempts) == 8:
                    self.assertEqual(stream.piezo_record_queue.get_nowait()['seq'], 700000)
                    raise asyncio.CancelledError()
                raise OSError('NATS down')

            async def sleep(seconds):
                sleeps.append(seconds)

            with patch.dict(sys.modules, {'nats': types.SimpleNamespace()}), \
                    patch.object(stream, '_nats_session', side_effect=session), \
                    patch.object(stream.asyncio, 'sleep', side_effect=sleep), \
                    patch.object(stream, 'LatestRawFileHandler', return_value=handler), \
                    patch.object(stream.threading, 'Thread', return_value=worker), \
                    patch.object(stream, 'update_health'), \
                    patch.object(stream.logger, 'warning') as warning:
                with self.assertRaises(asyncio.CancelledError):
                    asyncio.run(stream.watch_nats_stream())
        self.assertEqual(attempts, [0, 1, 3, 7, 15, 31, 61, 91])
        self.assertTrue(all(seconds == 1 for seconds in sleeps))
        self.assertEqual(warning.call_count, 1)
        worker.start.assert_called_once()
        self.assertTrue(handler.latest_file_obj.closed)
        self.assertTrue(stream.piezo_record_queue.empty())

    def test_stop_before_first_piezo_never_initializes_processor(self):
        stream._put_latest(None)
        with patch.object(stream, 'StreamProcessor') as processor:
            stream.process_biometrics()
        processor.assert_not_called()

    def test_empty_raw_directory_reports_failed_after_idle_window(self):
        observer = Mock()
        worker = alive()
        with tempfile.TemporaryDirectory() as folder, \
                patch.object(stream, 'Observer', return_value=observer), \
                patch.object(stream.threading, 'Thread', return_value=worker), \
                patch.object(stream.time, 'sleep', side_effect=[None, KeyboardInterrupt()]), \
                patch.object(stream.time, 'monotonic', side_effect=[0, 2000, 2000, 2000]), \
                patch.object(stream, '_stream_started_at', 0), \
                patch.object(stream, 'update_health') as health:
            stream.watch_directory(folder)
        self.assertTrue(any(call.args[:2] == ('stream', 'failed') for call in health.call_args_list))
        observer.stop.assert_called_once()
        worker.join.assert_called_once()


if __name__ == '__main__':
    unittest.main()
