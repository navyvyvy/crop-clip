import { readFile, writeFile, appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function extractReleaseNotes(readme, tag) {
  const sections = readme.matchAll(/<details>\s*<summary><strong>([^<]+)<\/strong><\/summary>([\s\S]*?)<\/details>/g);
  for (const [, version, content] of sections) {
    if (version.trim() !== tag) continue;
    const notes = content.replace(/\r\n/g, "\n").trim();
    if (!notes) throw new Error(`Empty release notes for ${tag}`);
    return notes;
  }
  throw new Error(`README.md has no release notes for ${tag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version } = JSON.parse(await readFile("package.json", "utf8"));
  const tag = process.env.RELEASE_TAG || `v${version}`;
  if (tag !== `v${version}`) throw new Error(`Release tag ${tag} does not match package version ${version}`);
  const notes = extractReleaseNotes(await readFile("README.md", "utf8"), tag);
  await writeFile("dist/release-notes.txt", `${notes}\n`, "utf8");
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `tag=${tag}\n`, "utf8");
  console.log(`Prepared release notes for ${tag}`);
}
