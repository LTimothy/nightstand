#!/usr/bin/env python3
"""Prepare upstream Python without installing into or publishing /home/dac/venv.

Call with --stage and --transaction while holding the operation lock. A future
switch caller journals the original environment identity before renaming it
and publishing the prepared path. Never move this environment after creation.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import stat
import subprocess

from switch_transaction import read_regular

ENVIRONMENT_BYTES = 512 * 1024 * 1024
CACHE_BYTES = 256 * 1024 * 1024
SCRATCH_BYTES = 512 * 1024 * 1024
HEADROOM_BYTES = 64 * 1024 * 1024
REQUIREMENTS = {'numpy', 'scipy', 'pandas', 'cbor2', 'watchdog', 'sentry-sdk', 'nats-py'}
HERE = Path(__file__).resolve().parent


def current_user():
    return pwd.getpwuid(os.geteuid()).pw_name


def execute(command, user, timeout, env=None, cwd=None):
    """Bound a command and kill its descendants on timeout or interruption."""
    if user != current_user():
        if os.geteuid() != 0 or not shutil.which('runuser'):
            raise ValueError('Preparing as dac requires root and runuser')
        command = ['runuser', '-u', user, '--'] + command
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, env=env, cwd=cwd, start_new_session=True)
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except BaseException:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.communicate()
        raise
    if process.returncode:
        raise subprocess.CalledProcessError(process.returncode, command, stdout, stderr)
    return stdout


def allocated_bytes(path):
    total = 0
    for directory, _, files in os.walk(str(path), followlinks=False):
        for name in files:
            status = (Path(directory) / name).lstat()
            total += max(status.st_size, getattr(status, 'st_blocks', 0) * 512)
    return total


def space_required(original, stage):
    return (allocated_bytes(original) + allocated_bytes(stage) + ENVIRONMENT_BYTES
            + CACHE_BYTES + SCRATCH_BYTES + HEADROOM_BYTES)


def existing_parent(path):
    while not path.exists():
        path = path.parent
    return path


def owned_directory(path, user, exclusive=False):
    path.mkdir(mode=0o755, parents=True, exist_ok=not exclusive)
    if user != current_user():
        identity = pwd.getpwnam(user)
        os.chown(str(path), identity.pw_uid, identity.pw_gid)


def durable_record(path, data):
    # The destination is unpublished and exclusively created by this helper.
    temporary = path.with_name('.' + path.name + '.pending')
    with temporary.open('xb') as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    os.replace(str(temporary), str(path))
    descriptor = os.open(str(path.parent), os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def flush_environment(destination):
    """Flush prepared files without following links into the system interpreter."""
    for directory, _, files in os.walk(str(destination), topdown=False, followlinks=False):
        for name in files:
            path = Path(directory) / name
            if path.is_symlink():
                continue
            # The server user writes these trees: never block on a FIFO or follow a swapped link.
            descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                    raise ValueError('Not a regular file: ' + str(path))
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    for directory in (destination.parent, destination.parent.parent):
        descriptor = os.open(str(directory), os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def prepare(stage, env_root, transaction, original, python, user, timeout, direction='upstream'):
    stage, env_root, original = (Path(path).absolute() for path in (stage, env_root, original))
    if re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}', transaction) is None:
        raise ValueError('Invalid environment transaction identifier')
    if not stage.is_dir() or stage.is_symlink():
        raise ValueError('Missing staged upstream tree')
    if direction not in ('upstream', 'nightstand'):
        raise ValueError('Unknown environment direction')
    destination = env_root / (direction + '-' + transaction)
    if env_root.resolve() != env_root or os.path.lexists(str(destination)):
        raise ValueError('Environment path must be permanent, new, and free of symlink parents')
    for protected in (original, original.resolve(), stage.resolve()):
        if destination == protected or protected in destination.parents or destination in protected.parents:
            raise ValueError('Prepared environment overlaps the original environment or staged tree')
    requirements = stage / ('biometrics/requirements.txt' if direction == 'upstream' else 'scripts/python/requirements.txt')
    if direction == 'nightstand':
        constraints = HERE / 'python/requirements.txt'
        if requirements.is_symlink() or read_regular(requirements) != constraints.read_bytes():
            raise ValueError('Unreviewed Nightstand Python requirements')
    else:
        constraints = HERE / 'python/upstream-constraints.txt'
        lines = {line.strip().lower() for line in read_regular(requirements).decode().splitlines()
                 if line.strip() and not line.lstrip().startswith('#')}
        if requirements.is_symlink() or lines != REQUIREMENTS:
            raise ValueError('Unreviewed upstream Python requirements')
    clean_env = {key: value for key, value in os.environ.items()
                 if not key.startswith(('PIP_', 'PYTHON'))}
    clean_env.update(PYTHONDONTWRITEBYTECODE='1', PYTHONNOUSERSITE='1',
                     OPENBLAS_NUM_THREADS='1', OMP_NUM_THREADS='1')
    version = execute([python, '-I', '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'],
                      user=user, timeout=30, env=clean_env).strip()
    if version not in ('3.9', '3.10'):
        raise ValueError('Upstream environment constraints support Python 3.9 and 3.10 only')
    execute([python, '-I', '-c', 'import venv, ensurepip; print(ensurepip.version())'],
            user=user, timeout=30, env=clean_env)
    required = space_required(original, stage)
    if shutil.disk_usage(existing_parent(env_root))[2] < required:
        raise ValueError('Insufficient space for retained and upstream environments, cache, and scratch: '
                         + str(required) + ' bytes required')
    owned_directory(env_root, user)
    owned_directory(destination, user, exclusive=True)
    cache, scratch = destination / '.cache', destination / '.scratch'
    for directory in (cache, scratch):
        owned_directory(directory, user)
    clean_env.update(PIP_CONFIG_FILE='/dev/null', PIP_CACHE_DIR=str(cache),
                     PIP_DISABLE_PIP_VERSION_CHECK='1', PIP_NO_INPUT='1', TMPDIR=str(scratch))
    execute([python, '-I', '-m', 'venv', str(destination)], user=user, timeout=60, env=clean_env)
    interpreter = str(destination / 'bin/python')
    execute([interpreter, '-I', '-m', 'pip', 'install', '--only-binary=:all:',
             '--constraint', str(constraints), '-r', str(requirements)],
            user=user, timeout=timeout, env=clean_env, cwd=str(scratch))
    execute([interpreter, '-I', '-m', 'pip', 'check'], user=user, timeout=30, env=clean_env)
    validation = [interpreter, '-I', '-B', str(HERE / 'validate_upstream_imports.py'), str(stage), str(scratch)]
    if direction == 'nightstand':
        validation.append(direction)
    execute(validation,
            user=user, timeout=60, env=clean_env, cwd=str(stage / 'biometrics'))
    resolved = execute([interpreter, '-I', '-m', 'pip', 'freeze', '--all'],
                       user=user, timeout=30, env=clean_env)
    durable_record(destination / 'resolved-requirements.txt', resolved.encode())
    flush_environment(destination)
    record = dict(schemaVersion=1, transaction=transaction, path=str(destination),
                  stage=str(stage), pythonVersion=version,
                  requirementsSha256=hashlib.sha256(read_regular(requirements)).hexdigest(),
                  constraintsSha256=hashlib.sha256(constraints.read_bytes()).hexdigest(),
                  resolvedSha256=hashlib.sha256(resolved.encode()).hexdigest(), reservedBytes=required)
    durable_record(destination / 'prepared.json', (json.dumps(record, sort_keys=True) + '\n').encode())
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--transaction', required=True)
    parser.add_argument('--env-root', type=Path, default=Path('/home/dac/free-sleep-envs'))
    parser.add_argument('--original', type=Path, default=Path('/home/dac/venv'))
    parser.add_argument('--python', default='python3')
    parser.add_argument('--user', default='dac')
    parser.add_argument('--timeout', type=int, default=600)
    args = parser.parse_args()
    if args.timeout < 1:
        parser.error('Timeout must be positive')
    try:
        print(prepare(args.stage, args.env_root, args.transaction, args.original,
                      args.python, args.user, args.timeout))
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(1, 'Upstream environment preparation failed: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
