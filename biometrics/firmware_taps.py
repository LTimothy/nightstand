"""Tap and button candidates parsed from firmware records, without action dispatch."""
import re


def tap_count(value):
    return value if type(value) is int and 1 <= value <= 16 else None


def diagnostic_taps(record):
    kind = record.get('type')
    if kind == 'buttonEvent':
        events = []
        for side in ('left', 'right'):
            buttons = record.get(side)
            if not isinstance(buttons, dict):
                continue
            for control in ('top', 'bottom', 'middle'):
                count = tap_count(buttons.get(control))
                if count is not None:
                    events.append({'origin': kind, 'side': side, 'control': control, 'count': count})
        return events
    if kind == 'tap-gesture':
        count = tap_count(record.get('taps'))
        if count is not None:
            return [{'origin': kind, 'side': record.get('side') if record.get('side') in ('left', 'right') else None,
                     'count': count}]
    if kind == 'log' and isinstance(record.get('msg'), str) and len(record['msg']) <= 2048:
        match = re.search(r'\[lis(L|R)\] dismissing alarm \((\d{1,2}) taps\)', record['msg'])
        if match and tap_count(int(match.group(2))) is not None:
            return [{'origin': 'alarm-dismiss-log', 'side': 'left' if match.group(1) == 'L' else 'right',
                     'count': int(match.group(2))}]
    return []
