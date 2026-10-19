#!/usr/bin/env python3
"""Require sustained upstream readiness before a switch transaction can commit.

Only read-only loopback HTTP and systemd observations are used. Pass the explicit
pre-switch biometrics choice, never infer it from an inactive or failed service.
Enabled biometrics requires the launch probe's token and main-process identity.
"""
import argparse
from datetime import datetime
import json
import math
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request

from switch_transaction import read_regular
from upstream_stream_probe import process_start_ticks

WINDOW = 90
DEADLINE = 300
INTERVAL = 5
MAX_HEALTH_AGE = 75
MAX_PROGRESS_AGE = 15


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def identity(service):
    if not isinstance(service, dict) or service.get('active') is not True:
        return None
    if (any(type(service.get(key)) is not int or service[key] < (0 if key == 'restarts' else 1)
            for key in ('pid', 'start', 'restarts', 'procStartTicks'))
            or not isinstance(service.get('invocation'), str) or len(service['invocation']) != 32):
        raise ValueError('Incomplete service launch identity')
    return tuple(service[key] for key in ('pid', 'invocation', 'start', 'restarts', 'procStartTicks'))


class Readiness:
    def __init__(self, version, enabled, token):
        if type(enabled) is not bool:
            raise ValueError('Biometrics choice must be explicit')
        if enabled and not token:
            raise ValueError('Enabled biometrics requires a launch token')
        self.version, self.enabled, self.token = version, enabled, token
        self.identities = {}
        self.since = None
        self.last_sample = None
        self.counter = None
        self.last_advance = None

    def missing(self):
        self.since = None
        self.last_sample = None

    def observe(self, sample, now):
        if sample.get('enabled') is not self.enabled:
            raise ValueError('Biometrics choice changed or is unreadable')
        if sample.get('version') != self.version:
            raise ValueError('HTTP version does not match the selected upstream version')
        for name in ('server', 'stream') if self.enabled else ('server',):
            current = identity(sample.get(name))
            if name in self.identities and current != self.identities[name]:
                raise ValueError(name + ' stopped or changed launch identity')
            if current is None:
                self.missing()
                return False
            self.identities[name] = current
        if not self.enabled:
            if sample.get('stream', {}).get('active') is not False:
                raise ValueError('Explicitly disabled stream is active or unreadable')
        else:
            probe = sample.get('probe')
            if probe is None:
                self.missing()
                return False
            stream = sample['stream']
            if (probe.get('schemaVersion') != 1 or probe.get('token') != self.token
                    or probe.get('pid') != stream['pid'] or probe.get('procStartTicks') != stream['procStartTicks']):
                raise ValueError('Probe belongs to a different launch')
            counter = probe.get('successes')
            if type(counter) is not int or counter < 0 or (self.counter is not None and counter < self.counter):
                raise ValueError('Successful processing counter is invalid or regressed')
            if self.counter is None or counter > self.counter:
                self.last_advance = now
            self.counter = counter
            health = sample.get('health') or {}
            fresh = all(number(probe.get(key)) and 0 <= now - probe[key] <= limit
                        for key, limit in (('heartbeat', INTERVAL * 2), ('lastSuccess', MAX_PROGRESS_AGE)))
            valid = (fresh and counter > 0 and now - self.last_advance <= MAX_PROGRESS_AGE
                     and type(probe.get('errors')) is int and probe['errors'] == 0
                     and probe.get('fatal') is False and probe.get('workerAlive') is True
                     and number(probe.get('launched')) and 0 <= probe['launched'] <= now
                     and health.get('status') == 'healthy' and health.get('postLaunch') is True
                     and number(health.get('age')) and 0 <= health['age'] <= MAX_HEALTH_AGE)
            if not valid:
                self.missing()
                return False
        if self.last_sample is not None and now - self.last_sample > INTERVAL * 2:
            self.since = None
        self.last_sample = now
        if self.since is None:
            self.since = now
        return now - self.since >= WINDOW


def wait_ready(check, sample, clock=time.monotonic, sleep=time.sleep):
    deadline = clock() + DEADLINE
    while clock() < deadline:
        try:
            value = sample()
        except (OSError, urllib.error.URLError, subprocess.SubprocessError, json.JSONDecodeError):
            check.missing()
        else:
            observed = clock()
            if observed >= deadline:
                break
            if check.observe(value, observed):
                return
        sleep(min(INTERVAL, max(0, deadline - clock())))
    raise TimeoutError('Upstream did not demonstrate sustained readiness within five minutes')


def service_state(unit):
    properties = 'ActiveState,MainPID,InvocationID,ExecMainStartTimestampMonotonic,NRestarts'
    output = subprocess.run(['systemctl', 'show', '--property=' + properties, unit],
                            check=True, capture_output=True, text=True, timeout=5).stdout
    values = dict(line.split('=', 1) for line in output.splitlines() if '=' in line)
    pid = int(values.get('MainPID', '0'))
    return dict(active=values.get('ActiveState') == 'active', pid=pid,
                invocation=values.get('InvocationID', ''),
                start=int(values.get('ExecMainStartTimestampMonotonic', '0')),
                restarts=int(values.get('NRestarts', '0')),
                procStartTicks=process_start_ticks(pid) if pid > 0 else 0)


def http_json(route):
    with urllib.request.urlopen('http://127.0.0.1:3000/api/' + route, timeout=5) as response:
        if response.status != 200:
            raise OSError('Upstream HTTP endpoint is not ready')
        return json.load(response)


def sample_system(probe_path, enabled):
    server = service_state('free-sleep.service')
    stream = service_state('free-sleep-stream.service')
    device = http_json('deviceStatus')
    biometrics = http_json('services')['biometrics']
    probe = None
    health = None
    if enabled:
        try:
            probe = json.loads(read_regular(probe_path))
        except FileNotFoundError:
            pass
        stored = biometrics.get('jobs', {}).get('stream')
        if probe and stored:
            stamp = datetime.fromisoformat(stored['timestamp'].replace('Z', '+00:00'))
            if stamp.tzinfo is None:
                raise ValueError('Stream health timestamp lacks a timezone')
            health = dict(status=stored['status'], age=time.time() - stamp.timestamp(),
                          postLaunch=stamp.timestamp() >= probe['launchedWall'])
    if server != service_state('free-sleep.service') or stream != service_state('free-sleep-stream.service'):
        raise ValueError('Service launch changed during observation')
    return dict(version=device['freeSleep']['version'], enabled=biometrics['enabled'],
                server=server, stream=stream, probe=probe, health=health)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', required=True)
    parser.add_argument('--biometrics', choices=('enabled', 'disabled'), required=True)
    parser.add_argument('--launch-token')
    parser.add_argument('--probe', type=Path)
    args = parser.parse_args()
    try:
        enabled = args.biometrics == 'enabled'
        if enabled and args.probe is None:
            raise ValueError('Enabled biometrics requires a probe file')
        check = Readiness(args.version, enabled, args.launch_token)
        wait_ready(check, lambda: sample_system(args.probe, enabled))
        print('Upstream passed sustained readiness')
    except (OSError, ValueError, KeyError, TypeError, TimeoutError, subprocess.SubprocessError) as error:
        parser.exit(1, 'Upstream readiness failed: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
