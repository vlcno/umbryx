"""Builds the incoming-call sound options into downloads/ringtones as plain WAV files.

Everything is synthesised here from sine, triangle and square waves, so there is nothing to download and
nothing borrowed from another app. Each file holds the ring twice, the way it repeats while a call rings.
"""
import sys
import wave
from pathlib import Path

import numpy as np

SR = 44100
TAU = 2 * np.pi
NOTES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def hz(note):
    """'A4' -> 440.0, 'C#5' -> 554.4"""
    name, octave = note[:-1], int(note[-1])
    semitone = NOTES[name[0]] + (1 if name.endswith("#") else 0)
    return 440.0 * 2 ** ((semitone - 9) / 12 + (octave - 4))


def clock(seconds):
    return np.arange(int(SR * seconds)) / SR


def shape(n, attack=0.004, release=0.04):
    """A short fade in and out, so no note starts or stops with a click."""
    e = np.ones(n)
    a = max(1, min(n, int(SR * attack)))
    r = max(1, min(n, int(SR * release)))
    e[:a] = np.linspace(0, 1, a)
    e[-r:] *= np.linspace(1, 0, r)
    return e


def place(buf, sound, at, gain=1.0):
    start = int(SR * at)
    end = min(len(buf), start + len(sound))
    if end > start:
        buf[start:end] += sound[:end - start] * gain


def echo(x, delay, feedback=0.4, mix=0.28, repeats=4):
    out = x.copy()
    step = int(SR * delay)
    for k in range(1, repeats + 1):
        if k * step >= len(x):
            break
        out[k * step:] += x[:len(x) - k * step] * mix * feedback ** (k - 1)
    return out


def lowpass(x, cutoff):
    spectrum = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(len(x), 1 / SR)
    return np.fft.irfft(spectrum / np.sqrt(1 + (freqs / cutoff) ** 4), len(x))


# --- the rings: each returns one cycle, silence included ---------------------------------------------

def classic():
    """An old desk phone: two bells struck in turn, ring-ring, pause."""
    buf = np.zeros(int(SR * 3.0))

    def burst(length):
        out = np.zeros(int(SR * (length + 0.4)))
        strikes = int(length * 44)
        for k in range(strikes):
            f = 1320.0 if k % 2 == 0 else 1660.0
            x = clock(0.32)
            ding = (np.sin(TAU * f * x) + 0.45 * np.sin(TAU * 2.76 * f * x) + 0.18 * np.sin(TAU * 5.4 * f * x)) * np.exp(-x / 0.06)
            place(out, ding * shape(len(x), 0.001, 0.02), k / 44, 0.5)
        return out

    place(buf, burst(0.42), 0.0)
    place(buf, burst(0.42), 0.62)
    return buf


def marimba():
    """Soft wooden mallets running up a chord."""
    buf = np.zeros(int(SR * 2.7))

    def note(f, length=0.7):
        x = clock(length)
        s = (np.sin(TAU * f * x) * np.exp(-x / 0.17)
             + 0.34 * np.sin(TAU * 4 * f * x) * np.exp(-x / 0.035)
             + 0.10 * np.sin(TAU * 10 * f * x) * np.exp(-x / 0.012))
        return s * shape(len(x), 0.002, 0.06)

    for at, name in [(0.00, "C5"), (0.15, "E5"), (0.30, "G5"), (0.45, "C6"), (0.78, "G5"), (0.93, "C6"), (1.08, "E6")]:
        place(buf, note(hz(name)), at)
    return echo(buf, 0.3, 0.35, 0.16, 2)


def pulse():
    """A modern soft synth: two notes rocking back and forth."""
    buf = np.zeros(int(SR * 2.6))

    def note(f, length=0.17):
        x = clock(length)
        triangle = (2 / np.pi) * np.arcsin(np.sin(TAU * f * x))
        s = 0.6 * np.sin(TAU * f * x) + 0.3 * triangle + 0.14 * np.sin(TAU * 2 * f * x)
        return s * shape(len(x), 0.012, 0.09)

    for at, name in [(0.00, "D5"), (0.20, "A5"), (0.40, "D5"), (0.60, "A5"), (0.95, "D5"), (1.15, "A5"), (1.35, "D5"), (1.55, "B5")]:
        place(buf, note(hz(name)), at)
    return echo(lowpass(buf, 3200), 0.2, 0.4, 0.22, 3)


