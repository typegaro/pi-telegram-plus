import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerVoiceCommands } from "../commands/voice.ts";
import { installVoiceModel, isVoiceModelInstalled } from "../voice/installer.ts";

describe("voice health check", () => {
  it("registers the canonical command and its typo-compatible alias", () => {
    const commands = new Map<string, unknown>();
    registerVoiceCommands({ registerCommand: (name, options) => commands.set(name, options) }, {
      getConfig: () => ({}), setConfig: () => undefined, persistConfig: async () => undefined,
    });
    expect(commands.has("tg-voice-healthcheck")).toBe(true);
    expect(commands.has("tg-voice-heltcheck")).toBe(true);
  });

  it("repairs a partial multi-file install without downloading existing files again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-voice-test-"));
    const target = join(dir, "model.bin");
    const spec = {
      id: "test", label: "test voice", size: "11 bytes", installedPath: target, targetKind: "files" as const,
      directFiles: [
        { relativePath: "model.bin", url: "invalid://existing-file-must-not-be-fetched" },
        { relativePath: "config.json", url: "data:application/octet-stream;base64,Y29uZmln" },
      ],
    };
    try {
      await writeFile(target, "model");
      expect(isVoiceModelInstalled(spec)).toBe(false);
      await installVoiceModel(spec, () => undefined);
      expect(await readFile(target, "utf8")).toBe("model");
      expect(await readFile(join(dir, "config.json"), "utf8")).toBe("config");
      expect(isVoiceModelInstalled(spec)).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
