import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const appRoot = process.cwd();
const source = resolve(appRoot, "dist");
const target = resolve(appRoot, "..", ".cesium_demo", "dist");

await rm(target, { recursive: true, force: true });
await mkdir(resolve(target, ".."), { recursive: true });
await cp(source, target, { recursive: true });
