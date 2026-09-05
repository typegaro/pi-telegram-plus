import { spawn } from "node:child_process";

/** Preserve NixOS's explicitly configured native-library search path for local wheels/binaries. */
export function nativeLibraryEnvironment(): NodeJS.ProcessEnv {
  const nixLibraries = process.env.NIX_LD_LIBRARY_PATH;
  if (!nixLibraries) return process.env;
  return {
    ...process.env,
    LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ? `${nixLibraries}:${process.env.LD_LIBRARY_PATH}` : nixLibraries,
  };
}

export async function runProcess(command: string, args: string[], timeoutMs: number, input?: string): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true, env: nativeLibraryEnvironment() });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve({ stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (error) => finish(new Error(`${command} is unavailable: ${error.message}`)));
    child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.on("close", (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(`${command} failed (${signal ?? code}): ${stderr.trim().slice(0, 500) || "no diagnostic"}`));
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}
