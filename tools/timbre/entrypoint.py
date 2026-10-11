"""Container entrypoint for a Hugging Face Job or a GPU VM.

With no arguments, the scale CLI is built from ``TIMBRE_*`` environment
variables. ``HF_TOKEN`` and the R2 credentials stay in the environment for
the libraries that read them. They are not copied onto the command line.
"""

from __future__ import annotations

import os
import sys

_FLAGS = (
    ("TIMBRE_SESSIONS", "--sessions"),
    ("TIMBRE_PURITY", "--purity"),
    ("TIMBRE_OUT", "--out"),
    ("TIMBRE_MODELS", "--models"),
    ("TIMBRE_DEVICE", "--device"),
    ("TIMBRE_WINDOW_S", "--window-s"),
    ("TIMBRE_HOP_S", "--hop-s"),
    ("TIMBRE_MIN_WINDOW_S", "--min-window-s"),
    ("TIMBRE_BATCH_SIZE", "--batch-size"),
    ("TIMBRE_SHARDS", "--shards"),
    ("TIMBRE_SHARD", "--shard"),
    ("TIMBRE_GPU_USD_PER_HOUR", "--gpu-usd-per-hour"),
    ("TIMBRE_RATES", "--rates"),
    ("TIMBRE_MIN_GROUP_N", "--min-group-n"),
    ("TIMBRE_AUDIO_PREFIXES", "--audio-prefixes"),
    ("TIMBRE_CACHE_DIR", "--cache-dir"),
)
_TRUE = {"1", "true", "yes"}


def _enabled(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in _TRUE


def argv_from_environ() -> list[str]:
    argv: list[str] = []
    for env_name, flag in _FLAGS:
        value = os.environ.get(env_name)
        if value:
            argv.extend([flag, value])
    if _enabled("TIMBRE_DRY_RUN"):
        argv.append("--dry-run")
    if _enabled("TIMBRE_RESCORE"):
        argv.append("--rescore")
    if _enabled("TIMBRE_REPORT_ONLY"):
        argv.append("--report-only")
    if not argv:
        raise SystemExit(
            "set TIMBRE_SESSIONS, TIMBRE_PURITY and TIMBRE_OUT, or pass CLI arguments"
        )
    return argv


def prepare_argv(argv: list[str] | None = None) -> list[str]:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        return argv_from_environ()
    if _enabled("TIMBRE_DRY_RUN") and "--dry-run" not in args:
        args.append("--dry-run")
    return args


def main(argv: list[str] | None = None) -> None:
    from tools.timbre.scale import main as scale_main

    scale_main(prepare_argv(argv))


if __name__ == "__main__":
    main()
