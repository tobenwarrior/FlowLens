import { resolve } from "node:path";
import { createApiServer } from "./api.ts";
const port = Number(process.env.FLOWLENS_PORT ?? 4319);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("FLOWLENS_PORT must be between 1024 and 65535");
const server = createApiServer({
  dataDir: resolve(".local/cases"),
  distDir: resolve("dist"),
});
server.listen(port, "127.0.0.1", () =>
  process.stdout.write(
    `FlowLens local API and built app: http://127.0.0.1:${port}\n`,
  ),
);
server.on("error", () => {
  process.stderr.write(
    "Could not start local server; check whether the loopback port is already in use.\n",
  );
  process.exitCode = 1;
});
