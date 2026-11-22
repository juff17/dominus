"""Reading the hub's Settings file (modules/ghostty/.../settings/, which owns
the defaults and ranges) from the Python scripts. A missing or broken file,
or a value of the wrong type or out of range, reads as the caller's default.

Each reader takes the file's path, so a script can keep its own SETTINGS
(tests point it elsewhere). The readers accept exactly what settings.mjs's
valid() accepts, so a value the Settings panel shows is the value a script
uses.
"""

import json
import math
import os
from pathlib import Path


def default_path():
    return Path(os.environ.get("AGENT_HUB_SETTINGS")
                or Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state") / "agent-hub" / "settings.json")


_MISSING = object()


def _value(path, key):
    try:
        return json.loads(Path(path).read_text()).get(key)
    except (OSError, ValueError, AttributeError):
        return _MISSING


def number(path, key, default, low, high):
    """Any finite number in [low, high], fractions included, as Node takes
    them; a bool doesn't count. A caller that needs a whole number rounds it."""
    value = _value(path, key)
    if (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and low <= value <= high):
        return value
    return default


def _same(a, b):
    # Node compares with ===, where true is never 1; Python's == says it is.
    return isinstance(a, bool) == isinstance(b, bool) and a == b


def choice(path, key, default, allowed):
    """One of `allowed`, compared as Node's === would."""
    value = _value(path, key)
    if value is _MISSING:
        return default
    return value if any(_same(value, a) for a in allowed) else default
