import { copyFile, mkdir } from "node:fs/promises";

await mkdir("dist/pricing", { recursive: true });
await copyFile("src/pricing/pricing.json", "dist/pricing/pricing.json");
