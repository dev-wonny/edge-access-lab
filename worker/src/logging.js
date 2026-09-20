// Identity fields belong to the emitter, never to request-controlled data.
function emit(level, fields) {
  const entry = {
    ...fields,
    service: "edge-access-lab-worker",
    runtime: "cloudflare-workers",
    component: "edge",
    timestamp: new Date().toISOString(),
    level,
  };
  const output = level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log;
  output(JSON.stringify(entry));
}

export const log = {
  info: (fields) => emit("INFO", fields),
  warn: (fields) => emit("WARN", fields),
  error: (fields) => emit("ERROR", fields),
};
