"""Whether this Pod is a Pod 5, read from the hub's device label as the server reads it.

A checked capacitance format counts as checked only on a Pod 5.
"""
from __future__ import annotations

import os
import re
from dataclasses import replace
from typing import Optional, Sequence

from .sensors import CapFormat

DEVICE_LABEL_PATHS = ('/deviceinfo/device-label', '/persistent/deviceinfo/device-label')
# Pod 5 hubs have reported G43, G45 and G55. A hub at I00 or later is a
# generation not checked yet, so it is unknown rather than a Pod 5.
POD5_HUB_REVISION = 'G43'
POD5_HUB_REVISION_END = 'I00'
_REVISION = re.compile(r'[A-Z][0-9]{2}')

_unknown_logged = False


def hub_revision(paths: Sequence[str] = DEVICE_LABEL_PATHS) -> Optional[str]:
    """The third field of the first device label found, or None when it cannot be read."""
    for path in paths:
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding='utf-8') as handle:
                fields = handle.read().strip().split('-')
        except (OSError, ValueError):
            return None
        return fields[2] if len(fields) >= 3 and fields[2] else None
    return None


def out_of_range(revision: Optional[str]) -> bool:
    """True for a well formed revision past the range checked so far."""
    return revision is not None and bool(_REVISION.fullmatch(revision)) and revision >= POD5_HUB_REVISION_END


def is_pod5(paths: Sequence[str] = DEVICE_LABEL_PATHS) -> Optional[bool]:
    """True on a Pod 5 hub, False on any other, None when the revision is unreadable, malformed or unchecked."""
    revision = hub_revision(paths)
    if revision is None or not _REVISION.fullmatch(revision) or out_of_range(revision):
        return None
    return revision >= POD5_HUB_REVISION


def on_this_pod(cap_format: CapFormat, logger, paths: Sequence[str] = DEVICE_LABEL_PATHS) -> CapFormat:
    """cap_format, marked unchecked on any Pod but a Pod 5.

    When the model cannot be read, a checked format stays checked, as it
    was before the model was read at all. A hub past the range checked so
    far is unchecked, like any other Pod but a Pod 5.
    """
    global _unknown_logged
    if not cap_format.validated:
        return cap_format
    pod5 = is_pod5(paths)
    if pod5 is None:
        revision = hub_revision(paths)
        if out_of_range(revision):
            if not _unknown_logged:
                _unknown_logged = True
                logger.info(f'Hub revision {revision} is outside the range checked so far, '
                            f'reading {cap_format.name} capacitance as unchecked')
            return replace(cap_format, validated=False)
        if not _unknown_logged:
            _unknown_logged = True
            logger.info(f'Could not read the Pod model, reading {cap_format.name} capacitance as on a Pod 5')
        return cap_format
    return cap_format if pod5 else replace(cap_format, validated=False)
