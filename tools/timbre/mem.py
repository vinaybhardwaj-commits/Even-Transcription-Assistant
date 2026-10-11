"""RAM gate so a too-large checkpoint is refused before the OOM killer."""

from __future__ import annotations


class InsufficientMemory(RuntimeError):
    def __init__(self, model: str, need_gb: float, have_gb: float):
        self.model = model
        self.need_gb = need_gb
        self.have_gb = have_gb
        super().__init__(
            f"{model}: need about {need_gb:.1f} GB available RAM, have {have_gb:.1f} GB"
        )


def mem_available_gb() -> float:
    try:
        with open("/proc/meminfo", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    kb = int(line.split()[1])
                    return kb / (1024.0 * 1024.0)
    except OSError:
        return 0.0
    return 0.0


def require_ram(model: str, need_gb: float) -> float:
    have = mem_available_gb()
    if have < need_gb:
        raise InsufficientMemory(model, need_gb, have)
    return have
