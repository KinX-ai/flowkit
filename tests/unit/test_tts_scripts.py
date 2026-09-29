"""The inline TTS scripts must save what OmniVoice.generate() actually returns.

OmniVoice >= 0.2 returns ``list[numpy.ndarray]`` (1-D float32 per item).
``torchaudio.save`` wants a 2-D ``(channels, samples)`` tensor, so handing it
``audio[0]`` raw fails with ``Expected 2D Tensor, got 1D`` — every TTS call
died at the very last step, after the model had generated fine.

These tests exec the script templates against a fake ``omnivoice`` module so
they run without torch/omnivoice installed in the agent venv.
"""
import json
import sys
import types

import pytest

np = pytest.importorskip("numpy")

from agent.services import tts as tts_mod  # noqa: E402


class _FakeTorchaudio:
    saved = []

    class info:  # noqa: N801 — mimics torchaudio.info(path)
        def __init__(self, path):
            self.num_frames = 24000
            self.sample_rate = 24000

    @classmethod
    def save(cls, path, tensor, sample_rate):
        if getattr(tensor, "ndim", None) != 2:
            raise ValueError(f"Expected 2D Tensor, got {tensor.ndim}D.")
        cls.saved.append((path, tuple(tensor.shape), sample_rate))


class _FakeOmniVoice:
    kwargs_seen = {}

    @classmethod
    def from_pretrained(cls, model, **kwargs):
        cls.kwargs_seen = kwargs
        return cls()

    def generate(self, **kwargs):
        return [np.zeros(2400, dtype=np.float32)]


@pytest.fixture
def fake_modules(monkeypatch):
    torch = pytest.importorskip("torch")
    _FakeTorchaudio.saved = []
    monkeypatch.setitem(sys.modules, "torchaudio", _FakeTorchaudio)
    ov = types.ModuleType("omnivoice")
    ov.OmniVoice = _FakeOmniVoice
    monkeypatch.setitem(sys.modules, "omnivoice", ov)
    return torch


def _run(script: str, args: dict, capsys):
    sys.argv = ["tts", json.dumps(args)]
    exec(compile(script, "<tts-script>", "exec"), {"__name__": "__main__"})
    return json.loads(capsys.readouterr().out.strip().splitlines()[-1])


def test_single_script_saves_1d_numpy_output_as_2d(fake_modules, tmp_path, capsys):
    out = tmp_path / "a.wav"
    result = _run(tts_mod._TTS_SCRIPT, {
        "model": "m", "text": "xin chào", "output": str(out), "sample_rate": 24000,
    }, capsys)
    assert result["ok"] is True
    assert _FakeTorchaudio.saved == [(str(out), (1, 2400), 24000)]


def test_batch_script_saves_1d_numpy_output_as_2d(fake_modules, tmp_path, capsys):
    out = tmp_path / "s" / "b.wav"
    results = _run(tts_mod._TTS_BATCH_SCRIPT, {
        "model": "m", "sample_rate": 24000,
        "items": [{"id": "s1", "text": "xin chào", "output": str(out)}],
    }, capsys)
    assert results == [{"id": "s1", "ok": True, "path": str(out), "duration": 1.0}]
    assert _FakeTorchaudio.saved == [(str(out), (1, 2400), 24000)]


def test_scripts_honour_device_arg(fake_modules, tmp_path, capsys):
    _run(tts_mod._TTS_SCRIPT, {
        "model": "m", "text": "x", "output": str(tmp_path / "a.wav"),
        "sample_rate": 24000, "device": "cuda",
    }, capsys)
    assert _FakeOmniVoice.kwargs_seen["device_map"] == "cuda"


def test_generate_speech_passes_configured_device(monkeypatch, tmp_path):
    captured = {}
    monkeypatch.setattr(tts_mod, "TTS_DEVICE", "cuda")
    monkeypatch.setattr(tts_mod, "_run_tts_subprocess",
                        lambda args: captured.update(args) or {"ok": True})
    import asyncio
    asyncio.run(tts_mod.generate_speech("hi", str(tmp_path / "o.wav")))
    assert captured["device"] == "cuda"