def chime():
    """Three glassy bells rising, left to ring out."""
    buf = np.zeros(int(SR * 3.2))

    def bell(f, length=1.9):
        x = clock(length)
        index = 1.2 * np.exp(-x / 0.3)
        s = np.sin(TAU * f * x + index * np.sin(TAU * 3.5 * f * x)) * np.exp(-x / 0.5)
        s += 0.28 * np.sin(TAU * 2 * f * x) * np.exp(-x / 0.28)
        return s * shape(len(x), 0.002, 0.12)

    for at, name in [(0.00, "G5"), (0.24, "B5"), (0.48, "D6")]:
        place(buf, bell(hz(name)), at)
    return echo(buf, 0.36, 0.4, 0.14, 2)


def umbra():
    """Dark and slow: a double heartbeat under a rising chord. Made for the name."""
    buf = np.zeros(int(SR * 3.4))

    def thump(length=0.42):
        x = clock(length)
        f = 58 + 62 * np.exp(-x / 0.05)              # the pitch falls quickly, like a drum skin
        phase = TAU * np.cumsum(f) / SR
        s = np.sin(phase) + 0.5 * np.sin(2 * phase) + 0.22 * np.sin(3 * phase)
        return s * np.exp(-x / 0.13) * shape(len(x), 0.002, 0.05)

    def pad(length=2.5):
        x = clock(length)
        s = sum(g * np.sin(TAU * f * x + p) for f, g, p in
                [(hz("A3"), 0.9, 0.0), (hz("E4"), 0.7, 1.0), (hz("A4") * 1.003, 0.5, 2.0), (hz("C#5"), 0.32, 0.5), (hz("E5") * 0.998, 0.22, 1.5)])
        swell = np.minimum(1, x / 0.7) * np.minimum(1, (length - x) / 0.9)
        return s * swell * (0.85 + 0.15 * np.sin(TAU * 4.5 * x))

    def ping(f, length=1.2):
        x = clock(length)
        return np.sin(TAU * f * x) * np.exp(-x / 0.3) * shape(len(x), 0.004, 0.1)

    place(buf, thump(), 0.00, 1.0)
    place(buf, thump(), 0.30, 0.8)
    place(buf, lowpass(pad(), 1800), 0.10, 0.34)
    place(buf, ping(hz("E6")), 0.95, 0.20)
    place(buf, ping(hz("A6")), 1.45, 0.16)
    return buf


def arcade():
    """An 8-bit run up the scale, twice."""
    buf = np.zeros(int(SR * 2.2))

    def blip(f, length=0.075):
        x = clock(length)
        square = np.where((f * x) % 1 < 0.25, 0.75, -0.25)   # a quarter-width pulse, centred so it carries no offset
        return square * shape(len(x), 0.001, 0.012)

    run = ["C5", "E5", "G5", "C6", "E6", "G6"]
    for start in (0.0, 0.56):
        for i, name in enumerate(run):
            place(buf, blip(hz(name)), start + i * 0.075)
    return lowpass(buf, 7000)


RINGS = [("classic", classic), ("marimba", marimba), ("pulse", pulse), ("chime", chime), ("umbra", umbra), ("arcade", arcade)]


def finish(cycle, repeats=2, level=0.16, peak=0.89):
    """Repeat the cycle and bring every ring to the same loudness, so comparing them is fair.

    Loudness is measured over the sounding parts only (about -16 dB), and no peak goes above -1 dB.
    """
    x = np.tile(cycle, repeats)
    sounding = x[np.abs(x) > 0.02 * np.max(np.abs(x))]
    x = x * level / np.sqrt(np.mean(sounding ** 2))
    x = x * min(1.0, peak / np.max(np.abs(x)))
    x[:64] *= np.linspace(0, 1, 64)
    x[-64:] *= np.linspace(1, 0, 64)
    return x


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "downloads" / "ringtones"
    out.mkdir(parents=True, exist_ok=True)
    for n, (slug, make) in enumerate(RINGS, 1):
        cycle = make()
        x = finish(cycle)
        path = out / ("ring-%d-%s.wav" % (n, slug))
        with wave.open(str(path), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes((x * 32767).astype("<i2").tobytes())
        loud = x[np.abs(x) > 0.01]
        print("%-22s %.1f s (one ring %.1f s)  peak %.1f dB  level %.1f dB  %d KB" % (
            path.name, len(x) / SR, len(cycle) / SR, 20 * np.log10(np.max(np.abs(x))),
            20 * np.log10(np.sqrt(np.mean(loud ** 2))), path.stat().st_size // 1024))
