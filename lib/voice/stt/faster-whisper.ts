import { existsSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expandHome } from "../config.ts";
import type { SttBackend, Transcription } from "./types.ts";

type WorkerReply = { id?: string; ok?: boolean; text?: string; language?: string; duration?: number; error?: string };
type Pending = { resolve: (value: Transcription) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

function nativeLibraryEnvironment(): NodeJS.ProcessEnv {
  // NixOS intentionally does not expose a global libstdc++ loader path. Native
  // Python wheels (CTranslate2) need the system's explicitly supplied nix-ld
  // library path. Other distributions retain their inherited environment.
  const nixLibraries = process.env.NIX_LD_LIBRARY_PATH;
  if (!nixLibraries) return process.env;
  return {
    ...process.env,
    LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ? `${nixLibraries}:${process.env.LD_LIBRARY_PATH}` : nixLibraries,
  };
}

/** A JSON-lines worker keeps the CTranslate2 model loaded between voice notes. */
export class FasterWhisperStt implements SttBackend {
  readonly name = "faster-whisper";
  private worker?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private stdout = "";
  constructor(private readonly options: { python: string; modelPath: string; device: string; computeType: string; timeoutMs: number }) {}

  private start(): ChildProcessWithoutNullStreams {
    const modelPath = expandHome(this.options.modelPath);
    if (!existsSync(modelPath)) throw new Error(`faster-whisper model is not installed. Expected: ${this.options.modelPath}`);
    if (this.worker && !this.worker.killed) return this.worker;
    const workerFile = fileURLToPath(new URL("../worker/stt-worker.py", import.meta.url));
    const child = spawn(this.options.python, [workerFile, "--model-path", modelPath, "--device", this.options.device, "--compute-type", this.options.computeType], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: nativeLibraryEnvironment(),
    });
    this.worker = child;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.on("data", () => undefined); // never write transcript/audio data to logs
    child.on("error", (error) => this.failAll(new Error(`faster-whisper worker unavailable: ${error.message}`)));
    child.on("exit", () => { if (this.worker === child) this.worker = undefined; this.failAll(new Error("faster-whisper worker stopped unexpectedly")); });
    return child;
  }

  private consume(chunk: string): void {
    this.stdout += chunk;
    for (;;) {
      const newline = this.stdout.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdout.slice(0, newline); this.stdout = this.stdout.slice(newline + 1);
      let reply: WorkerReply;
      try { reply = JSON.parse(line) as WorkerReply; } catch { this.failAll(new Error("faster-whisper worker returned malformed JSON")); continue; }
      if (!reply.id) { this.failAll(new Error("faster-whisper worker response is missing an id")); continue; }
      const pending = this.pending.get(reply.id); if (!pending) continue;
      this.pending.delete(reply.id); clearTimeout(pending.timer);
      if (!reply.ok) pending.reject(new Error(reply.error || "faster-whisper transcription failed"));
      else pending.resolve({ text: String(reply.text ?? "").trim(), language: reply.language, duration: reply.duration });
    }
  }
  private failAll(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  async transcribe(file: string, language = "auto"): Promise<Transcription> {
    const child = this.start();
    const id = crypto.randomUUID();
    return await new Promise<Transcription>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A wedged inference cannot safely serve the next correlated request.
        // Kill it; the next note starts a fresh worker and reuses the same local model.
        this.pending.delete(id);
        child.kill("SIGKILL");
        reject(new Error(`faster-whisper timed out after ${this.options.timeoutMs}ms`));
      }, this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { child.stdin.write(`${JSON.stringify({ id, command: "transcribe", file, language })}\n`); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  async dispose(): Promise<void> { this.worker?.kill("SIGTERM"); this.worker = undefined; this.failAll(new Error("faster-whisper worker stopped")); }
}
