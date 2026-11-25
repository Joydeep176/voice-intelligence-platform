"""Voice-activity detector interface (Phase 2B WS6). Interface only: no detector exists in `src`.

No VAD is selected (OD-29 Open), so nothing here implements one. A future adapter implements
`VoiceActivityDetector` and is registered with the preprocess handler under a method name; until
then the handler accepts only `vad: {method: "none"}`. The interface is framework-free: it takes
and returns NumPy arrays and knows nothing about HTTP, storage or the task machinery.

Contract of an implementation:
- input: canonical 16 kHz mono int16 blocks, in order, of any length;
- output: one boolean per 10 ms frame of the canonical timeline (frame i covers
  [10 i, 10 i + 10) ms), True = speech. A detector that produces probabilities applies its own
  threshold, so the same call sequence always yields the same booleans (determinism is part of
  the contract: segments and the config hash depend on it);
- `feed` returns the frames completed by that block (possibly none), `finish` the remaining
  frames, including a final partial frame. Over a whole stream the total is
  ceil(samples / 160) frames;
- `name` equals the method name in the config; `version` identifies the model and parameters and
  becomes part of the recorded tool versions (`<name>:<version>`).
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Protocol

import numpy as np
import numpy.typing as npt

FRAME_MS = 10
FRAME_SAMPLES = 160  # 10 ms at the canonical 16 kHz

BoolFrames = npt.NDArray[np.bool_]
Int16Block = npt.NDArray[np.int16]


class VoiceActivityDetector(Protocol):
    @property
    def name(self) -> str: ...

    @property
    def version(self) -> str: ...

    def feed(self, block: Int16Block) -> BoolFrames: ...

    def finish(self) -> BoolFrames: ...


# One fresh detector per task (a detector holds streaming state).
VadFactory = Callable[[], VoiceActivityDetector]
