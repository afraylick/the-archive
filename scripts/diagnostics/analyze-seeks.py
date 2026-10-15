"""Cross-correlate captured browser output against sequential ffmpeg decoding.
Usage: python3 scripts/diagnostics/analyze-seeks.py /tmp/seek-results
Requires numpy. This diagnostic is not part of the application runtime.
"""
import json
import sys
from pathlib import Path
import numpy as np

root = Path(sys.argv[1])
reference = np.fromfile(root / 'reference.f32', dtype='<f4')
for file in sorted(root.glob('*-result.json')):
    result = json.loads(file.read_text())
    blocks = result['blocks']
    if not blocks:
        print(json.dumps({'file': file.name, 'error': 'No captured audio'}))
        continue
    rate = result['sampleRate']
    samples = np.concatenate([block['samples'] for block in blocks])
    samples = np.interp(np.arange(0, len(samples), rate / 8000), np.arange(len(samples)), samples)
    # ScriptProcessor reports the most recent buffer. Allow its scheduling
    # uncertainty (~one block) instead of treating media.currentTime as proof.
    expected = blocks[0]['time'] - 2048 / rate
    start = max(0, int((expected - 12) * 8000))
    end = min(len(reference), int((expected + 20) * 8000))
    window = reference[start:end].astype(float)
    nfft = 1 << (len(window) + len(samples) - 2).bit_length()
    correlation = np.fft.irfft(np.fft.rfft(window, nfft) * np.fft.rfft(samples[::-1], nfft), nfft)
    valid = correlation[len(samples) - 1:len(window)]
    offset = int(np.argmax(valid))
    actual = (start + offset) / 8000
    match = window[offset:offset + len(samples)]
    norm = np.linalg.norm(match) * np.linalg.norm(samples)
    quality = float(np.dot(match, samples) / norm) if norm else 0
    print(json.dumps({
        'file': file.name, 'browser': result['ua'], 'mode': result['mode'],
        'target': result['target'], 'errorSeconds': round(actual - expected, 4),
        'correlation': round(quality, 4), 'seekMs': round(result['latency'], 2),
        'stableHeight': result['height'] == result['finalHeight'],
        'reliableMatch': quality > 0.9,
    }))
