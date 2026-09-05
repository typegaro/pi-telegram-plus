import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { escapeHtml } from "../html.ts";
import { expandHome, validateVoiceConfig, voiceReplyMode } from "../voice/config.ts";
import { getAgentDir } from "../config.ts";
import { nativeLibraryEnvironment, runProcess } from "../voice/audio/process.ts";
import { installVoiceModel, type VoiceModelInstall } from "../voice/installer.ts";
import type { TelegramConfig, VoiceReplyMode } from "../types.ts";

export type VoiceCommandDeps = {
  getConfig: () => TelegramConfig;
  setConfig: (config: TelegramConfig) => void;
  persistConfig: (config: TelegramConfig) => Promise<void>;
};

type Ui = { notify(message: string, level?: "info" | "error" | "warning") : void; select(title: string, options: string[]): Promise<string | undefined>; confirm(title: string, message?: string): Promise<boolean> };
type KnownSttModel = { id: string; label: string; quality: string; backend: "faster-whisper" | "whisper-cpp"; path: string; model: string; install: VoiceModelInstall };
type KnownTtsModel = { id: string; label: string; quality: string; backend: "piper" | "kokoro"; path: string; config: string; voice?: string; language?: string; install: VoiceModelInstall }; 

// This is an allow-list, not a path parser. Telegram users can select a local
// model but can never supply an executable or arbitrary filesystem path.
const KNOWN_STT_MODELS: KnownSttModel[] = [
  { id: "small", label: "faster-whisper small (~466 MB)", quality: "balanced",  backend: "faster-whisper", model: "small", path: "~/.pi/agent/models/stt/whisper-small", install: { id: "small", label: "faster-whisper small", size: "~466 MB", installedPath: "~/.pi/agent/models/stt/whisper-small", targetKind: "directory", huggingFaceRepo: "Systran/faster-whisper-small" } },
  { id: "large-v3-turbo", label: "faster-whisper large-v3-turbo (~1.6 GB)", quality: "best",  backend: "faster-whisper", model: "large-v3-turbo", path: "~/.pi/agent/models/stt/whisper-large-v3-turbo", install: { id: "large-v3-turbo", label: "faster-whisper large-v3-turbo", size: "~1.6 GB", installedPath: "~/.pi/agent/models/stt/whisper-large-v3-turbo", targetKind: "directory", huggingFaceRepo: "Systran/faster-whisper-large-v3-turbo" } },
  { id: "whisper-cpp-small", label: "whisper.cpp ggml-small.bin (~466 MB)", quality: "balanced",  backend: "whisper-cpp", model: "small", path: "~/.pi/agent/models/stt/ggml-small.bin", install: { id: "whisper-cpp-small", label: "whisper.cpp small", size: "~466 MB", installedPath: "~/.pi/agent/models/stt/ggml-small.bin", targetKind: "files", directFiles: [{ relativePath: "ggml-small.bin", url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin" }] } },
  { id: "whisper-cpp-large-v3", label: "whisper.cpp ggml-large-v3.bin (~3.1 GB)", quality: "best",  backend: "whisper-cpp", model: "large-v3", path: "~/.pi/agent/models/stt/ggml-large-v3.bin", install: { id: "whisper-cpp-large-v3", label: "whisper.cpp large-v3", size: "~3.1 GB", installedPath: "~/.pi/agent/models/stt/ggml-large-v3.bin", targetKind: "files", directFiles: [{ relativePath: "ggml-large-v3.bin", url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin" }] } },
];
const KNOWN_TTS_MODELS: KnownTtsModel[] = [
  {
    id: "en_US-lessac-medium", label: "Piper en_US-lessac-medium (~60 MB)", quality: "good / fast", backend: "piper", 
    path: "~/.pi/agent/models/tts/en_US-lessac-medium.onnx",
    config: "~/.pi/agent/models/tts/en_US-lessac-medium.onnx.json",
    install: { id: "en_US-lessac-medium", label: "Piper en_US-lessac-medium", size: "~60 MB", installedPath: "~/.pi/agent/models/tts/en_US-lessac-medium.onnx", targetKind: "files", directFiles: [
      { relativePath: "en_US-lessac-medium.onnx", url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx" },
      { relativePath: "en_US-lessac-medium.onnx.json", url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json" },
    ] },
  },
  {
    id: "en_US-lessac-high", label: "Piper en_US-lessac-high (~114 MB, higher quality)", quality: "very good", backend: "piper", 
    path: "~/.pi/agent/models/tts/en_US-lessac-high.onnx",
    config: "~/.pi/agent/models/tts/en_US-lessac-high.onnx.json",
    install: { id: "en_US-lessac-high", label: "Piper en_US-lessac-high", size: "~114 MB", installedPath: "~/.pi/agent/models/tts/en_US-lessac-high.onnx", targetKind: "files", directFiles: [
      { relativePath: "en_US-lessac-high.onnx", url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/high/en_US-lessac-high.onnx" },
      { relativePath: "en_US-lessac-high.onnx.json", url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/high/en_US-lessac-high.onnx.json" },
    ] },
  },
  {
    id: "kokoro-af-heart", label: "Kokoro-82M af_heart (~330 MB)", quality: "natural / expressive", backend: "kokoro",
    path: "~/.pi/agent/models/tts/kokoro-v1_0.pth",
    config: "~/.pi/agent/models/tts/kokoro-config.json",
    voice: "~/.pi/agent/models/tts/kokoro-af_heart.pt",
    language: "a",
    install: { id: "kokoro-af-heart", label: "Kokoro-82M af_heart", size: "~330 MB", installedPath: "~/.pi/agent/models/tts/kokoro-v1_0.pth", targetKind: "files", directFiles: [
      { relativePath: "kokoro-v1_0.pth", url: "https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/kokoro-v1_0.pth" },
      { relativePath: "kokoro-config.json", url: "https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/config.json" },
      { relativePath: "kokoro-af_heart.pt", url: "https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/voices/af_heart.pt" },
    ] },
  },
];

function executableStatus(command: string): string {
  // A harmless local probe only; this never installs anything or performs hardware detection.
  if (command.includes("/") || command.startsWith("~")) return existsSync(expandHome(command)) ? "available" : "missing";
  const result = spawnSync(command, ["-version"], { stdio: "ignore", timeout: 2_000, env: nativeLibraryEnvironment() });
  return !result.error && result.status === 0 ? "available" : "missing";
}

function pythonPackageStatus(python: string, packageName: string): string {
  const result = spawnSync(python, ["-c", `import ${packageName}`], { stdio: "ignore", timeout: 5_000, env: nativeLibraryEnvironment() });
  return !result.error && result.status === 0 ? "available" : "missing";
}
function pythonModuleStatus(python: string): string { return pythonPackageStatus(python, "faster_whisper"); }

function status(config: TelegramConfig): string {
  const voice = config.voice;
  if (!voice?.enabled) return "<b>Voice subsystem</b>\nStatus: disabled\nText-only Telegram remains active.\nUse /tg-voice-install to download an approved model, then /tg-voice-setup.";
  const stt = voice.stt;
  const tts = voice.tts;
  const errors = validateVoiceConfig(config);
  const modelStatus = (path: string | undefined) => path ? (existsSync(expandHome(path)) ? "ready" : "missing") : "not configured";
  return [
    "<b>Voice subsystem</b>",
    `Reply mode: <b>${voiceReplyMode(config)}</b>`,
    "",
    "<b>STT</b>",
    `backend: ${escapeHtml(stt?.backend ?? "not configured")}`,
    `model: ${escapeHtml(stt?.modelPath ?? stt?.model ?? "not configured")}`,
    `status: ${modelStatus(stt?.modelPath ?? stt?.model)}`,
    `Python faster-whisper: ${pythonModuleStatus(stt?.python ?? "python3")}`,
    "",
    "<b>TTS</b>",
    `backend: ${escapeHtml(tts?.backend ?? "not configured")}`,
    `model: ${escapeHtml(tts?.model ?? "not configured")}`,
    `status: ${modelStatus(tts?.model)}`,
    tts?.backend === "kokoro"
      ? `Kokoro runtime: ${pythonPackageStatus(tts.python ?? stt?.python ?? "python3", "kokoro")}`
      : `Piper executable: ${executableStatus(tts?.binary ?? "piper")}`, 
    "",
    `FFmpeg: ${escapeHtml(voice.audio?.ffmpeg ?? "ffmpeg")} (${executableStatus(voice.audio?.ffmpeg ?? "ffmpeg")})`,
    ...(errors.length ? [`\n⚠️ ${escapeHtml(errors[0])}`] : []),
  ].join("\n");
}

function installedSttModels(): KnownSttModel[] { return KNOWN_STT_MODELS.filter((model) => existsSync(expandHome(model.path))); }
function installedTtsModels(): KnownTtsModel[] { return KNOWN_TTS_MODELS.filter((model) => existsSync(expandHome(model.path))); }
function configuredPiperBinary(config: TelegramConfig): string {
  const configured = config.voice?.tts?.binary;
  if (configured) return configured;
  const venv = "~/.pi/agent/voice-venv/bin/piper";
  return existsSync(expandHome(venv)) ? venv : "piper";
}
function configuredPython(config: TelegramConfig): string {
  const configured = config.voice?.stt?.python;
  if (configured) return configured;
  const venv = "~/.pi/agent/voice-venv/bin/python";
  return existsSync(expandHome(venv)) ? venv : "python3";
}

async function save(deps: VoiceCommandDeps, next: TelegramConfig): Promise<void> {
  deps.setConfig(next);
  await deps.persistConfig(next);
}

async function setReplyMode(args: string, ctx: { ui: Ui }, deps: VoiceCommandDeps): Promise<void> {
  const arg = args.trim().toLowerCase(); const config = deps.getConfig();
  if (!arg || arg === "status") { ctx.ui.notify(status(config), "info"); return; }
  if (!["on", "off", "auto"].includes(arg)) { ctx.ui.notify("Usage: /voice status|on|off|auto", "error"); return; }
  await save(deps, { ...config, voice: { ...config.voice, enabled: true, replyMode: arg as VoiceReplyMode } });
  ctx.ui.notify(`Voice reply mode set to ${arg}.`, "info");
}

async function setLanguage(args: string, ctx: { ui: Ui }, deps: VoiceCommandDeps): Promise<void> {
  const [action, value] = args.trim().split(/\s+/, 2); const config = deps.getConfig();
  if (!action || action === "status") { ctx.ui.notify(status(config), "info"); return; }
  if (action !== "language" || !value || (!/^[a-z]{2,12}$/i.test(value) && value !== "auto")) { ctx.ui.notify("Usage: /stt status | /stt language auto|en|it", "error"); return; }
  await save(deps, { ...config, voice: { ...config.voice, stt: { ...config.voice?.stt, language: value.toLowerCase() } } });
  ctx.ui.notify(`STT language set to ${value.toLowerCase()}.`, "info");
}

async function selectModel(args: string, ctx: { ui: Ui }, deps: VoiceCommandDeps): Promise<void> {
  const [kind, id] = args.trim().toLowerCase().split(/\s+/, 2);
  let config = deps.getConfig();
  // The selector is also the installer: it shows quality/size and provisions
  // the required allow-listed runtime/model when the selected entry is absent.
  if (!kind) {
    await installModel("", ctx, deps);
    return;
  }
  if (kind === "stt" && !id) {
    const choices = installedSttModels();
    if (choices.length === 0) {
      await installModel("stt", ctx, deps);
      return;
    }
    const labels = choices.map((model) => model.label);
    const selected = await ctx.ui.select("Select installed local STT model", labels);
    if (!selected) return;
    await selectModel(`stt ${choices[labels.indexOf(selected)].id}`, ctx, deps);
    return;
  }
  if (kind === "tts" && !id) {
    const choices = installedTtsModels();
    if (choices.length === 0) {
      await installModel("tts", ctx, deps);
      return;
    }
    const labels = choices.map((model) => model.label);
    const selected = await ctx.ui.select("Select installed local TTS voice", labels);
    if (!selected) return;
    await selectModel(`tts ${choices[labels.indexOf(selected)].id}`, ctx, deps);
    return;
  }
  if (kind === "stt") {
    const model = KNOWN_STT_MODELS.find((item) => item.id === id);
    if (!model) { ctx.ui.notify("Usage: /tg-voice-model stt small|large-v3-turbo|whisper-cpp-small", "error"); return; }
    if (!existsSync(expandHome(model.path))) { await installModel(`stt ${model.id}`, ctx, deps); return; }
    await ensureRuntimeForChoice({ kind: "stt", id: model.id, label: model.label, quality: model.quality, install: model.install }, ctx, deps);
    config = deps.getConfig();
    const stt = model.backend === "faster-whisper"
      ? { ...config.voice?.stt, backend: "faster-whisper" as const, model: model.model, modelPath: model.path, python: configuredPython(config), device: config.voice?.stt?.device ?? "cpu", computeType: config.voice?.stt?.computeType ?? "int8" }
      : { ...config.voice?.stt, backend: "whisper-cpp" as const, model: model.path, binary: config.voice?.stt?.binary ?? "whisper-cli" };
    await save(deps, { ...config, voice: { ...config.voice, enabled: true, stt } });
    ctx.ui.notify(`Selected local STT model: ${model.label}`, "info"); return;
  }
  if (kind === "tts") {
    const model = KNOWN_TTS_MODELS.find((item) => item.id.toLowerCase() === id);
    if (!model) { ctx.ui.notify("Usage: /tg-voice-model tts en_US-lessac-medium|en_US-lessac-high|kokoro-af-heart", "error"); return; }
    if (!existsSync(expandHome(model.path))) { await installModel(`tts ${model.id}`, ctx, deps); return; }
    await ensureRuntimeForChoice({ kind: "tts", id: model.id, label: model.label, quality: model.quality, install: model.install }, ctx, deps);
    config = deps.getConfig();
    const tts = model.backend === "kokoro"
      ? { ...config.voice?.tts, backend: "kokoro" as const, python: config.voice?.tts?.python ?? config.voice?.stt?.python ?? "python3", model: model.path, config: model.config, voice: model.voice, device: config.voice?.tts?.device ?? "cpu", language: model.language ?? "a" }
      : { ...config.voice?.tts, backend: "piper" as const, binary: configuredPiperBinary(config), model: model.path, config: existsSync(expandHome(model.config)) ? model.config : undefined };
    await save(deps, { ...config, voice: { ...config.voice, enabled: true, tts } });
    ctx.ui.notify(`Selected local TTS voice: ${model.label}\nQuality: ${model.quality}`, "info"); return;
  }
  ctx.ui.notify("Usage: /tg-voice-model stt <model> | /tg-voice-model tts <voice>", "error");
}

type InstallChoice = { kind: "stt" | "tts"; id: string; label: string; quality: string; install: VoiceModelInstall }; 

async function installModel(args: string, ctx: { ui: Ui }, deps: VoiceCommandDeps): Promise<void> {
  const choices: InstallChoice[] = [
    ...KNOWN_STT_MODELS.map((model) => ({ kind: "stt" as const, id: model.id, label: `STT · ${model.label} · quality: ${model.quality}`, quality: model.quality, install: model.install })),
    ...KNOWN_TTS_MODELS.map((model) => ({ kind: "tts" as const, id: model.id, label: `TTS · ${model.label} · quality: ${model.quality}`, quality: model.quality, install: model.install })),
  ];
  const requested = args.trim().toLowerCase();
  let choice: InstallChoice | undefined;
  if (requested) {
    const [kind, id] = requested.split(/\s+/, 2);
    if ((kind === "stt" || kind === "tts") && !id) {
      const filtered = choices.filter((item) => item.kind === kind);
      const labels = filtered.map((item) => item.label);
      const selected = await ctx.ui.select(`Choose ${kind.toUpperCase()} model`, labels);
      if (!selected) return;
      choice = filtered[labels.indexOf(selected)];
    } else {
      choice = choices.find((item) => item.kind === kind && item.id.toLowerCase() === id);
    }
    if (!choice) {
      ctx.ui.notify("Usage: /tg-voice-install, /tg-voice-install stt small, or /tg-voice-install tts kokoro-af-heart", "error");
      return;
    }
  } else {
    const labels = choices.map((item) => item.label);
    const selected = await ctx.ui.select("Choose voice model (quality and size shown)", labels);
    if (!selected) return;
    choice = choices[labels.indexOf(selected)];
  }
  if (existsSync(expandHome(choice.install.installedPath))) {
    ctx.ui.notify("That model is already installed; checking its local backend now.", "info");
    await ensureRuntimeForChoice(choice, ctx, deps);
    await selectModel(`${choice.kind} ${choice.id}`, ctx, deps);
    return;
  }
  const source = choice.install.huggingFaceRepo
    ? `Hugging Face repository: ${choice.install.huggingFaceRepo}`
    : "Approved Hugging Face model file(s)";
  const ttsBackend = choice.kind === "tts" ? KNOWN_TTS_MODELS.find((model) => model.id === choice!.id)?.backend : undefined;
  const needsRuntime = choice.kind === "stt"
    ? KNOWN_STT_MODELS.find((model) => model.id === choice!.id)?.backend === "faster-whisper"
    : true;
  const currentConfig = deps.getConfig();
  const python = currentConfig.voice?.tts?.python ?? currentConfig.voice?.stt?.python ?? configuredPython(currentConfig);
  const runtimeReady = !needsRuntime || (ttsBackend === "kokoro"
    ? pythonPackageStatus(python, "kokoro") === "available"
    : choice.kind === "stt"
      ? pythonPackageStatus(python, "faster_whisper") === "available"
      : executableStatus(currentConfig.voice?.tts?.binary ?? configuredPiperBinary(currentConfig)) === "available");
  const runtimeName = ttsBackend === "kokoro" ? "Kokoro/PyTorch" : "faster-whisper/Piper";
  const confirmed = await ctx.ui.confirm(
    `Install ${choice.install.label}?`,
    `Quality: ${choice.quality}\nModel download: ${choice.install.size}\n${source}\nDestination: ${choice.install.installedPath}${needsRuntime && !runtimeReady ? `\nRuntime: ${runtimeName} is missing and will be installed automatically.` : ""}\n\nOnly this allow-listed backend/model will be installed.`, 
  );
  if (!confirmed) return;
  try {
    if (needsRuntime && !runtimeReady) await installRuntime(ttsBackend === "kokoro" ? "kokoro" : "base", ctx, deps, { skipConfirmation: true, throwOnFailure: true });
    ctx.ui.notify(`Starting local download: ${choice.install.label}. This may take a while.`, "info");
    let lastProgress = "";
    await installVoiceModel(choice.install, (progress) => {
      // File-level progress is useful without exposing filenames/URLs or flooding the chat.
      if (progress !== lastProgress) { lastProgress = progress; ctx.ui.notify(progress, "info"); }
    });
    ctx.ui.notify(`✅ Installed ${choice.install.label}. Configuring it now…`, "info");
    await selectModel(`${choice.kind} ${choice.id}`, ctx, deps);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Voice model installation failed: ${reason.slice(0, 300)}`, "error");
  }
}

async function findKokoroPython(): Promise<string> {
  // Kokoro's supported releases require Python 3.8–3.12. Prefer a locally
  // installed interpreter; on NixOS, explicitly build the fixed python312
  // package instead of trying to mutate the system interpreter.
  for (const candidate of ["python3.12", "python3.11", "python3.10", "python3.9"]) {
    try { await runProcess(candidate, ["--version"], 10_000); return candidate; } catch { /* try next */ }
  }
  try {
    const { stdout } = await runProcess("nix", ["build", "--no-link", "--print-out-paths", "nixpkgs#python312"], 600_000);
    const storePath = stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
    if (!/^\/nix\/store\/[^/]+$/.test(storePath)) throw new Error("Nix returned an unsafe Python path");
    const python = join(storePath, "bin", "python3.12");
    await runProcess(python, ["--version"], 10_000);
    return python;
  } catch {
    throw new Error("Kokoro requires Python 3.8–3.12. Install python3.12 locally, or on NixOS ensure nixpkgs#python312 is available, then run setup again.");
  }
}

async function ensureVenvPip(python: string, venv: string): Promise<void> {
  try {
    await runProcess(python, ["-m", "pip", "--version"], 30_000);
    return;
  } catch {
    // A previous `venv` attempt can leave bin/python behind without pip,
    // especially on Debian/Ubuntu when the python3-venv package is missing.
    try {
      await runProcess(python, ["-m", "ensurepip", "--upgrade"], 120_000);
      await runProcess(python, ["-m", "pip", "--version"], 30_000);
      return;
    } catch {
      const packageHint = process.platform === "linux"
        ? "Install the OS venv package (Debian/Ubuntu: sudo apt-get install python3-venv),"
        : "Install a Python distribution that includes ensurepip,";
      throw new Error(`${packageHint} remove the incomplete environment at ${venv}, then retry the voice installation.`);
    }
  }
}

async function installRuntime(args: string, ctx: { ui: Ui }, deps: VoiceCommandDeps, options: { skipConfirmation?: boolean; throwOnFailure?: boolean } = {}): Promise<boolean> {
  const runtime = args.trim().toLowerCase() || "base";
  if (runtime !== "base" && runtime !== "kokoro") {
    ctx.ui.notify("Usage: /tg-voice-runtime-install [kokoro]", "error");
    return false;
  }
  const agentDir = getAgentDir();
  const venv = join(agentDir, runtime === "kokoro" ? "voice-venv-kokoro" : "voice-venv");
  const python = join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const piper = join(venv, process.platform === "win32" ? "Scripts/piper.exe" : "bin/piper");
  const lock = join(agentDir, ".voice-runtime-install.lock");
  let lockAcquired = false;
  const confirmed = options.skipConfirmation || await ctx.ui.confirm(
    runtime === "kokoro" ? "Install local Kokoro runtime?" : "Install local voice runtime?",
    runtime === "kokoro"
      ? `This creates/reuses ${venv} and explicitly downloads fixed Kokoro, PyTorch, and English G2P Python packages from PyPI. Kokoro needs Python 3.8–3.12; on NixOS it may also explicitly build fixed nixpkgs#python312. This can be large. It does not download the Kokoro speech model, install ffmpeg, use sudo, or change your Telegram token.`
      : `This creates ${venv} and explicitly downloads Python packages faster-whisper and piper-tts from PyPI. It does not download speech models, install ffmpeg, use sudo, or change your Telegram token.`,
  );
  if (!confirmed) return false;
  try {
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    try { await mkdir(lock, { mode: 0o700 }); lockAcquired = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("local voice runtime installation is already running");
      throw error;
    }
    if (!existsSync(python)) {
      const seedPython = runtime === "kokoro" ? await findKokoroPython() : "python3";
      ctx.ui.notify(`Creating isolated local Python voice environment (${runtime === "kokoro" ? "Python 3.8–3.12" : "system Python"})…`, "info");
      await runProcess(seedPython, ["-m", "venv", venv], 120_000);
    }
    await ensureVenvPip(python, venv);
    await runProcess(python, ["-m", "pip", "install", "--upgrade", "pip"], 300_000);
    const config = deps.getConfig();
    if (runtime === "kokoro") {
      ctx.ui.notify("Installing local Kokoro runtime and English G2P packages…", "info");
      await runProcess(python, ["-m", "pip", "install", "kokoro==0.7.16", "misaki[en]"], 900_000);
      await save(deps, { ...config, voice: { ...config.voice, tts: { ...config.voice?.tts, python } } });
      ctx.ui.notify(`✅ Local Kokoro runtime installed.\nPython: ${python}\n\nNow use /tg-voice-install and select Kokoro-82M af_heart.`, "info");
    } else {
      ctx.ui.notify("Installing faster-whisper and Piper locally…", "info");
      await runProcess(python, ["-m", "pip", "install", "faster-whisper", "piper-tts"], 600_000);
      await save(deps, {
        ...config,
        voice: {
          ...config.voice,
          stt: { ...config.voice?.stt, python },
          tts: { ...config.voice?.tts, binary: piper },
        },
      });
      const ffmpeg = config.voice?.audio?.ffmpeg ?? "ffmpeg";
      ctx.ui.notify(`✅ Local voice runtime installed.\nPython: ${python}\nPiper: ${piper}\nFFmpeg: ${executableStatus(ffmpeg)}\n\nRun /tg-voice-setup or send a voice note.`, "info");
    }
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Voice runtime installation failed: ${reason.slice(0, 400)}`, "error");
    if (options.throwOnFailure) throw error;
    return false;
  } finally {
    if (lockAcquired) await rm(lock, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function ensureRuntimeForChoice(choice: InstallChoice, ctx: { ui: Ui }, deps: VoiceCommandDeps): Promise<void> {
  const stt = choice.kind === "stt" ? KNOWN_STT_MODELS.find((model) => model.id === choice.id) : undefined;
  const tts = choice.kind === "tts" ? KNOWN_TTS_MODELS.find((model) => model.id === choice.id) : undefined;
  let config = deps.getConfig();
  let python = config.voice?.tts?.python ?? config.voice?.stt?.python ?? configuredPython(config);
  const needsBase = (stt?.backend === "faster-whisper" && pythonPackageStatus(python, "faster_whisper") !== "available")
    || (tts?.backend === "piper" && executableStatus(config.voice?.tts?.binary ?? configuredPiperBinary(config)) !== "available");
  if (needsBase) {
    ctx.ui.notify("Installing the required local faster-whisper/Piper backend…", "info");
    await installRuntime("base", ctx, deps, { skipConfirmation: true, throwOnFailure: true });
    config = deps.getConfig();
    python = config.voice?.tts?.python ?? config.voice?.stt?.python ?? configuredPython(config);
  }
  if (tts?.backend === "kokoro" && pythonPackageStatus(python, "kokoro") !== "available") {
    ctx.ui.notify("Installing the required local Kokoro backend…", "info");
    await installRuntime("kokoro", ctx, deps, { skipConfirmation: true, throwOnFailure: true });
  }
}

async function interactiveSetup(ctx: { ui: Ui }, deps: VoiceCommandDeps): Promise<void> {
  let sttModels = installedSttModels();
  let ttsModels = installedTtsModels();
  // One guided setup flow can provision missing backends and models. Each
  // download still has its explicit confirmation with quality/size/source.
  if (sttModels.length === 0) {
    ctx.ui.notify("Choose an STT model. Its local runtime will be installed automatically if needed.", "info");
    await installModel("stt", ctx, deps);
    sttModels = installedSttModels();
    if (sttModels.length === 0) return;
  }
  if (ttsModels.length === 0) {
    ctx.ui.notify("Choose a TTS voice. Its local runtime will be installed automatically if needed.", "info");
    await installModel("tts", ctx, deps);
    ttsModels = installedTtsModels();
    if (ttsModels.length === 0) return;
  }
  let config = deps.getConfig();
  const sttLabels = sttModels.map((model) => model.label);
  const sttChoice = await ctx.ui.select("Select installed local STT model", sttLabels);
  if (!sttChoice) return;
  const sttModel = sttModels[sttLabels.indexOf(sttChoice)];
  const ttsLabels = ttsModels.map((model) => model.label);
  const ttsChoice = await ctx.ui.select("Select installed local TTS voice", ttsLabels);
  if (!ttsChoice) return;
  const ttsModel = ttsModels[ttsLabels.indexOf(ttsChoice)];
  await ensureRuntimeForChoice({ kind: "stt", id: sttModel.id, label: sttModel.label, quality: sttModel.quality, install: sttModel.install }, ctx, deps);
  await ensureRuntimeForChoice({ kind: "tts", id: ttsModel.id, label: ttsModel.label, quality: ttsModel.quality, install: ttsModel.install }, ctx, deps);
  config = deps.getConfig();
  const replyChoice = await ctx.ui.select("Voice reply mode", ["auto (recommended)", "on (all replies are voice)", "off (text replies only)"]);
  if (!replyChoice) return;
  const replyMode: VoiceReplyMode = replyChoice.startsWith("on") ? "on" : replyChoice.startsWith("off") ? "off" : "auto";
  const stt = sttModel.backend === "faster-whisper"
    ? { ...config.voice?.stt, backend: "faster-whisper" as const, model: sttModel.model, modelPath: sttModel.path, python: configuredPython(config), device: config.voice?.stt?.device ?? "cpu", computeType: config.voice?.stt?.computeType ?? "int8", language: config.voice?.stt?.language ?? "auto" }
    : { ...config.voice?.stt, backend: "whisper-cpp" as const, model: sttModel.path, binary: config.voice?.stt?.binary ?? "whisper-cli", language: config.voice?.stt?.language ?? "auto" };
  const tts = ttsModel.backend === "kokoro"
    ? { ...config.voice?.tts, backend: "kokoro" as const, python: config.voice?.tts?.python ?? config.voice?.stt?.python ?? "python3", model: ttsModel.path, config: ttsModel.config, voice: ttsModel.voice, device: config.voice?.tts?.device ?? "cpu", language: ttsModel.language ?? "a" }
    : { ...config.voice?.tts, backend: "piper" as const, binary: configuredPiperBinary(config), model: ttsModel.path, config: existsSync(expandHome(ttsModel.config)) ? ttsModel.config : undefined };
  await save(deps, { ...config, voice: { ...config.voice, enabled: true, replyMode, stt, tts, audio: { ...config.voice?.audio, ffmpeg: config.voice?.audio?.ffmpeg ?? "ffmpeg", opusBitrate: config.voice?.audio?.opusBitrate ?? "32k" } } });
  ctx.ui.notify(`✅ Local voice setup saved.\n\n${status(deps.getConfig())}`, "info");
}

export function registerVoiceCommands(
  registry: { registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: any) => Promise<void> }) => void },
  deps: VoiceCommandDeps,
): void {
  registry.registerCommand("voice", { description: "Voice reply mode/status", handler: (args, ctx) => setReplyMode(args, ctx, deps) });
  registry.registerCommand("stt", { description: "Show or set local STT language", handler: (args, ctx) => setLanguage(args, ctx, deps) });
  registry.registerCommand("tts", { description: "Show local TTS status", handler: async (args, ctx) => {
    if (args.trim() && args.trim() !== "status") { ctx.ui.notify("Usage: /tts status", "error"); return; }
    ctx.ui.notify(status(deps.getConfig()), "info");
  }});

  // tg-* names are explicit setup commands intended for Telegram's menu and
  // keep the normal /voice shorthand backward-compatible.
  registry.registerCommand("tg-voice-setup", { description: "Configure installed local voice models", handler: async (_args, ctx) => interactiveSetup(ctx, deps) });
    // Advanced direct-install aliases remain callable but stay out of the normal
  // bot menu; /tg-voice-setup and /tg-voice-model provide the guided UX.
  registry.registerCommand("tg-voice-install", { handler: (args, ctx) => installModel(args, ctx, deps) });
  registry.registerCommand("tg-voice-runtime-install", { handler: async (args, ctx) => { await installRuntime(args, ctx, deps); } });
  registry.registerCommand("tg-voice-status", { description: "Show local voice diagnostics", handler: async (_args, ctx) => ctx.ui.notify(status(deps.getConfig()), "info") });
  registry.registerCommand("tg-voice-mode", { description: "Set voice reply mode", handler: (args, ctx) => setReplyMode(args, ctx, deps) });
  registry.registerCommand("tg-voice-model", { description: "Select an installed local voice model", handler: (args, ctx) => selectModel(args, ctx, deps) });
  registry.registerCommand("tg-voice-language", { description: "Set local STT language", handler: async (args, ctx) => setLanguage(`language ${args.trim() || "auto"}`, ctx, deps) });
}
