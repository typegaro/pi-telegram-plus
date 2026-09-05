#!/usr/bin/env python3
"""Persistent fully-local Kokoro JSON-lines worker; it never calls Hugging Face."""
import argparse
import json
import sys
import wave


def reply(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def write_wav(path, audio):
    # Kokoro produces float audio at 24 kHz. stdlib wave avoids another cloud or
    # audio dependency and preserves a normal PCM WAV for ffmpeg conversion.
    import numpy as np
    samples = np.clip(audio, -1.0, 1.0)
    pcm = (samples * 32767).astype(np.int16)
    with wave.open(path, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(24000)
        output.writeframes(pcm.tobytes())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--voice", required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--language", default="a")
    args = parser.parse_args()
    try:
        import torch
        from kokoro import KPipeline
        from kokoro.model import KModel
        model = KModel(config=args.config, model=args.model).to(args.device).eval()
        pipeline = KPipeline(lang_code=args.language, model=model, device=args.device)
    except Exception as error:
        pipeline = None
        load_error = "Unable to load local Kokoro runtime/model: " + str(error)

    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            request_id = request.get("id")
            if request.get("command") != "synthesize":
                reply({"id": request_id, "ok": False, "error": "unsupported command"})
                continue
            if pipeline is None:
                reply({"id": request_id, "ok": False, "error": load_error})
                continue
            chunks = [result.audio for result in pipeline(request["text"], voice=args.voice) if result.audio is not None]
            if not chunks:
                reply({"id": request_id, "ok": False, "error": "Kokoro returned no audio"})
                continue
            write_wav(request["output"], torch.cat(chunks).detach().cpu().numpy())
            reply({"id": request_id, "ok": True})
        except Exception as error:
            reply({"id": request.get("id"), "ok": False, "error": str(error)})

if __name__ == "__main__":
    main()
