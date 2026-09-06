import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { expandHome } from "./config.ts";

export type DirectInstallFile = { url: string; relativePath: string; sha256?: string };
export type VoiceModelInstall = {
  id: string;
  label: string;
  size: string;
  /** Exact file whose presence means this allow-listed model is installed. */
  installedPath: string;
  /** A directory target is atomically renamed; a file target stages each listed file. */
  targetKind: "directory" | "files";
  directFiles?: DirectInstallFile[];
  huggingFaceRepo?: string;
};

export function isVoiceModelInstalled(spec: VoiceModelInstall): boolean {
  const installedPath = expandHome(spec.installedPath);
  if (!existsSync(installedPath)) return false;
  if (spec.targetKind === "directory" || !spec.directFiles) return true;
  const parent = dirname(installedPath);
  return spec.directFiles.every((file) => existsSync(join(parent, safeRelativePath(file.relativePath))));
}

type HubTreeEntry = { type?: string; path?: string; lfs?: { oid?: string } };

function safeRelativePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("installer received an unsafe model file path");
  }
  return normalized;
}

function sha256Transform(hash: ReturnType<typeof createHash>): Transform {
  return new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); } });
}

async function download(url: string, path: string, expectedSha256?: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`download failed (${response.status})`);
  await mkdir(dirname(path), { recursive: true });
  const hash = createHash("sha256");
  await pipeline(Readable.fromWeb(response.body as never), sha256Transform(hash), createWriteStream(path, { flags: "wx" }));
  if (expectedSha256) {
    const actual = hash.digest("hex");
    if (actual.toLowerCase() !== expectedSha256.replace(/^sha256:/i, "").toLowerCase()) {
      await rm(path, { force: true });
      throw new Error("download checksum verification failed");
    }
  }
}

async function hubFiles(repo: string): Promise<DirectInstallFile[]> {
  // Hugging Face's public tree endpoint is used only for an allow-listed repo;
  // returned paths are validated before being written under the staging root.
  const safeRepo = repo.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`https://huggingface.co/api/models/${safeRepo}/tree/main?recursive=true&expand=false`);
  if (!response.ok) throw new Error(`could not inspect approved model repository (${response.status})`);
  const entries = await response.json() as HubTreeEntry[];
  if (!Array.isArray(entries)) throw new Error("approved model repository returned an invalid file list");
  return entries
    .filter((entry) => entry.type === "file" && entry.path && entry.path !== ".gitattributes")
    .map((entry) => {
      const path = safeRelativePath(entry.path!);
      return {
        relativePath: path,
        url: `https://huggingface.co/${repo}/resolve/main/${path.split("/").map(encodeURIComponent).join("/")}`,
        sha256: entry.lfs?.oid,
      };
    });
}

/**
 * Installs one fixed, public model chosen by an authorized user. There is no
 * arbitrary URL, archive extraction, shell execution, or token involved.
 */
export async function installVoiceModel(spec: VoiceModelInstall, onProgress: (message: string) => void): Promise<void> {
  const installedPath = expandHome(spec.installedPath);
  if (isVoiceModelInstalled(spec)) throw new Error(`already installed: ${spec.installedPath}`);
  const parent = dirname(installedPath);
  const lock = `${installedPath}.install.lock`;
  await mkdir(parent, { recursive: true, mode: 0o700 });
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("this model installation is already running");
    throw error;
  }
  const staging = join(parent, `.pi-tg-voice-${randomUUID()}`);
  try {
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const files = spec.directFiles ?? await hubFiles(spec.huggingFaceRepo!);
    if (files.length === 0) throw new Error("approved model repository contains no downloadable files");
    // A manually interrupted or older install may contain only some of a
    // multi-file model. Keep verified existing files and fetch only what is
    // missing so the normal install command can repair it.
    const missingFiles = spec.targetKind === "files"
      ? files.filter((file) => !existsSync(join(parent, safeRelativePath(file.relativePath))))
      : files;
    for (let index = 0; index < missingFiles.length; index++) {
      const file = missingFiles[index];
      const output = resolve(staging, safeRelativePath(file.relativePath));
      if (relative(staging, output).startsWith("..")) throw new Error("installer blocked an unsafe destination");
      onProgress(`Downloading ${spec.label}: file ${index + 1}/${missingFiles.length}`);
      await download(file.url, output, file.sha256);
    }
    if (spec.targetKind === "directory") {
      await mkdir(dirname(installedPath), { recursive: true });
      await rename(staging, installedPath);
    } else {
      // Move the configured presence marker last. A crash can at worst leave
      // supporting metadata behind; it cannot make a partial model look ready.
      const stagedFiles = [...missingFiles].sort((a, b) => {
        const aMarker = join(parent, safeRelativePath(a.relativePath)) === installedPath ? 1 : 0;
        const bMarker = join(parent, safeRelativePath(b.relativePath)) === installedPath ? 1 : 0;
        return aMarker - bMarker;
      });
      for (const file of stagedFiles) {
        const source = resolve(staging, safeRelativePath(file.relativePath));
        const destination = join(parent, safeRelativePath(file.relativePath));
        await mkdir(dirname(destination), { recursive: true });
        await rename(source, destination);
      }
      await rm(staging, { recursive: true, force: true });
    }
    if (!isVoiceModelInstalled(spec)) throw new Error("installation finished without all expected model files");
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
