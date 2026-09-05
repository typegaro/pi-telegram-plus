import { existsSync } from "node:fs";
import { expandHome } from "../config.ts";
import { runProcess } from "../audio/process.ts";
import type { TtsBackend } from "./types.ts";

export class PiperTts implements TtsBackend {
  readonly name = "piper";
  constructor(private readonly options: { binary: string; model: string; config?: string; timeoutMs: number }) {}
  async synthesize(text: string, wavPath: string): Promise<void> {
    const model = expandHome(this.options.model);
    if (!existsSync(model)) throw new Error(`Piper voice model is not installed. Expected: ${this.options.model}`);
    const args = ["--model", model, "--output_file", wavPath];
    if (this.options.config) args.push("--config", expandHome(this.options.config));
    await runProcess(this.options.binary, args, this.options.timeoutMs, `${text}\n`);
  }
}
