"""Daily loading from JetStream preserves the RAW records and window."""
import asyncio
import json
import logging
import os
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

import cbor2
import numpy as np
import pytest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, '..'))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..', 'sleep_detection'))
import get_logger as gl

gl._get_file_handler = lambda *args: logging.NullHandler()
for name in gl.LOGGER_NAMES:
    gl.get_logger(name)

import load_raw_files as loader
import presence_scenarios as scenarios
from presence.cap import CapBaseline
from presence.detector import DetectorParams, SideParams
from presence.replay import FrameCollector, replay

START = datetime.fromtimestamp(scenarios.T0, timezone.utc)
END = START + timedelta(seconds=599)


EXPIRED = SimpleNamespace(headers={'Status': '408', 'Description': 'Request Timeout'}, data=b'')


class FakeJetStream:
    """A connection and JetStream context serving payloads to pull requests on one consumer."""

    def __init__(self, payloads, timestamps=None, empty_responses=0, silent_requests=0, stalled=False,
                 retention='limits', server_name=None):
        self.payloads = payloads
        self.server_name = server_name
        self.timestamps = timestamps or [START + timedelta(seconds=i // 3) for i in range(len(payloads))]
        self.empty_responses = empty_responses
        self.silent_requests = silent_requests
        self.stalled = stalled
        self.retention = retention
        self.consumer = None
        self.callback = None
        self.deleted = []
        self.offset = 0
        self.closed = False

    async def stream_info(self, stream):
        assert stream == 'raw'
        return SimpleNamespace(config=SimpleNamespace(retention=self.retention,
                               subjects=['raw.log', 'raw.sens.piezo', 'raw.sens.capsense']),
                               state=SimpleNamespace(messages=len(self.payloads), last_seq=len(self.payloads)))

    async def add_consumer(self, stream, config):
        assert stream == 'raw'
        assert config.ack_policy == 'none'
        assert config.deliver_policy == 'by_start_time'
        assert config.opt_start_time == START - timedelta(minutes=2)
        assert not getattr(config, 'durable_name', None)
        assert not getattr(config, 'filter_subject', None)
        assert config.mem_storage is True
        self.consumer = self.server_name or config.name
        self.offset = next((index for index, timestamp in enumerate(self.timestamps)
                            if timestamp >= config.opt_start_time), len(self.timestamps))
        return SimpleNamespace(name=self.consumer)

    def new_inbox(self):
        return '_INBOX.test'

    async def subscribe(self, subject, cb, **kwargs):
        assert subject == '_INBOX.test'
        self.callback = cb
        return SimpleNamespace(subject=subject)

    async def publish(self, subject, payload, reply=''):
        assert subject == f'$JS.API.CONSUMER.MSG.NEXT.raw.{self.consumer}' and reply == '_INBOX.test'
        asyncio.get_running_loop().create_task(self.deliver(json.loads(payload)['batch']))

    async def deliver(self, batch):
        if self.stalled:
            return
        if self.silent_requests:
            self.silent_requests -= 1
            return
        if self.empty_responses:
            self.empty_responses -= 1
            await self.callback(EXPIRED)
            return
        stop = min(self.offset + batch, len(self.payloads))
        for index in range(self.offset, stop):
            self.offset = index + 1
            await self.callback(SimpleNamespace(headers=None, data=self.payloads[index], subject='raw.sens.piezo',
                metadata=SimpleNamespace(sequence=SimpleNamespace(stream=index + 1, consumer=index + 1),
                    timestamp=self.timestamps[index], num_pending=len(self.payloads) - index - 1)))
        if stop - self.offset < batch:
            await self.callback(EXPIRED)

    async def consumer_info(self, stream, consumer):
        assert stream == 'raw' and consumer == self.consumer
        return SimpleNamespace(num_pending=len(self.payloads) - self.offset)

    async def delete_consumer(self, stream, consumer):
        assert stream == 'raw' and consumer == self.consumer
        self.deleted.append(consumer)

    def jetstream(self, **kwargs):
        return self

    async def close(self):
        self.closed = True


def install_nats(monkeypatch, client, connect_stalled=False):
    module = ModuleType('nats')

    async def connect(url, **kwargs):
        assert url == 'nats://127.0.0.1:4222'
        assert kwargs['allow_reconnect'] is False
        assert kwargs['max_reconnect_attempts'] == 1
        if connect_stalled:
            await asyncio.sleep(10)
        return client

    module.connect = connect
    api = ModuleType('nats.js.api')
    api.ConsumerConfig = lambda **kwargs: SimpleNamespace(**kwargs)
    api.AckPolicy = SimpleNamespace(NONE='none')
    api.DeliverPolicy = SimpleNamespace(BY_START_TIME='by_start_time')
    api.RetentionPolicy = SimpleNamespace(LIMITS='limits')
    for name, value in [('nats', module), ('nats.js', ModuleType('nats.js')), ('nats.js.api', api)]:
        monkeypatch.setitem(sys.modules, name, value)


def fixture_payloads(path, seconds=600, wrapped=True):
    night = scenarios.Night(seconds=seconds, left=((100, seconds),), right=((200, seconds),))
    scenarios.write_raw_file(str(path), scenarios.raw_records(night))
    return raw_payloads(path, wrapped)


def raw_payloads(path, wrapped=True):
    payloads = []
    with path.open('rb') as handle:
        while True:
            try:
                inner = loader._read_raw_record(handle)
            except EOFError:
                break
            payloads.append(cbor2.dumps({'seq': len(payloads), 'data': inner}) if wrapped else inner)
    return payloads


@pytest.mark.parametrize('wrapped', [False, True])
def test_fallback_matches_raw_records_presence_and_analysis(tmp_path, monkeypatch, wrapped):
    payloads = fixture_payloads(tmp_path / 'night.RAW', wrapped=wrapped)
    baselines = {side: CapBaseline(mean=scenarios.BASELINE_MEANS[side], noise=0.05) for side in ('left', 'right')}
    raw_collector, nats_collector = FrameCollector(baselines), FrameCollector(baselines)
    raw_formats, nats_formats = Counter(), Counter()
    monkeypatch.setattr(loader.logger, 'folder_path', str(tmp_path))
    raw = loader.load_raw_files(str(tmp_path), START, END, 'left', sensor_count=1,
        raw_data_types=['capSense', 'piezo-dual'], presence_collector=raw_collector, cap_formats=raw_formats)
    (tmp_path / 'night.RAW').unlink()
    client = FakeJetStream(payloads)
    install_nats(monkeypatch, client)
    loaded = loader.load_raw_files(str(tmp_path), START, END, 'left', sensor_count=1,
        raw_data_types=['capSense', 'piezo-dual'], presence_collector=nats_collector, cap_formats=nats_formats)
    assert loaded.keys() == raw.keys()
    assert loaded['cap_senses'] == raw['cap_senses']
    assert len(loaded['piezo_dual']) == len(raw['piezo_dual']) == 600
    for actual, expected in zip(loaded['piezo_dual'], raw['piezo_dual']):
        assert actual.keys() == expected.keys()
        np.testing.assert_array_equal(actual['left1'], expected['left1'])
        assert {key: value for key, value in actual.items() if key != 'left1'} == {
            key: value for key, value in expected.items() if key != 'left1'}
    assert list(nats_collector.frames()) == list(raw_collector.frames())
    assert nats_formats == raw_formats == Counter(capSense2=1200)
    params = DetectorParams(left=SideParams(enter_delta=8, exit_delta=4), right=SideParams(enter_delta=4, exit_delta=2),
                            piezo_floor={'left': 40_000, 'right': 40_000})
    expected = replay(raw_collector.frames(), params)
    assert expected['left'] and expected['right']
    assert replay(nats_collector.frames(), params) == expected
    assert client.closed and client.deleted == [client.consumer]


def test_daily_sleep_analysis_matches_raw_fixture(tmp_path, monkeypatch):
    import pandas as pd
    import sleep_detector
    from test_sleep_detector_presence import cap_payload, profiles

    path = tmp_path / 'night.RAW'
    scenarios.write_raw_file(str(path), scenarios.raw_records(scenarios.STAGGERED))
    payloads = raw_payloads(path)
    monkeypatch.setattr(loader.logger, 'folder_path', str(tmp_path))
    monkeypatch.setattr(sleep_detector, 'load_baseline', lambda side, formats: cap_payload(side))
    monkeypatch.setattr(sleep_detector, 'biometrics_v2_enabled', lambda: True)
    monkeypatch.setattr(sleep_detector.calibration, 'load_presence_profiles', lambda **kwargs: profiles())
    monkeypatch.setattr(sleep_detector.calibration, 'record_occupied_level', lambda *args, **kwargs: None)
    end = START + timedelta(seconds=scenarios.STAGGERED.seconds - 1)
    raw_frame, raw_sleep, raw_cap = sleep_detector.detect_sleep('left', START, end, str(tmp_path))
    path.unlink()
    client = FakeJetStream(payloads)
    install_nats(monkeypatch, client)
    nats_frame, nats_sleep, nats_cap = sleep_detector.detect_sleep('left', START, end, str(tmp_path))
    assert len(raw_sleep) == 1
    assert nats_sleep == raw_sleep
    pd.testing.assert_frame_equal(nats_frame, raw_frame)
    pd.testing.assert_frame_equal(nats_cap, raw_cap)
    assert sleep_detector.detect_movement('left', nats_cap) == sleep_detector.detect_movement('left', raw_cap)


def test_raw_records_prevent_nats_contact(tmp_path, monkeypatch):
    fixture_payloads(tmp_path / 'night.RAW', seconds=3)
    monkeypatch.setitem(sys.modules, 'nats', None)
    monkeypatch.setattr(loader.logger, 'folder_path', str(tmp_path))
    with patch('builtins.__import__', wraps=__import__) as imported:
        assert len(loader.load_raw_files(str(tmp_path), START, END, 'left')['piezo_dual']) == 3
    assert not any(call.args[0] == 'nats' for call in imported.call_args_list)


def test_missing_nats_keeps_file_error_with_both_sources(tmp_path, monkeypatch, caplog):
    monkeypatch.setitem(sys.modules, 'nats', None)
    monkeypatch.setattr(loader.logger, 'folder_path', str(tmp_path))
    monkeypatch.setattr(loader.logger, 'propagate', True)
    with pytest.raises(FileNotFoundError, match='RAW.*NATS'):
        loader.load_raw_files(str(tmp_path), START, END, 'left')
    assert 'nats-py is not installed' in caplog.text


def test_empty_stream_keeps_file_error(tmp_path, monkeypatch):
    client = FakeJetStream([])
    install_nats(monkeypatch, client)
    monkeypatch.setattr(loader.logger, 'folder_path', str(tmp_path))
    with pytest.raises(FileNotFoundError, match='RAW.*NATS'):
        loader.load_raw_files(str(tmp_path), START, END, 'left')
    assert client.closed and client.consumer is None


def test_files_outside_window_use_nats(tmp_path, monkeypatch):
    payloads = fixture_payloads(tmp_path / 'night.RAW', seconds=3, wrapped=False)
    scenarios.write_raw_file(str(tmp_path / 'night.RAW'), scenarios.raw_records(
        scenarios.Night(seconds=3), t0=scenarios.T0 - 3600))
    client = FakeJetStream(payloads)
    install_nats(monkeypatch, client)
    monkeypatch.setattr(loader.logger, 'folder_path', str(tmp_path))
    assert len(loader.load_raw_files(str(tmp_path), START, END, 'left')['piezo_dual']) == 3


def limits(seconds=120.0, messages=1_000_000):
    import nats_source
    return nats_source.WindowLimits(seconds=seconds, messages=messages, kept_records=10**9, kept_bytes=10**12)


def source_records(monkeypatch, payloads, **kwargs):
    import nats_source
    client = FakeJetStream(payloads, **kwargs)
    install_nats(monkeypatch, client)
    return nats_source, client


def test_record_clock_step_does_not_end_window(monkeypatch):
    records = [{'type': 'log', 'ts': scenarios.T0 + offset} for offset in (-1, 0, 600, 599, 1)]
    source, client = source_records(monkeypatch, [cbor2.dumps(record) for record in records])
    assert list(source.iter_window_records(START, END)) == [records[index] for index in (1, 3, 4)]
    assert client.closed and client.deleted


def test_stream_time_bounds_stop_before_later_messages(monkeypatch):
    record = {'type': 'log', 'ts': scenarios.T0}
    source, client = source_records(monkeypatch, [cbor2.dumps(record)] * 3,
        timestamps=[START, END + timedelta(minutes=15), END + timedelta(minutes=15, seconds=1)])
    assert len(list(source.iter_window_records(START, END))) == 2
    assert client.closed and client.deleted


def test_expired_request_with_pending_records_retries(monkeypatch):
    record = {'type': 'log', 'ts': scenarios.T0}
    source, client = source_records(monkeypatch, [cbor2.dumps(record)], empty_responses=2)
    assert list(source.iter_window_records(START, END)) == [record]
    assert client.closed and client.deleted


def test_total_timeout_cleans_up_consumer(monkeypatch):
    source, client = source_records(monkeypatch, [cbor2.dumps({'type': 'log', 'ts': scenarios.T0})], stalled=True)
    with pytest.raises(TimeoutError):
        list(source.iter_window_records(START, END, limits(seconds=0.02)))
    assert client.closed and client.deleted


def test_connection_is_included_in_total_timeout(monkeypatch):
    import nats_source
    client = FakeJetStream([])
    install_nats(monkeypatch, client, connect_stalled=True)
    with pytest.raises(TimeoutError):
        list(nats_source.iter_window_records(START, END, limits(seconds=0.02)))


def test_message_limit_rejects_partial_window(monkeypatch):
    source, client = source_records(monkeypatch, [cbor2.dumps({'type': 'log', 'ts': scenarios.T0})] * 3)
    with pytest.raises(RuntimeError, match='message limit'):
        list(source.iter_window_records(START, END, limits(messages=2)))
    assert client.closed and client.deleted


def test_kept_limits_reject_partial_window(tmp_path, monkeypatch):
    import nats_source
    payloads = fixture_payloads(tmp_path / 'night.RAW', seconds=10)
    (tmp_path / 'night.RAW').unlink()
    install_nats(monkeypatch, FakeJetStream(payloads))
    monkeypatch.setattr(loader.logger, 'folder_path', str(tmp_path))
    kept = loader.load_raw_files(str(tmp_path), START, END, 'left', sensor_count=1,
                                 raw_data_types=['capSense', 'piezo-dual'])
    rows = kept['piezo_dual'] + kept['cap_senses']
    size = sum(loader._kept_size(row) for row in rows)
    assert len(rows) == 30
    for records, size_limit in ((len(rows) - 1, size), (len(rows), size - 1)):
        client = FakeJetStream(payloads)
        install_nats(monkeypatch, client)
        monkeypatch.setattr(nats_source, 'window_limits', lambda *args: nats_source.WindowLimits(
            seconds=120.0, messages=1000, kept_records=records, kept_bytes=size_limit))
        with pytest.raises(RuntimeError, match='kept more than'):
            loader.load_raw_files(str(tmp_path), START, END, 'left', sensor_count=1,
                                  raw_data_types=['capSense', 'piezo-dual'])
        assert client.closed and client.deleted


def test_window_limits_cover_a_nightly_window_at_four_times_pod5_rates():
    import nats_source
    for hours in (6, 18, 25, 26):
        window = nats_source.window_limits(START, START + timedelta(hours=hours))
        assert window.messages >= 4 * 12_500 * hours
        assert window.kept_records >= 2 * 10_800 * hours
        # One piezo row (2,000 sample bytes) and two capacitance rows a second.
        assert window.kept_bytes >= 2 * 3600 * ((2000 + loader.KEPT_RECORD_OVERHEAD) + 2 * loader.KEPT_RECORD_OVERHEAD) * hours
        assert window.seconds >= 60 + 20 * hours
    assert nats_source.window_limits(START, START).seconds >= 60 + 20


@pytest.mark.parametrize('retention', ['interest', 'workqueue'])
def test_retention_that_could_remove_data_is_refused(monkeypatch, retention):
    source, client = source_records(monkeypatch, [cbor2.dumps({'type': 'log', 'ts': scenarios.T0})], retention=retention)
    with pytest.raises(RuntimeError, match='retention'):
        list(source.iter_window_records(START, END))
    assert client.consumer is None and client.closed


def test_malformed_records_and_placeholders_do_not_hide_valid_records(monkeypatch):
    record = {'type': 'log', 'ts': scenarios.T0}
    payloads = [b'\xff', cbor2.dumps({'seq': 0, 'data': b''}), cbor2.dumps(['not a record']),
                cbor2.dumps({'ts': 'later'}), cbor2.dumps(record)]
    source, client = source_records(monkeypatch, payloads)
    assert list(source.iter_window_records(START, END)) == [record]
    assert client.closed and client.deleted


def test_closing_iterator_early_cleans_up_consumer(monkeypatch):
    source, client = source_records(monkeypatch, [cbor2.dumps({'type': 'log', 'ts': scenarios.T0})] * 3)
    records = source.iter_window_records(START, END)
    next(records)
    records.close()
    assert client.closed and client.deleted


def test_new_publications_are_outside_the_snapshot(monkeypatch):
    record = {'type': 'log', 'ts': scenarios.T0}
    source, client = source_records(monkeypatch, [cbor2.dumps(record)])
    original_deliver = client.deliver

    async def deliver(batch):
        client.payloads.append(cbor2.dumps(record))
        client.timestamps.append(START)
        await original_deliver(batch)

    client.deliver = deliver
    assert list(source.iter_window_records(START, END)) == [record]


def test_deadline_includes_time_spent_ingesting(monkeypatch):
    import time
    source, client = source_records(monkeypatch, [cbor2.dumps({'type': 'log', 'ts': scenarios.T0})] * 3)
    records = source.iter_window_records(START, END, limits(seconds=0.01))
    next(records)
    time.sleep(0.02)
    with pytest.raises(TimeoutError):
        next(records)
    assert client.closed and client.deleted


def test_archive_records_prevent_nats_contact(tmp_path, monkeypatch):
    archive = tmp_path / 'raw-archive'
    archive.mkdir()
    fixture_payloads(archive / 'night.RAW', seconds=3)
    monkeypatch.setitem(sys.modules, 'nats', None)
    monkeypatch.setattr(loader.logger, 'folder_path', str(tmp_path))
    assert len(loader.load_raw_files(str(tmp_path), START, END, 'left')['piezo_dual']) == 3


def test_connection_failure_preserves_both_source_error(tmp_path, monkeypatch):
    client = FakeJetStream([])
    install_nats(monkeypatch, client)
    monkeypatch.setattr(loader.logger, 'folder_path', str(tmp_path))

    async def refused(*args, **kwargs):
        raise ConnectionRefusedError('not listening')

    monkeypatch.setattr(sys.modules['nats'], 'connect', refused)
    with pytest.raises(FileNotFoundError, match='RAW.*NATS'):
        loader.load_raw_files(str(tmp_path), START, END, 'left')


def test_pending_timeouts_reach_total_deadline(monkeypatch):
    source, client = source_records(monkeypatch, [cbor2.dumps({'type': 'log', 'ts': scenarios.T0})],
                                   empty_responses=1_000_000)
    with pytest.raises(TimeoutError):
        list(source.iter_window_records(START, END, limits(seconds=0.02)))
    assert client.closed and client.deleted


def test_no_delivery_with_records_pending_stalls_out(monkeypatch):
    source, client = source_records(monkeypatch, [cbor2.dumps({'type': 'log', 'ts': scenarios.T0})],
                                   empty_responses=1_000_000)
    monkeypatch.setattr(source, 'STALL_TIMEOUT', 0.0)
    with pytest.raises(TimeoutError, match='stalled'):
        list(source.iter_window_records(START, END))
    assert client.closed and client.deleted


def test_unanswered_request_is_retried(monkeypatch):
    record = {'type': 'log', 'ts': scenarios.T0}
    source, client = source_records(monkeypatch, [cbor2.dumps(record)], silent_requests=2)
    monkeypatch.setattr(source, 'REQUEST_TIMEOUT', 0.01)
    assert list(source.iter_window_records(START, END)) == [record]
    assert client.closed and client.deleted


def test_server_named_consumer_is_bound_and_deleted(monkeypatch):
    record = {'type': 'log', 'ts': scenarios.T0}
    source, client = source_records(monkeypatch, [cbor2.dumps(record)], server_name='server_chosen')
    assert list(source.iter_window_records(START, END)) == [record]
    assert client.deleted == ['server_chosen']


def test_consumer_setup_failure_cleans_up_owned_name(monkeypatch):
    source, client = source_records(monkeypatch, [cbor2.dumps({'type': 'log', 'ts': scenarios.T0})])

    async def failed(*args, **kwargs):
        raise RuntimeError('subscribe failed')

    client.subscribe = failed
    with pytest.raises(RuntimeError, match='subscribe failed'):
        list(source.iter_window_records(START, END))
    assert client.closed and client.deleted == [client.consumer]


def test_read_error_is_not_masked_by_cleanup_failure(monkeypatch):
    source, client = source_records(monkeypatch, [cbor2.dumps({'type': 'log', 'ts': scenarios.T0})] * 3)

    async def failed(*args):
        raise RuntimeError('cleanup failed')

    client.delete_consumer = failed
    with pytest.raises(RuntimeError, match='message limit'):
        list(source.iter_window_records(START, END, limits(messages=1)))
    assert client.closed


def test_client_error_cannot_silently_truncate_window(monkeypatch):
    import nats_source
    client = FakeJetStream([cbor2.dumps({'type': 'log', 'ts': scenarios.T0})])
    install_nats(monkeypatch, client)
    original_connect = sys.modules['nats'].connect
    original_deliver = client.deliver
    callbacks = []

    async def connect(url, **kwargs):
        # A failed first attempt before connecting cannot drop records.
        await kwargs['error_cb'](ConnectionRefusedError('first attempt'))
        callbacks.append(kwargs['error_cb'])
        return await original_connect(url, **kwargs)

    async def deliver(batch):
        await callbacks[0](RuntimeError('slow consumer, dropped message'))
        await original_deliver(batch)

    monkeypatch.setattr(sys.modules['nats'], 'connect', connect)
    client.deliver = deliver
    with pytest.raises(RuntimeError, match='dropped message'):
        list(nats_source.iter_window_records(START, END))
    assert client.closed


def test_start_margin_includes_exact_edge_and_excludes_older_stream_records(monkeypatch):
    records = [{'type': 'log', 'ts': scenarios.T0, 'value': value} for value in (1, 2, 3)]
    source, client = source_records(monkeypatch, [cbor2.dumps(record) for record in records],
        timestamps=[START - timedelta(minutes=2, seconds=1), START - timedelta(minutes=2), START])
    assert list(source.iter_window_records(START, END)) == records[1:]
    assert client.closed and client.deleted


def test_future_window_with_no_pending_messages_ends(monkeypatch):
    source, client = source_records(monkeypatch, [cbor2.dumps({'type': 'log', 'ts': scenarios.T0})],
                                   timestamps=[START - timedelta(hours=1)])
    assert list(source.iter_window_records(START, END)) == []
    assert client.closed and client.deleted


def test_empty_record_window_reports_both_sources(tmp_path, monkeypatch):
    record = {'type': 'log', 'ts': scenarios.T0 - 1}
    client = FakeJetStream([cbor2.dumps(record)])
    install_nats(monkeypatch, client)
    monkeypatch.setattr(loader.logger, 'folder_path', str(tmp_path))
    with pytest.raises(FileNotFoundError, match='RAW.*NATS'):
        loader.load_raw_files(str(tmp_path), START, END, 'left')
    assert client.closed and client.deleted


def test_fallback_does_not_mix_unknown_cap_counts_from_raw(tmp_path, monkeypatch):
    unknown = {'type': 'capSense3', 'ts': scenarios.T0}
    scenarios.write_raw_file(str(tmp_path / 'old.RAW'), [unknown])
    payloads = [cbor2.dumps(unknown)] + [cbor2.dumps(record) for record in scenarios.raw_records(scenarios.Night(seconds=1))]
    client = FakeJetStream(payloads)
    install_nats(monkeypatch, client)
    monkeypatch.setattr(loader.logger, 'folder_path', str(tmp_path))
    baselines = {side: CapBaseline(mean=scenarios.BASELINE_MEANS[side], noise=0.05) for side in ('left', 'right')}
    collector, formats = FrameCollector(baselines), Counter()
    loaded = loader.load_raw_files(str(tmp_path), START, END, 'left', sensor_count=1,
        raw_data_types=['capSense', 'piezo-dual'], presence_collector=collector, cap_formats=formats)
    assert len(loaded['piezo_dual']) == 1
    assert formats == Counter(capSense2=2, unknown=1)
    assert collector.unknown_cap == Counter(capSense3=1)


def _outside_window_raw(tmp_path):
    """RAW files that exist but hold only unknown capacitance records for the window."""
    scenarios.write_raw_file(str(tmp_path / 'a_unknown.RAW'),
                             [{'type': 'capSense3', 'ts': scenarios.T0 + second} for second in range(3)])
    scenarios.write_raw_file(str(tmp_path / 'b_earlier.RAW'), scenarios.raw_records(
        scenarios.Night(seconds=5, left=((0, 5),)), t0=scenarios.T0 - 3600))


def _load_with(load, tmp_path):
    baselines = {side: CapBaseline(mean=scenarios.BASELINE_MEANS[side], noise=0.05) for side in ('left', 'right')}
    collector, formats = FrameCollector(baselines), Counter()
    data = load(str(tmp_path), START, END, 'left', sensor_count=1, raw_data_types=['capSense', 'piezo-dual'],
                presence_collector=collector, cap_formats=formats)
    return data, formats, collector.unknown_cap, list(collector.frames())


@pytest.mark.parametrize('nats_state', ['missing', 'no_server', 'empty_window'])
def test_raw_files_with_empty_window_match_the_loader_before_nats(tmp_path, monkeypatch, nats_state):
    import loader_before_nats
    _outside_window_raw(tmp_path)
    monkeypatch.setattr(loader.logger, 'folder_path', str(tmp_path))
    expected = _load_with(loader_before_nats.load_raw_files, tmp_path)
    assert expected[0] == {'cap_senses': [], 'piezo_dual': []}
    assert expected[1] == Counter(unknown=3) and expected[2] == Counter(capSense3=3)
    client = FakeJetStream([cbor2.dumps({'type': 'log', 'ts': scenarios.T0 - 600})])
    if nats_state == 'missing':
        monkeypatch.setitem(sys.modules, 'nats', None)
    else:
        install_nats(monkeypatch, client)
    if nats_state == 'no_server':
        async def refused(*args, **kwargs):
            raise ConnectionRefusedError('not listening')
        monkeypatch.setattr(sys.modules['nats'], 'connect', refused)
    assert _load_with(loader.load_raw_files, tmp_path) == expected
    if nats_state == 'empty_window':
        assert client.closed and client.deleted


def test_raw_unknown_counts_win_over_empty_nats_window(tmp_path, monkeypatch):
    _outside_window_raw(tmp_path)
    install_nats(monkeypatch, FakeJetStream([cbor2.dumps({'type': 'capSense3', 'ts': scenarios.T0})]))
    monkeypatch.setattr(loader.logger, 'folder_path', str(tmp_path))
    _, formats, unknown, _ = _load_with(loader.load_raw_files, tmp_path)
    assert formats == Counter(unknown=3) and unknown == Counter(capSense3=3)


def test_nats_unknown_counts_kept_when_only_nats_saw_the_window(tmp_path, monkeypatch):
    install_nats(monkeypatch, FakeJetStream([cbor2.dumps({'type': 'capSense3', 'ts': scenarios.T0})]))
    monkeypatch.setattr(loader.logger, 'folder_path', str(tmp_path))
    formats = Counter()
    with pytest.raises(FileNotFoundError, match='RAW.*NATS'):
        loader.load_raw_files(str(tmp_path), START, END, 'left', sensor_count=1,
                              raw_data_types=['capSense', 'piezo-dual'], cap_formats=formats)
    assert formats == Counter(unknown=1)


def test_bundled_payload_keeps_every_record(monkeypatch):
    first = {'type': 'log', 'ts': scenarios.T0}
    second = {'type': 'log', 'ts': scenarios.T0 + 1}
    payload = cbor2.dumps(first) + cbor2.dumps(second)
    source, client = source_records(monkeypatch, [payload, cbor2.dumps({'seq': 1, 'data': payload})])
    assert list(source.iter_window_records(START, END)) == [first, second, first, second]
    assert client.closed and client.deleted
