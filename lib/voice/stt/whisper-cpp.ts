import { existsSync } from "node:fs";
import { expandHome } from "../config.ts";
import { runProcess } from "../audio/process.ts";
import type { SttBackend, Transcription } from "./types.ts";

export class WhisperCppStt implements SttBackend {
  readonly name = "whisper-cpp";
  constructor(private readonly options: { binary: string; model: string; timeoutMs: number }) {}
  async transcribe(file: string, language = "auto"): Promise<Transcription> {
    const model = expandHome(this.options.model);
    if (!existsSync(model)) throw new Error(`whisper.cpp model is not installed. Expected: ${this.options.model}`);
    const args = ["-m", model, "-f", file, "--no-timestamps"];
    if (language !== "auto") args.push("-l", language);
    const { stdout } = await runProcess(this.options.binary, args, this.options.timeoutMs);
    const text = stdout.replace(/^\[[^\]]+\]\s*/gm, "").trim();
    if (!text) throw new Error("whisper.cpp returned an empty transcription");
    return { text };
  }
}
