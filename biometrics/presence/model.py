"""Whether this Pod is a Pod 5, read from the hub's device label as the server reads it.

A checked capacitance format counts as checked only on a Pod 5.
"""
from __future__ import annotations

import os
from dataclasses import replace
from typing import Optional, Sequence

from .sensors import CapFormat

DEVICE_LABEL_PATHS = ('/deviceinfo/device-label', '/persistent/deviceinfo/device-label')
# The lowest hub revision the server reports as a Pod 5.
POD5_HUB_REVISION = 'G43'

_unknown_logged = False


def is_pod5(paths: Sequence[str] = DEVICE_LABEL_PATHS) -> Optional[bool]:
    """True on a Pod 5 hub, False on any other, None when the label cannot be read."""
    for path in paths:
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding='utf-8') as handle:
                fields = handle.read().strip().split('-')
        except (OSError, ValueError):
            return None
        if len(fields) < 3 or not fields[2]:
            return None
        return fields[2] >= POD5_HUB_REVISION
    return None


def on_this_pod(cap_format: CapFormat, logger, paths: Sequence[str] = DEVICE_LABEL_PATHS) -> CapFormat:
    """cap_format, marked unchecked on any Pod but a Pod 5.

    When the model cannot be read, a checked format stays checked, as it
    was before the model was read at all.
    """
    global _unknown_logged
    if not cap_format.validated:
        return cap_format
    pod5 = is_pod5(paths)
    if pod5 is None:
        if not _unknown_logged:
            _unknown_logged = True
            logger.info(f'Could not read the Pod model, reading {cap_format.name} capacitance as on a Pod 5')
        return cap_format
    return cap_format if pod5 else replace(cap_format, validated=False)
