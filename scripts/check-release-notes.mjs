import assert from "node:assert/strict";
import { extractReleaseNotes } from "./release-notes.mjs";

const section = (tag, body) => `<details>\r\n<summary><strong>${tag}</strong></summary>\r\n\r\n${body}\r\n\r\n</details>`;
const readme = section("v0.3.80", "- 다른 버전") + section("v0.3.8", "- 녹화 옵션\r\n- 결과창 옵션") + section("v0.3.7", "- 이전 버전");
assert.equal(extractReleaseNotes(readme, "v0.3.8"), "- 녹화 옵션\n- 결과창 옵션");
assert.equal(extractReleaseNotes(readme, "v0.3.7"), "- 이전 버전");
assert.throws(() => extractReleaseNotes(readme, "v0.3.9"), /no release notes/);
assert.throws(() => extractReleaseNotes(section("v0.3.8", "  "), "v0.3.8"), /Empty release notes/);
assert.throws(() => extractReleaseNotes(section("v0.3.8 (검증 중)", "- 미완료"), "v0.3.8"), /no release notes/);
console.log("release notes checks passed");
