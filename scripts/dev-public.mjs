// Dev helper: opens a Cloudflare quick tunnel to the API, then starts the API
// with PUBLIC_URL set to it, so PayPal webhooks reach this machine. The API
// points the PayPal webhook at the new URL on boot.
//   pnpm dev:public
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const WINDOWS_DEFAULT = "C:Program Files (x86)cloudflaredcloudflared.exe";
const bin =
  process.platform === "win32" && existsSync(WINDOWS_DEFAULT) ? WINDOWS_DEFAULT : "cloudflared";
const port = process.env.PORT ?? "3000";

const tunnel = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`], {
  stdio: ["ignore", "pipe", "pipe"],
});
let api = null;

function onOutput(chunk) {
  const url = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
  if (!url || api) return;
  console.log(`\nTunnel: ${url}\nStarting API with PUBLIC_URL=${url}\n`);
  api = spawn("pnpm", ["dev:api"], {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, PUBLIC_URL: url },
  });
  api.on("exit", (code) => {
    tunnel.kill();
    process.exit(code ?? 0);
  });
}
tunnel.stdout.on("data", onOutput);
tunnel.stderr.on("data", onOutput);
tunnel.on("exit", (code) => {
  console.error(
    `cloudflared exited (${code}). Is it installed? https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/`,
  );
  api?.kill();
  process.exit(1);
});
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    api?.kill();
    tunnel.kill();
    process.exit(0);
  });
}
