import { relative } from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = fileURLToPath(new URL("../tests/browser/", import.meta.url));
const requiredChecks = {
  "extension.spec.mjs": [
    "webm stop releases capture immediately while messages and storage are delayed",
    "mp4 stop releases capture immediately while messages and storage are delayed",
    "screen recording is recovered if a stored checkpoint reply is lost",
    "a saved result unlocks recording when the final reply is lost",
    "screen recording is saved if the recorder stop event is lost",
    "recording timers wait for capture and keep size visible after original fallback",
    "MP4 recording, splitting, speed, GIF and frame exports work",
    "the browser action popup opens at full height",
    "shortcut tab supports navigation, changing keys and cancelling key entry",
    "missing and malformed settings recover in the popup and player",
    "settings updates preserve an unfinished bitrate edit and other preferences",
    "rapid bitrate increases keep the latest value while storage catches up",
    "failed bitrate saves restore the value shown in the focused input",
    "rapid automatic split threshold steps keep the latest value",
    "popup settings work with an older background that cannot update settings",
    "popup settings persist and only the recording size toggle stays editable during capture",
    "result delivery reuses its tab after a failed state write",
    "automatic download with missing data shows the error and unlocks recording",
    "failed automatic download keeps the recorded video available in the result tab",
    "automatic download respects the result tab preference and does not repeat on reload",
    "a download requested during preparation uses the same file as the result",
    "a download requested during preparation uses the same file as the result if preview metadata is delayed",
    "full screen recording waits for a pending bitrate change and keeps native resolution",
    "delayed starts preserve stop/cancel intent and respond immediately",
    "borders follow scrolling, replacement videos and mini-player transitions",
    "real recordings survive mini-player moves, split and recover a failed checkpoint",
  ],
  "player-tools.spec.mjs": [
    "player controls return after the live room is rebuilt without navigation",
    "a cloned player toolbar restores working controls",
    "a late region read cannot restore borders in the clip editor",
    "screenshots release their image data when the clip editor opens",
    "seek feedback shows the movement available at the beginning of the video",
    "full recording and screenshot shortcuts work with their buttons hidden",
  ],
  "recording-cancel.spec.mjs": [
    "full recording cancellation releases encoders without a stop callback",
  ],
  "recording-deletion.spec.mjs": [
    "33-second recording data expires after result close and retries failed deletion",
    "lost deletion alarms are restored across a real browser restart",
  ],
  "recording-startup.spec.mjs": [
    "ready broadcast originals record without starting the screen encoder",
    "a recording with audio before its first video frame opens on video",
    "recording keeps the opening frames when the display clock is rounded",
    "WebM recording keeps middle frames when timer sampling is delayed",
    "WebM keeps recording when foreground frame callbacks are delayed",
    "WebM download repairs a dropped interval and preserves the recorded file",
    "MP4 recording keeps middle frames when timer sampling is delayed",
    "MP4 recording uses H.265 only for a confirmed H.265 source",
    "webm download inspects opening timestamps even without a capture stall marker",
    "WebM download detects a single startup gap after half a second",
    "WebM download preserves a continuous opening despite a capture stall marker",
    "mp4 download inspects opening timestamps even without a capture stall marker",
    "full H.264 webm recordings exclude a stalled opening and keep short originals",
    "full H.264 mp4 recordings exclude a stalled opening and keep short originals",
  ],
  "recording-tabs.spec.mjs": [
    "other tabs lock all recording controls and unlock after the owner stops",
    "the owner can queue stop and cancel while the region encoder starts",
    "rapid region deletions apply to the latest saved list",
  ],
  "split-start.spec.mjs": [
    "automatic splitting shares the result settings and downloads only the requested files",
    "screen recording fallback keeps its notice distinct from an automatic split timeout",
    "original MP4 playback cap preserves the start and media bytes",
    "large WebM seek metadata is prepared on disk and remains playable after cleanup",
    "large original survives disk errors and a closed result without a RAM fallback",
    "large normal MP4 edits download from disk without reading full outputs into the worker",
    "WebM to MP4 splits start with independently decodable video",
    "WebM splits begin with playable video even between source keyframes",
    "size split retries reuse one prepared source and recover from failure",
    "split downloads finish in reverse order for newest-first folder sorting",
  ],
};

export default class RequiredBrowserChecks {
  onBegin(_config, suite) {
    this.suite = suite;
  }

  onEnd() {
    const testsByName = new Map();
    for (const test of this.suite?.allTests() ?? []) {
      const file = relative(testDirectory, test.location.file).replaceAll("\\", "/");
      const name = `${file} › ${test.title}`;
      const tests = testsByName.get(name) ?? [];
      tests.push(test);
      testsByName.set(name, tests);
    }

    const missing = [];
    let checked = 0;
    for (const [file, titles] of Object.entries(requiredChecks)) {
      for (const title of titles) {
        const name = `${file} › ${title}`;
        const tests = testsByName.get(name);
        if (tests?.every(test => test.expectedStatus === "passed" && test.outcome() === "expected")) {
          checked++;
        } else {
          missing.push(name);
        }
      }
    }
    if (missing.length) {
      console.error(`\nRequired browser checks passed: ${checked}/${checked + missing.length}\n  ${missing.join("\n  ")}`);
      return { status: "failed" };
    }
    console.log(`\nRequired browser checks passed: ${checked}/${checked}`);
  }
}
