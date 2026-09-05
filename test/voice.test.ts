import { describe, expect, it } from "vitest";
import { ffmpegOpusArgs } from "../lib/voice/audio/ffmpeg.ts";
import { shouldReplyWithVoice, validateVoiceConfig, voiceReplyMode } from "../lib/voice/config.ts";
import type { TelegramConfig } from "../lib/types.ts";
import { createTelegramController } from "../lib/controller.ts";
import { installVoiceModel } from "../lib/voice/installer.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("voice configuration", () => {
  const enabled: TelegramConfig = { voice: { enabled: true, replyMode: "auto" } };
  it("uses auto as the safe default and follows input kind", () => {
    expect(voiceReplyMode({})).toBe("auto");
    expect(shouldReplyWithVoice(enabled, true)).toBe(true);
    expect(shouldReplyWithVoice(enabled, false)).toBe(false);
    expect(shouldReplyWithVoice({ voice: { enabled: true, replyMode: "on" } }, false)).toBe(true);
    expect(shouldReplyWithVoice({ voice: { enabled: true, replyMode: "off" } }, true)).toBe(false);
  });
  it("reports a missing manually configured model without fetching it", () => {
    const errors = validateVoiceConfig({ voice: { enabled: true, stt: { backend: "faster-whisper", modelPath: "/definitely/not/a/model" } } });
    expect(errors.join("\n")).toContain("STT model not found");
  });
});

describe("Telegram voice authorization", () => {
  const transport = { sendText: async () => [], answerCallbackQuery: async () => undefined };
  const base: any = {
    getSession: () => undefined,
    transport,
    ui: {},
    setActiveChatId: async () => undefined,
    getBotUsername: () => undefined,
    getMessageMode: () => "queue",
    telegramCommands: new Map(),
    getActiveTurn: () => undefined,
    beginTelegramTurn: () => undefined,
    endTelegramTurn: () => undefined,
  };
  it("does not download/transcribe an unauthorized voice note", async () => {
    const transcribe = async () => { throw new Error("must not run"); };
    const controller = createTelegramController({ ...base, authorizeUser: async () => false, transcribeIncomingVoice: transcribe });
    await controller.handleMessage({ message_id: 1, chat: { id: 42 }, from: { id: 9 }, voice: { file_id: "secret" } });
  });
  it("reports an empty transcript rather than invoking Pi", async () => {
    const sent: string[] = [];
    const controller = createTelegramController({
      ...base,
      transport: { ...transport, sendText: async (_chat: number, text: string) => { sent.push(text); return []; } },
      authorizeUser: async () => true,
      transcribeIncomingVoice: async () => "   ",
    });
    await controller.handleMessage({ message_id: 1, chat: { id: 42 }, from: { id: 9 }, voice: { file_id: "voice" } });
    expect(sent).toEqual(["Voice transcription was empty. Please try again."]);
  });
});

describe("allow-listed model installer", () => {
  it("stages and verifies a fixed download before exposing its target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-voice-test-"));
    const target = join(dir, "voice.onnx");
    try {
      await installVoiceModel({
        id: "test", label: "test voice", size: "5 bytes", installedPath: target, targetKind: "files",
        directFiles: [{ relativePath: "voice.onnx", url: "data:application/octet-stream;base64,aGVsbG8=", sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" }],
      }, () => undefined);
      expect(await readFile(target, "utf8")).toBe("hello");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("ffmpeg voice invocation", () => {
  it("uses separate safe arguments for Ogg/Opus conversion", () => {
    expect(ffmpegOpusArgs("input with spaces.wav", "out.ogg", "32k")).toEqual([
      "-y", "-i", "input with spaces.wav", "-c:a", "libopus", "-b:a", "32k", "-vn", "out.ogg",
    ]);
  });
});
