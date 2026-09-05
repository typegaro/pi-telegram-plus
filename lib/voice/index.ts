import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TelegramConfig } from "../types.ts";
import { voiceLimits } from "./config.ts";
import { wavToTelegramVoice } from "./audio/ffmpeg.ts";
import { FasterWhisperStt } from "./stt/faster-whisper.ts";
import { WhisperCppStt } from "./stt/whisper-cpp.ts";
import type { SttBackend, Transcription } from "./stt/types.ts";
import { PiperTts } from "./tts/piper.ts";
import { KokoroTts } from "./tts/kokoro.ts";
import type { TtsBackend } from "./tts/types.ts";

function spokenText(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "code block omitted").replace(/[`*_#>[\]()]/g, " ").replace(/\s+/g, " ").trim();
}

export class VoiceSubsystem {
  private stt?: SttBackend;
  private sttKey?: string;
  constructor(private readonly getConfig: () => TelegramConfig) {}
  private getStt(): SttBackend {
    const cfg = this.getConfig().voice?.stt;
    if (!cfg?.backend) throw new Error("Voice STT is not configured");
    const key = JSON.stringify(cfg);
    if (this.stt && this.sttKey === key) return this.stt;
    void this.stt?.dispose?.(); this.stt = undefined;
    const timeoutMs = voiceLimits(this.getConfig()).timeoutMs;
    if (cfg.backend === "faster-whisper") {
      if (!cfg.modelPath) throw new Error("faster-whisper modelPath is not configured");
      this.stt = new FasterWhisperStt({ python: cfg.python ?? "python3", modelPath: cfg.modelPath, device: cfg.device ?? "cpu", computeType: cfg.computeType ?? "int8", timeoutMs });
    } else if (cfg.backend === "whisper-cpp") {
      if (!cfg.binary || !cfg.model) throw new Error("whisper.cpp binary and model are required");
      this.stt = new WhisperCppStt({ binary: cfg.binary, model: cfg.model, timeoutMs });
    } else throw new Error(`Unsupported STT backend: ${cfg.backend}`);
    this.sttKey = key; return this.stt;
  }
  private getTts(): TtsBackend {
    const cfg = this.getConfig().voice?.tts;
    if (!cfg?.backend || !cfg.model) throw new Error("Voice TTS is not configured");
    const timeoutMs = voiceLimits(this.getConfig()).timeoutMs;
    if (cfg.backend === "piper") return new PiperTts({ binary: cfg.binary ?? "piper", model: cfg.model, config: cfg.config, timeoutMs });
    if (cfg.backend === "kokoro") {
      if (!cfg.config || !cfg.voice) throw new Error("Kokoro config and voice paths are required");
      return new KokoroTts({
        python: cfg.python ?? this.getConfig().voice?.stt?.python ?? "python3",
        model: cfg.model,
        config: cfg.config,
        voice: cfg.voice,
        device: cfg.device ?? "cpu",
        language: cfg.language ?? "a",
        timeoutMs,
      });
    }
    throw new Error(`Unsupported TTS backend: ${cfg.backend}`);
  }
  async transcribe(file: string): Promise<Transcription> {
    const cfg = this.getConfig(); const limits = voiceLimits(cfg); const details = await stat(file);
    if (details.size > limits.maxFileSizeBytes) throw new Error(`voice file exceeds configured ${limits.maxFileSizeBytes} byte limit`);
    return await this.getStt().transcribe(file, cfg.voice?.stt?.language ?? "auto");
  }
  async synthesizeTelegramVoice(text: string): Promise<{ oggPath: string; cleanup: () => Promise<void> }> {
    const cfg = this.getConfig(); const dir = await mkdtemp(join(tmpdir(), "pi-tg-voice-"));
    const wavPath = join(dir, "reply.wav"); const oggPath = join(dir, "reply.ogg");
    try {
      const normalized = spokenText(text); if (!normalized) throw new Error("assistant response has no speakable text");
      await this.getTts().synthesize(normalized, wavPath);
      await wavToTelegramVoice(cfg.voice?.audio?.ffmpeg ?? "ffmpeg", wavPath, oggPath, cfg.voice?.audio?.opusBitrate ?? "32k", voiceLimits(cfg).timeoutMs);
      return { oggPath, cleanup: async () => { await rm(dir, { recursive: true, force: true }); } };
    } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  }
  async dispose(): Promise<void> { await this.stt?.dispose?.(); this.stt = undefined; }
}
