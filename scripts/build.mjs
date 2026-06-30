import { rm, mkdir, readdir, stat, copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { deflateRawSync } from "node:zlib";

const root = process.cwd();
const srcDir = path.join(root, "src");
const distDir = path.join(root, "dist");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
let buildVersion = process.env.BUILD_VERSION?.trim() || "";

if (!buildVersion) {
  try {
    const taggedRef = execFileSync(
      "git",
      ["describe", "--tags", "--exact-match", "--match", "v*"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    buildVersion = taggedRef.startsWith("v") ? taggedRef.slice(1) : taggedRef;
  } catch {
    buildVersion = packageJson.version;
  }
}

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const tscBin = path.join(root, "node_modules", "typescript", "bin", "tsc");

execFileSync(process.execPath, [tscBin, "-p", "tsconfig.json"], { stdio: "inherit" });

async function copyStaticFiles(fromDir, toDir) {
  const entries = await readdir(fromDir, { withFileTypes: true });
  await mkdir(toDir, { recursive: true });

  for (const entry of entries) {
    const sourcePath = path.join(fromDir, entry.name);
    const targetPath = path.join(toDir, entry.name);

    if (entry.isDirectory()) {
      await copyStaticFiles(sourcePath, targetPath);
      continue;
    }

    if (entry.name.endsWith(".ts")) {
      continue;
    }

    const info = await stat(sourcePath);
    if (info.isFile()) {
      await copyFile(sourcePath, targetPath);
    }
  }
}

await copyStaticFiles(srcDir, distDir);
await copyFile(path.join(root, "manifest.json"), path.join(distDir, "manifest.json"));

if (buildVersion && buildVersion !== packageJson.version) {
  const manifestPath = path.join(distDir, "manifest.json");
  const manifestJson = JSON.parse(await readFile(manifestPath, "utf8"));
  manifestJson.version = buildVersion;
  await writeFile(manifestPath, `${JSON.stringify(manifestJson, null, 2)}\n`);
}

await copyStaticFiles(path.join(root, "node_modules", "@ffmpeg", "ffmpeg", "dist", "esm"), path.join(distDir, "vendor", "ffmpeg", "ffmpeg"));
await mkdir(path.join(distDir, "vendor", "ffmpeg", "core"), { recursive: true });
await copyFile(path.join(root, "node_modules", "@ffmpeg", "core", "dist", "esm", "ffmpeg-core.js"), path.join(distDir, "vendor", "ffmpeg", "core", "ffmpeg-core.js"));
await copyFile(path.join(root, "node_modules", "@ffmpeg", "core", "dist", "esm", "ffmpeg-core.wasm"), path.join(distDir, "vendor", "ffmpeg", "core", "ffmpeg-core.wasm"));

const ffmpegConstPath = path.join(distDir, "vendor", "ffmpeg", "ffmpeg", "const.js");
const ffmpegConst = await readFile(ffmpegConstPath, "utf8");
await writeFile(
  ffmpegConstPath,
  ffmpegConst.replace(
    /export const CORE_URL = .*?;/,
    'export const CORE_URL = "../core/ffmpeg-core.js";',
  ),
);

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const crcTable = makeCrcTable();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosDate, dosTime };
}

async function listFiles(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath, base));
      continue;
    }
    if (entry.isFile()) {
      files.push({
        fullPath,
        name: path.relative(base, fullPath).replaceAll(path.sep, "/"),
      });
    }
  }
  return files;
}

async function writeZip(sourceDir, zipPath) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of await listFiles(sourceDir)) {
    if (file.fullPath === zipPath) {
      continue;
    }

    const data = await readFile(file.fullPath);
    const compressed = deflateRawSync(data);
    const name = Buffer.from(file.name);
    const crc = crc32(data);
    const { dosDate, dosTime } = dosDateTime(new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(centralParts.length / 2, 8);
  end.writeUInt16LE(centralParts.length / 2, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  await writeFile(zipPath, Buffer.concat([...localParts, ...centralParts, end]));
}

await writeZip(distDir, path.join(distDir, `${packageJson.name}-${buildVersion}.zip`));
