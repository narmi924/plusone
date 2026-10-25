// Try the camera reader on still images: tsx --env-file=../../.env src/ai/eyes-try.ts a.jpg b.jpg
import { readFileSync } from "node:fs";
import type { SessionDTO } from "@plusone/shared";
import { createHostEyes } from "./hostEyes.js";

const session = (await (
  await fetch(`${process.env.API_URL ?? "http://localhost:3000"}/api/live/lumicloset`)
).json()) as SessionDTO;
const look = createHostEyes(process.env.ANTHROPIC_API_KEY ?? "");
for (const file of process.argv.slice(2)) {
  const { seen, ms } = await look({
    jpegBase64: readFileSync(file).toString("base64"),
    products: session.products,
    onScreen: "A1 Linen Wrap Dress",
  });
  console.log(file.split(/[\\/]/).pop(), ms, "ms", JSON.stringify(seen));
}
