#!/usr/bin/env python3
"""Records how an update, rollback or switch ended, for the app to show."""
import binascii
import json
import os
import sys
import tempfile
import time


def main(argv):
    path, operation, outcome, from_version, to_version, message = argv[1:7]
    record = {
        "runId": binascii.hexlify(os.urandom(4)).decode(),
        "operation": operation,
        "outcome": outcome,
        "from": from_version or None,
        "to": to_version or None,
        "message": message[:300],
        "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    # mkstemp never follows a link the server user left in its folder.
    descriptor, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".",
                                       prefix=os.path.basename(path) + ".")
    try:
        with os.fdopen(descriptor, "w") as handle:
            json.dump(record, handle)
            handle.flush()
            os.fsync(handle.fileno())
            os.fchmod(handle.fileno(), 0o644)
        os.replace(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise


if __name__ == "__main__":
    main(sys.argv)
