import { runProcess } from "./process.ts";

export function ffmpegOpusArgs(input: string, output: string, bitrate: string): string[] {
  return ["-y", "-i", input, "-c:a", "libopus", "-b:a", bitrate, "-vn", output];
}
export async function wavToTelegramVoice(ffmpeg: string, input: string, output: string, bitrate: string, timeoutMs: number): Promise<void> {
  await runProcess(ffmpeg, ffmpegOpusArgs(input, output, bitrate), timeoutMs);
}
