import path from "node:path";
import fs from "node:fs/promises";

export const pluginNamePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export function pluginDirectory(
  name: string,
  base = path.resolve(".blinko", "plugins"),
) {
  if (!pluginNamePattern.test(name)) throw new Error("Invalid plugin name");
  return path.join(base, name);
}

export async function containedPluginPath(base: string, relative: string) {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.includes("\0")
  )
    throw new Error("Invalid plugin path");
  const target = path.resolve(base, relative);
  const parts = path.relative(base, target).split(path.sep);
  if (target === base || parts[0] === "..")
    throw new Error("Plugin path escapes its directory");
  // Reject existing symlinks anywhere below the trusted base, including the
  // plugin directory itself, before writes, reads, extraction or cleanup.
  let current = base;
  for (const part of ["", ...parts]) {
    if (part) current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw new Error("Plugin symlinks are not allowed");
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return target;
}
