import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { TelegramConfig, VoiceConfig, VoiceReplyMode } from "../types.ts";

export const VOICE_REPLY_MODES: readonly VoiceReplyMode[] = ["off", "on", "auto"] as const;

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return resolve(value);
}

export function voiceReplyMode(config: TelegramConfig): VoiceReplyMode {
  const value = config.voice?.replyMode;
  return VOICE_REPLY_MODES.includes(value as VoiceReplyMode) ? value as VoiceReplyMode : "auto";
}

export function shouldReplyWithVoice(config: TelegramConfig, voiceInput: boolean): boolean {
  if (!config.voice?.enabled) return false;
  const mode = voiceReplyMode(config);
  return mode === "on" || (mode === "auto" && voiceInput);
}

/** Validation is deliberately local and side-effect free: it never downloads a model. */
export function validateVoiceConfig(config: TelegramConfig): string[] {
  const voice = config.voice;
  if (!voice?.enabled) return [];
  const errors: string[] = [];
  if (!voice.stt?.backend) errors.push("voice.stt.backend is required when voice is enabled");
  if (voice.stt?.backend === "faster-whisper") {
    if (!voice.stt.modelPath) errors.push("voice.stt.modelPath is required for faster-whisper");
    else if (!existsSync(expandHome(voice.stt.modelPath))) errors.push(`STT model not found: ${voice.stt.modelPath}`);
  }
  if (voice.stt?.backend === "whisper-cpp") {
    if (!voice.stt.binary) errors.push("voice.stt.binary is required for whisper.cpp");
    if (!voice.stt.model) errors.push("voice.stt.model is required for whisper.cpp");
    else if (!existsSync(expandHome(voice.stt.model))) errors.push(`STT model not found: ${voice.stt.model}`);
  }
  if (voice.tts?.backend === "piper" && voice.tts.model && !existsSync(expandHome(voice.tts.model))) {
    errors.push(`TTS model not found: ${voice.tts.model}`);
  }
  if (voice.tts?.backend === "kokoro") {
    for (const [label, path] of [["model", voice.tts.model], ["config", voice.tts.config], ["voice", voice.tts.voice]]) {
      if (!path || !existsSync(expandHome(path))) errors.push(`Kokoro ${label} not found: ${path ?? "not configured"}`);
    }
  }
  if (voice.audio?.opusBitrate && !/^\d+k$/i.test(voice.audio.opusBitrate)) errors.push("voice.audio.opusBitrate must look like 32k");
  return errors;
}

export function voiceLimits(config: TelegramConfig): Required<Pick<VoiceConfig, "maxDurationSeconds" | "maxFileSizeBytes" | "timeoutMs">> {
  const voice = config.voice;
  return {
    maxDurationSeconds: voice?.maxDurationSeconds ?? 10 * 60,
    maxFileSizeBytes: voice?.maxFileSizeBytes ?? 20 * 1024 * 1024,
    timeoutMs: voice?.timeoutMs ?? 120_000,
  };
}
