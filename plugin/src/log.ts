// Every log line goes to stderr: stdout is the MCP transport. Callers never pass the token.

export function makeLogger(component: string) {
  return (...parts: unknown[]) => {
    const text = parts
      .map((p) => (p instanceof Error ? p.message : typeof p === 'string' ? p : JSON.stringify(p)))
      .join(' ');
    process.stderr.write(`[team-relay ${component}] ${text}\n`);
  };
}
