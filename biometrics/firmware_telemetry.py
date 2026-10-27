"""Bounded, read-only firmware telemetry delivery from the existing stream."""
import json
import math
import os
import queue
import threading
import time
import urllib.request
from uuid import uuid4
from firmware_health import classify_log
from firmware_taps import diagnostic_taps

FEATURES = ('firmwareTargetReadout', 'firmwareHealth', 'tapDiagnostics', 'coolingWarning')


def number(value, low=-40, high=100):
    try:
        return value if (isinstance(value, (int, float)) and not isinstance(value, bool)
                         and math.isfinite(value) and low <= value <= high) else None
    except (OverflowError, TypeError):
        return None


def normalize_record(record, source, received_at):
    timestamp = number(record.get('ts'), 0, 10**11)
    if timestamp is None or not 0 <= received_at - timestamp <= 60:
        return []
    metadata = record.get('_firmware') or {}
    sequence = metadata.get('sequence', record.get('seq'))
    if type(sequence) is not int or not 0 <= sequence <= 2**64 - 1:
        sequence = None
    elif sequence > 2**53 - 1:
        sequence = str(sequence)
    receipt = number(metadata.get('receivedAt', received_at), 0, 10**11)
    if receipt is None or not 0 <= received_at - receipt <= 60:
        return []
    identity = {'timestamp': timestamp, 'receivedAt': receipt, 'source': source,
                'sequence': sequence, 'index': metadata.get('index', 0)}
    records = []
    if record.get('type') == 'frzTherm':
        for side in ('left', 'right'):
            sample = record.get(side)
            if (not isinstance(sample, dict) or type(sample.get('valid')) is not bool
                    or type(sample.get('enabled')) is not bool):
                continue
            records.append({**identity, 'kind': 'thermostat', 'side': side,
                            'targetC': number(sample.get('target')), 'power': number(sample.get('power'), -100, 100),
                            'valid': sample['valid'], 'enabled': sample['enabled']})
    elif record.get('type') == 'frzTemp':
        for side in ('left', 'right'):
            raw = number(record.get(side), -4000, 10000)
            records.append({**identity, 'kind': 'water', 'side': side, 'waterC': raw / 100 if raw is not None else None})
    elif record.get('type') == 'frzHealth':
        for side in ('left', 'right'):
            sample = record.get(side)
            if not isinstance(sample, dict):
                continue
            pump = sample.get('pump') if isinstance(sample.get('pump'), dict) else {}
            temps = sample.get('temps') if isinstance(sample.get('temps'), dict) else {}
            records.append({**identity, 'kind': 'pump', 'side': side, 'rpm': number(pump.get('rpm'), 0, 20000),
                            'water': pump.get('water') is True, 'loopC': number(temps.get('flowrate'))})
    elif record.get('type') == 'log':
        event = classify_log(record.get('msg'))
        if event:
            records.append({**identity, 'kind': 'health', **event})
    elif record.get('type') in ('piezo-dual', 'capSense', 'capSense2', 'bedTemp', 'bedTemp2'):
        records.append({**identity, 'kind': 'sensor'})
    records.extend({**identity, 'kind': 'tap', **event} for event in diagnostic_taps(record))
    return records


class FirmwareDelivery:
    def __init__(self):
        self.pending = queue.Queue(maxsize=256)
        self.wake = threading.Event()
        self.session = uuid4().hex
        self.flags = {}
        self.refresh_at = 0
        self.started = False
        self.last_sensor = 0

    def refresh(self, now):
        if now < self.refresh_at:
            return
        self.refresh_at = now + 30
        try:
            from get_logger import data_folder
            with open(os.path.join(data_folder(), 'lowdb', 'settingsDB.json')) as handle:
                settings = json.load(handle)
                flags = settings.get('features', {}) if isinstance(settings, dict) else {}
                self.flags = flags if isinstance(flags, dict) else {}
        except (OSError, ValueError, TypeError):
            self.flags = {}

    def ingest(self, record, source, received_at=None):
        now = time.time() if received_at is None else received_at
        self.refresh(now)
        if not any(self.flags.get(key) is True for key in FEATURES) and not (isinstance(record, dict) and record.get('type') == 'buttonEvent'):
            return
        records = normalize_record(record, source, now)
        for sample in records:
            if sample['kind'] == 'thermostat' and not any(self.flags.get(key) is True for key in ('firmwareTargetReadout', 'coolingWarning')):
                continue
            if sample['kind'] in ('water', 'pump') and self.flags.get('coolingWarning') is not True:
                continue
            button = sample['kind'] == 'tap' and sample.get('origin') == 'buttonEvent'
            if sample['kind'] == 'tap' and not button and self.flags.get('tapDiagnostics') is not True:
                continue
            if sample['kind'] == 'health' and self.flags.get('firmwareHealth') is not True:
                continue
            if sample['kind'] == 'sensor':
                if now - self.last_sensor < 10 or self.flags.get('firmwareHealth') is not True:
                    continue
                self.last_sensor = now
            try:
                self.pending.put_nowait(sample)
            except queue.Full:
                try:
                    self.pending.get_nowait()
                except queue.Empty:
                    pass
                try:
                    self.pending.put_nowait(sample)
                except queue.Full:
                    pass
            if button or sample.get('code') in ('write-failures', 'samples-dropped'):
                self.wake.set()
        if records and not self.started:
            self.started = True
            threading.Thread(target=self.run, daemon=True, name='firmware-telemetry').start()

    def run(self):
        while True:
            self.wake.wait(30)
            self.wake.clear()
            batch = []
            for _ in range(128):
                try:
                    batch.append(self.pending.get_nowait())
                except queue.Empty:
                    break
            if not batch:
                continue
            try:
                body = json.dumps({'session': self.session, 'records': batch}, allow_nan=False).encode()
                request = urllib.request.Request('http://127.0.0.1:3000/api/services/firmware', data=body,
                                                 headers={'Content-Type': 'application/json'}, method='POST')
                # No environment proxy or redirects. Failed delivery never holds up sensor ingestion.
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
                with opener.open(request, timeout=2):
                    pass
            except Exception:
                pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, newurl):
        return None


firmware_delivery = FirmwareDelivery()
