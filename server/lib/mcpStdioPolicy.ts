type StdioConfig = { command: string | null; args?: unknown; env?: unknown };

export function approvedStdioConfig(config: StdioConfig) {
  let approved: StdioConfig[];
  try {
    approved = JSON.parse(process.env.BLINKO_MCP_STDIO_ALLOWLIST || "[]");
  } catch {
    throw new Error("Invalid server-side MCP stdio allowlist");
  }
  if (!Array.isArray(approved))
    throw new Error("Invalid server-side MCP stdio allowlist");
  const args = config.args ?? [];
  const env = config.env ?? {};
  if (
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== "string") ||
    typeof env !== "object" ||
    Array.isArray(env)
  )
    throw new Error("Invalid MCP stdio configuration");
  const sameEnv = (a: any, b: any) => {
    const keys = Object.keys(a).sort();
    return (
      JSON.stringify(keys) === JSON.stringify(Object.keys(b).sort()) &&
      keys.every((key) => typeof a[key] === "string" && a[key] === b[key])
    );
  };
  const match = approved.find(
    (item) =>
      item.command === config.command &&
      JSON.stringify(item.args ?? []) === JSON.stringify(args) &&
      sameEnv(item.env ?? {}, env),
  );
  if (!match || !config.command)
    throw new Error(
      "This MCP stdio command, arguments and environment have not been approved by the server operator",
    );
  // Do not copy database passwords, signing secrets and provider keys from the
  // entire application environment into an approved child process.
  const inherited = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "TEMP", "SystemRoot"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]!]] : [],
    ),
  );
  return {
    command: config.command,
    args: args as string[],
    env: { ...inherited, ...(env as Record<string, string>) },
  };
}
