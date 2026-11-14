"""Bounded CPU-only MP4 validation and sparse frame extraction, not a motion-quality judge."""
import hashlib
import io
import json
import math
import os
from pathlib import Path
import sys

import av


def verify_video(filename, expected):
    source = Path(filename)
    if source.is_symlink() or not source.is_file() or source.suffix.lower() != '.mp4' or not (32 < source.stat().st_size <= 64 * 1024**2):
        raise ValueError('Invalid bounded MP4 source')
    width, height, frames, fps = (expected[k] for k in ('width', 'height', 'frames', 'fps'))
    audio = expected.get('audio', False)
    legacy = not audio and 256 <= width <= 832 and 256 <= height <= 832 and width * height <= 500000 and 17 <= frames <= 49 and (frames - 1) % 4 == 0 and 8 <= fps <= 24
    fasth3 = audio is True and 256 <= width <= 768 and 256 <= height <= 768 and width % 32 == height % 32 == 0 and width * height <= 393216 and 22 <= frames <= 124 and (frames - 5) % 17 == 0 and fps == 24
    if not all(type(v) is int for v in (width, height, frames, fps)) or not (legacy or fasth3):
        raise ValueError('Unexpected video dimensions or duration')
    selected = {0, frames // 2, frames - 1}
    previews, decoded_hashes, timestamps = [], [], []
    with av.open(str(source), mode='r', options={'protocol_whitelist': 'file'}) as container:
        if len(container.streams.video) != 1 or len(container.streams.audio) != int(audio):
            raise ValueError('Unexpected video or audio stream count')
        stream = container.streams.video[0]
        if stream.codec_context.name != 'h264' or stream.width != width or stream.height != height:
            raise ValueError('Video codec or dimensions differ')
        actual_rate = float(stream.average_rate) if stream.average_rate else 0
        if not math.isfinite(actual_rate) or abs(actual_rate - fps) > .01:
            raise ValueError('Video FPS differs')
        count = 0
        for index, frame in enumerate(container.decode(stream)):
            count += 1
            if count > frames or frame.width != width or frame.height != height:
                raise ValueError('Unexpected decoded frame count or dimensions')
            if frame.time is None or not math.isfinite(frame.time) or (timestamps and frame.time <= timestamps[-1]):
                raise ValueError('Video timestamps missing or non-monotonic')
            timestamps.append(frame.time)
            image = frame.to_image().convert('RGB')
            decoded_hashes.append(hashlib.sha256(image.tobytes()).hexdigest())
            if index in selected:
                buffer = io.BytesIO()
                image.save(buffer, format='PNG')
                previews.append((index, frame.time, buffer.getvalue()))
        if count != frames or len(previews) != 3 or abs((timestamps[-1] - timestamps[0]) - (frames - 1) / fps) > .02:
            raise ValueError('Video duration or decoded count differs')
    results = []
    for index, timestamp, content in previews:
        name = f'{source.stem}-frame-{index:04d}.png'
        target = source.parent / name
        if target.is_symlink():
            raise ValueError('Preview target is a link')
        try:
            with target.open('xb') as output:
                output.write(content)
                output.flush()
                os.fsync(output.fileno())
        except FileExistsError:
            if not target.is_file() or target.read_bytes() != content:
                raise ValueError('Existing preview differs')
        results.append({'name': name, 'sha256': hashlib.sha256(content).hexdigest(), 'width': width, 'height': height,
                        'mime': 'image/png', 'role': 'evaluation_frame', 'frameIndex': index, 'timestampSeconds': timestamp})
    return {'codec': 'h264', 'width': width, 'height': height, 'frames': frames, 'fps': fps, 'durationSeconds': frames / fps,
            'audio': audio, 'uniqueDecodedFrames': len(set(decoded_hashes)), 'evaluationScope': 'first, middle and last frame only; temporal and audio quality require playback', 'previews': results}


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Expected video path and contract JSON')
    print(json.dumps(verify_video(sys.argv[1], json.loads(sys.argv[2])), ensure_ascii=True))
