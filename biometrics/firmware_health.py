"""Allowlisted firmware messages. Firmware severity and free text stay local."""
import math
import re

SIDES = {'left': 'left', 'right': 'right', 'L': 'left', 'R': 'right'}


def classify_log(message):
    if not isinstance(message, str) or len(message) > 2048:
        return None
    # Prefixes name firmware modules and vary between builds.
    result = {'side': None, 'details': {}}
    condensation = re.search(r'\[condensation\] temp:\s*(-?[\d.]+),?\s+humidity:\s*([\d.]+),?\s+dew point:\s*(-?[\d.]+)', message)
    if condensation:
        try:
            values = [float(value) for value in condensation.groups()]
            if not all(math.isfinite(value) for value in values):
                return None
            if not (-40 <= values[0] <= 100 and 0 <= values[1] <= 100 and -40 <= values[2] <= 100):
                return None
            return {**result, 'code': 'moisture', 'details': dict(zip(('temperatureC', 'humidity', 'dewPointC'), values))}
        except ValueError:
            return None
    for pattern, code in (
        (r'tec\[(left|right)\] locked \(pump\)', 'pump-interlock'),
        (r'pump\[(left|right)\] (?:slow|fast|default)(?:\s|$)', 'pump-running'),
        (r'pump\[(left|right)\] off(?:\s|$)', 'pump-stopped'),
        (r'\[cap_sampling(L|R)\] status .*->too low(?:\s|$)', 'presence-low'),
        (r'\[sensor\] starting (left|right) reset(?:\s|$)', 'sensor-reset'),
    ):
        match = re.search(pattern, message)
        if match:
            return {**result, 'code': code, 'side': SIDES[match.group(1)]}
    match = re.search(r'\[i2c(\d{1,2})\] timed out req(?:\s|$)', message)
    if match:
        return {**result, 'code': 'bus-timeout', 'details': {'bus': int(match.group(1))}}
    match = re.search(r'failed to find USB device on port:\s*(\d{1,2}-\d{1,2}(?:\.\d{1,2}){0,3})(?:\s|$)', message)
    if match:
        return {**result, 'code': 'device-missing', 'details': {'port': match.group(1)}}
    if '[capwater]' in message:
        match = re.search(r'\[capwater\] Raw:\s*(-?\d+(?:\.\d+)?),\s*Capwater (not calibrated|calibrated)(?:\.|\s|$)', message)
        if not match:
            return None
        raw = float(match.group(1))
        calibrated = match.group(2) == 'calibrated'
        if not math.isfinite(raw) or not -100 <= raw <= 100:
            return None
        details = {'raw': raw, 'calibrated': calibrated}
        limits = re.search(r'Empty:\s*(-?\d+(?:\.\d+)?),\s*Full:\s*(-?\d+(?:\.\d+)?)', message)
        if limits:
            empty, full = map(float, limits.groups())
            if not all(math.isfinite(value) and -100 <= value <= 100 for value in (empty, full)):
                return None
            details.update(empty=empty, full=full)
        return {**result, 'code': 'water-calibrated' if calibrated else 'water-calibration', 'details': details}
    if re.search(r'\bCapwater not calibrated\b', message):
        return {**result, 'code': 'water-calibration'}
    match = re.search(r'\bFS_WRITE_FAIL:\s*(\d{1,15})(?:\s|$)', message)
    if match:
        return {**result, 'code': 'write-failures', 'value': int(match.group(1))}
    if re.search(r'\bstarted throttling .*\[disabled\]', message):
        return {**result, 'code': 'throttling-disabled'}
    return None
