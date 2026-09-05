#!/usr/bin/env python3
"""Local faster-whisper JSON-lines worker. It intentionally never downloads a model."""
import argparse, json, sys

def reply(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    args = parser.parse_args()
    try:
        from faster_whisper import WhisperModel
        model = WhisperModel(args.model_path, device=args.device, compute_type=args.compute_type, local_files_only=True)
    except Exception as error:
        # Keep the process alive so each TypeScript request receives a correlated error.
        model = None
        load_error = "Unable to load local faster-whisper model: " + str(error)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            request_id = request.get("id")
            if request.get("command") != "transcribe":
                reply({"id": request_id, "ok": False, "error": "unsupported command"}); continue
            if model is None:
                reply({"id": request_id, "ok": False, "error": load_error}); continue
            language = request.get("language")
            segments, info = model.transcribe(request["file"], language=None if language in (None, "", "auto") else language)
            text = "".join(segment.text for segment in segments).strip()
            duration = getattr(info, "duration", None)
            reply({"id": request_id, "ok": True, "text": text, "language": getattr(info, "language", None), "duration": duration})
        except Exception as error:
            reply({"id": request.get("id") if "request" in locals() else None, "ok": False, "error": str(error)})
if __name__ == "__main__": main()
