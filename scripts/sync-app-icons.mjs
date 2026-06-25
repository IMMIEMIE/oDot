import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = join(root, "src-tauri", "icons");
const publicDir = join(root, "apps", "desktop", "public");

mkdirSync(publicDir, { recursive: true });
copyFileSync(join(iconsDir, "32x32.png"), join(publicDir, "favicon.png"));
copyFileSync(join(iconsDir, "icon.ico"), join(publicDir, "favicon.ico"));
