import { existsSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expandHome } from "../config.ts";
import { nativeLibraryEnvironment } from "../audio/process.ts";
import type { TtsBackend } from "./types.ts";

type WorkerReply = { id?: string; ok?: boolean; error?: string };
type Pending = { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** Persistent local Kokoro worker. The model and voice paths are always explicit local files. */
export class KokoroTts implements TtsBackend {
  readonly name = "kokoro";
  private worker?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private stdout = "";
  constructor(private readonly options: { python: string; model: string; config: string; voice: string; device: string; language: string; timeoutMs: number }) {}

  private start(): ChildProcessWithoutNullStreams {
    const model = expandHome(this.options.model);
    const config = expandHome(this.options.config);
    const voice = expandHome(this.options.voice);
    for (const path of [model, config, voice]) if (!existsSync(path)) throw new Error(`Kokoro local file is not installed. Expected: ${path}`);
    if (this.worker && !this.worker.killed) return this.worker;
    const workerFile = fileURLToPath(new URL("../worker/kokoro-worker.py", import.meta.url));
    const child = spawn(this.options.python, [workerFile, "--model", model, "--config", config, "--voice", voice, "--device", this.options.device, "--language", this.options.language], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: nativeLibraryEnvironment(),
    });
    this.worker = child;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.on("data", () => undefined); // never log spoken response content
    child.on("error", (error) => this.failAll(new Error(`Kokoro worker unavailable: ${error.message}`)));
    child.on("exit", () => { if (this.worker === child) this.worker = undefined; this.failAll(new Error("Kokoro worker stopped unexpectedly")); });
    return child;
  }
  private consume(chunk: string): void {
    this.stdout += chunk;
    for (;;) {
      const newline = this.stdout.indexOf("\n"); if (newline < 0) return;
      const line = this.stdout.slice(0, newline); this.stdout = this.stdout.slice(newline + 1);
      let reply: WorkerReply;
      try { reply = JSON.parse(line) as WorkerReply; } catch { this.failAll(new Error("Kokoro worker returned malformed JSON")); continue; }
      if (!reply.id) { this.failAll(new Error("Kokoro worker response is missing an id")); continue; }
      const pending = this.pending.get(reply.id); if (!pending) continue;
      this.pending.delete(reply.id); clearTimeout(pending.timer);
      reply.ok ? pending.resolve() : pending.reject(new Error(reply.error || "Kokoro synthesis failed"));
    }
  }
  private failAll(error: Error): void { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
  async synthesize(text: string, wavPath: string): Promise<void> {
    const child = this.start(); const id = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); child.kill("SIGKILL"); reject(new Error(`Kokoro timed out after ${this.options.timeoutMs}ms`)); }, this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { child.stdin.write(`${JSON.stringify({ id, command: "synthesize", text, output: wavPath })}\n`); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  async dispose(): Promise<void> { this.worker?.kill("SIGTERM"); this.worker = undefined; this.failAll(new Error("Kokoro worker stopped")); }
}
