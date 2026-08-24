import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const sourceText = fs.readFileSync(new URL("../src/content/region_selector.ts", import.meta.url), "utf8");
const sourceFile = ts.createSourceFile("region_selector.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const serviceWorkerText = fs.readFileSync(new URL("../src/background/service_worker.ts", import.meta.url), "utf8");
const serviceWorkerFile = ts.createSourceFile("service_worker.ts", serviceWorkerText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const resultText = fs.readFileSync(new URL("../src/result/result.ts", import.meta.url), "utf8");
const settingsText = fs.readFileSync(new URL("../src/shared/types.ts", import.meta.url), "utf8");
const storageText = fs.readFileSync(new URL("../src/shared/storage.ts", import.meta.url), "utf8");
const messagesText = fs.readFileSync(new URL("../src/shared/messages.ts", import.meta.url), "utf8");
const idbText = fs.readFileSync(new URL("../src/shared/idb.ts", import.meta.url), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
assert.equal(manifest.content_scripts[0].exclude_matches, undefined);
assert.match(sourceText, /function suspendPlayerTools\(\)/);
assert.match(sourceText, /currententrychange/);
assert.match(sourceText, /chzzkToolObserver\.observe\(controlsRoot, \{ childList: true, subtree: true \}\)/);
assert.doesNotMatch(sourceText, /chzzkToolObserver\.observe\(observerRoot/);
assert.match(sourceText, /button\.dataset\.cropClipContent === contentKey/);
assert.doesNotMatch(sourceText, /mutationTouchesChzzkPlayer/);
assert.doesNotMatch(sourceText, /setInterval\(updateRecordButton/);
assert.doesNotMatch(sourceText, /setInterval\(\(\) => requestChzzkToolSync/);
assert.doesNotMatch(sourceText, /chzzkToolObserver\.observe\(document\.body/);
assert.match(sourceText, /CHZZK_TOOL_DISCOVERY_INTERVAL_MS/);
assert.match(sourceText, /const buttons = getPzpButtons\(host\);\s*const reference = buttons\.find\(isVisibleElement\) \?\? buttons\[0\]/);
assert.match(sourceText, /if \(!host\) \{\s*startChzzkToolDiscovery\(\);\s*return;\s*\}/);
assert.match(sourceText, /const toolHost = findChzzkButtonHost\(\);\s*syncChzzkToolButton\(toolHost\)/);
assert.match(sourceText, /function mutationAddsChzzkButtonHost\(records: MutationRecord\[\]\)/);
assert.doesNotMatch(sourceText, /regionLayoutTimerId/);
assert.match(sourceText, /new ResizeObserver\(requestRegionLayoutSync\)/);
assert.match(sourceText, /if \(!toolHost\.isConnected \|\| missingExpectedButton\) \{\s*syncPlayerToolsForLocation\(\);\s*\} else if \(mutationAddsChzzkButtonHost\(records\) && findChzzkButtonHost\(\) !== toolHost\)/);
assert.match(sourceText, /if \(style\.textContent !== css\)/);
assert.match(sourceText, /applyBorderGeometry\(border, region, renderedRect\)/);
assert.match(sourceText, /const bounds = selectionBounds;/);
assert.match(sourceText, /getContext\("2d", \{ alpha: false, desynchronized: true \}\)/);
assert.ok(sourceText.indexOf("const canvasStream = canvas.captureStream(frameRate);") < sourceText.indexOf("paintPlacements(layout.placements);"));
assert.doesNotMatch(sourceText, /document\.documentElement\.appendChild\(canvas\)/);
assert.doesNotMatch(sourceText, /overlayObserver\.observe\(document\.documentElement, \{ childList: true, subtree: true \}\)/);
assert.match(sourceText, /window\.addEventListener\("scroll", requestRegionLayoutSync, \{ capture: true, passive: true \}\)/);
assert.doesNotMatch(sourceText, /window\.addEventListener\("scroll", \(\) => syncRegionLayoutGeometry/);
assert.match(sourceText, /function bindDirectPlayerActivation\(/);
assert.doesNotMatch(sourceText, /function bindDirectPlayer(?:Screenshot|Tool|Record|Cancel)Activation\(/);
assert.match(sourceText, /video\.readyState >= HTMLMediaElement\.HAVE_CURRENT_DATA/);
assert.doesNotMatch(sourceText, /visibleArea === 0/);
assert.match(serviceWorkerText, /RESULT_TAB_RETRY_ALARM = "open-recording-result"/);
assert.match(serviceWorkerText, /if \(state\.recordingState\.status === RECORDING_STATUS\.completed\)[\s\S]*?ensureCompletedRecordingResult/);
assert.match(serviceWorkerText, /checkpointStores = new Map<string, Promise<void>>\(\)/);
assert.match(serviceWorkerText, /recordingTerminalOperations = new Map<string, Promise<void>>\(\)/);
assert.match(serviceWorkerText, /RECOVERY_FINALIZE_ATTEMPTS = 3/);
assert.match(serviceWorkerText, /runRecordingTerminalOperation\(recordingId, \(\) => finalizeRecordingFromChunksUnlocked/);
assert.match(serviceWorkerText, /await checkpointStores\.get\(recordingId\)/);
assert.match(serviceWorkerText, /async function recoverRecording\(recordingId: string, endedAt: number\): Promise<boolean>/);
assert.match(serviceWorkerText, /state\.status === RECORDING_STATUS\.completed && state\.recordingId === recordingId/);
assert.match(serviceWorkerText, /previousState\.status === RECORDING_STATUS\.completed && previousState\.recordingId === recording\.id/);
assert.match(serviceWorkerText, /recordingState\.resultTabId/);
assert.match(serviceWorkerText, /recoverResultAfterTabExit\(tabId, removeInfo\.isWindowClosing\)/);
assert.match(serviceWorkerText, /state\.status === RECORDING_STATUS\.completed\) \{\s*await ensureCompletedRecordingResult/);
assert.match(serviceWorkerText, /chunk\.index !== index \+ 1/);
assert.match(serviceWorkerText, /chunks\.at\(-1\)\?\.completesBlob === false/);
assert.match(sourceText, /function readBlobAsDataUrl\(/);
assert.match(sourceText, /if \(event\.data\.size <= 0 \|\| session\.cancelRequested\)/);
assert.match(sourceText, /if \(session\.cancelRequested\) \{\s*return;\s*\}\s*const dataUrl = await readBlobAsDataUrl/);
assert.match(messagesText, /dataUrl: string/);
assert.doesNotMatch(serviceWorkerText, /message\.chunk\.objectUrl/);
assert.match(resultText, /function startDeletionKeepalive\(\)/);
assert.match(resultText, /window\.addEventListener\("pageshow"/);
assert.doesNotMatch(resultText, /createDurationSplitWithRecorder/);
assert.match(resultText, /"-break_non_keyframes", "1"/);
assert.match(resultText, /function getSplitPresetValue\(/);
assert.match(resultText, /Math\.ceil\(roundTrimTime\(range\.end - range\.start\) \* ratio\)/);
assert.match(resultText, /querySelectorAll<HTMLButtonElement>\("\[data-split-mode\]"\)/);
assert.match(resultText, /빠른 변환을 지원하지 않아 실시간으로 처리 중입니다/);
assert.match(settingsText, /enableAutoDownloadRecording: false/);
assert.match(settingsText, /enableAutoDownloadSplit: false/);
assert.match(storageText, /enableAutoDownloadRecording: Boolean\(raw\?\.enableAutoDownloadRecording\)/);
assert.match(storageText, /enableAutoDownloadSplit: Boolean\(raw\?\.enableAutoDownloadSplit\)/);
assert.match(storageText, /resultTabId: Number\.isFinite\(raw\?\.resultTabId as number\)/);
assert.match(serviceWorkerText, /autoDownload=1/);
assert.match(serviceWorkerText, /active: !settings\.enableAutoDownloadRecording/);
assert.match(messagesText, /AUTO_DOWNLOAD_HANDLED/);
assert.ok(manifest.permissions.includes("downloads"));
assert.match(resultText, /function waitForDownloadCompletion\(/);
assert.match(resultText, /if \(autoDownloadRecording\) \{\s*await downloadSourcesAndConfirm/);
assert.match(resultText, /await downloadSourcesAndConfirm\([\s\S]*?await markAutoDownloadHandled\(\);\s*allowRecordingDeletion = true;\s*window\.close\(\)/);
assert.match(resultText, /let restoreSourceTabOnClose = !autoDownloadRecording/);
assert.match(resultText, /function restoreSourceTab\(\): void \{\s*if \(!restoreSourceTabOnClose\) \{\s*return;/);
assert.match(resultText, /if \(autoDownloadRecording && parts\.length === 0\) \{\s*throw new Error/);
assert.match(resultText, /async function revealAutoDownloadFailure\(\): Promise<void>/);
assert.match(resultText, /restoreSourceTabOnClose = true/);
assert.match(resultText, /await markAutoDownloadHandled\(\);\s*allowRecordingDeletion = true;\s*startDeletionKeepalive\(\)/);
assert.match(resultText, /if \(allowRecordingDeletion\) \{\s*void scheduleRecordingDeletion\(\)/);
assert.match(resultText, /if \(autoDownloadSplit\) \{\s*await downloadSourcesSequentially/);
assert.doesNotMatch(messagesText, /CANCEL_RECORDING_DELETION/);
assert.doesNotMatch(idbText, /openKeyCursor/);
assert.match(idbText, /\.openCursor\(IDBKeyRange\.only\(recordingId\)\)/);
const functionNames = new Set([
  "computeDirectOutput",
  "scaleLayout",
  "composeHorizontal",
  "composeVertical",
  "getPairLayoutDirection",
  "getGroupedLayout",
  "computeDirectLayout",
  "computeResizedEdges",
  "getResizeFocusPoint",
  "getStreamerNameFromTitle",
  "buildDirectFilename",
  "getFinalRecordingEndedAt",
  "decodeRecordingDataUrl",
  "getRecordingChunkSliceRanges",
  "runRecordingTerminalOperation",
  "normalizeRecordingState",
  "regionEdges",
  "clamp",
]);
const selectedStatements = [];
function collectStatements(node, file) {
  if (ts.isFunctionDeclaration(node) && node.name && functionNames.has(node.name.text)) {
    selectedStatements.push(node.getText(file));
    return;
  }
  ts.forEachChild(node, (child) => collectStatements(child, file));
}
collectStatements(sourceFile, sourceFile);
collectStatements(serviceWorkerFile, serviceWorkerFile);
const statements = selectedStatements.join("\n");
const runtime = ts.transpileModule(`const recordingTerminalOperations = new Map();\nconst RECORDING_STATUS = { idle: "idle", recording: "recording", completed: "completed", error: "error" };\nconst RECORDING_MODE = { region: "region", full: "full" };\n${statements}\nreturn { computeDirectLayout, scaleLayout, computeResizedEdges, getResizeFocusPoint, getStreamerNameFromTitle, buildDirectFilename, getFinalRecordingEndedAt, decodeRecordingDataUrl, getRecordingChunkSliceRanges, runRecordingTerminalOperation, normalizeRecordingState };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const { computeDirectLayout, scaleLayout, computeResizedEdges, getResizeFocusPoint, getStreamerNameFromTitle, buildDirectFilename, getFinalRecordingEndedAt, decodeRecordingDataUrl, getRecordingChunkSliceRanges, runRecordingTerminalOperation, normalizeRecordingState } = new Function(runtime)();

assert.equal(getStreamerNameFromTitle("치지직 게임 - CHZZK"), "치지직 게임");
assert.equal(getStreamerNameFromTitle("치지직 스포츠 - CHZZK"), "치지직 스포츠");
assert.equal(getStreamerNameFromTitle("치지직 배구 중계 - CHZZK"), "치지직 배구 중계");
assert.equal(getStreamerNameFromTitle("치지직 - CHZZK"), "치지직");
assert.equal(getStreamerNameFromTitle("Streamer | CHZZK"), "Streamer");
assert.equal(buildDirectFilename("streamer_20260717_120000", "webm", 1_000, 43_400), "streamer_20260717_120000_42s.webm");
assert.equal(buildDirectFilename("streamer_20260717_120000", "webm", 1_000, 66_000), "streamer_20260717_120000_1m05s.webm");
assert.equal(buildDirectFilename("streamer_20260717_120000", "mp4", 1_000, 3_724_000), "streamer_20260717_120000_1h02m03s.mp4");
assert.equal(getFinalRecordingEndedAt(1_000, 10_000, 10_100), 10_000);
assert.equal(getFinalRecordingEndedAt(1_000, 60_000, 10_000), 10_000);
assert.equal(getFinalRecordingEndedAt(1_000, 10_000), 10_000);
const decodedCheckpoint = decodeRecordingDataUrl("data:video/webm;codecs=vp8,opus;base64,AQID", "video/webm;codecs=vp8,opus");
assert.equal(decodedCheckpoint.type, "video/webm;codecs=vp8,opus");
assert.equal(decodedCheckpoint.size, 3);
const largeRecordingSize = 70 * 1024 * 1024;
const safeMessageBlobSize = 8 * 1024 * 1024;
const chunkSliceRanges = getRecordingChunkSliceRanges(largeRecordingSize, safeMessageBlobSize);
assert.equal(chunkSliceRanges.length, 9);
assert.equal(chunkSliceRanges[0].start, 0);
assert.equal(chunkSliceRanges.at(-1).end, largeRecordingSize);
assert.ok(chunkSliceRanges.every(({ start, end }) => end - start <= safeMessageBlobSize));
assert.ok(chunkSliceRanges.every(({ start, end }, index) => start === (chunkSliceRanges[index - 1]?.end ?? 0)));
let releaseFirstTerminalOperation;
const terminalOrder = [];
const firstTerminalOperation = runRecordingTerminalOperation("same-recording", async () => {
  terminalOrder.push("first-start");
  await new Promise((resolve) => {
    releaseFirstTerminalOperation = resolve;
  });
  terminalOrder.push("first-end");
  return 1;
});
const secondTerminalOperation = runRecordingTerminalOperation("same-recording", async () => {
  terminalOrder.push("second");
  return 2;
});
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(terminalOrder, ["first-start"]);
releaseFirstTerminalOperation();
assert.deepEqual(await Promise.all([firstTerminalOperation, secondTerminalOperation]), [1, 2]);
assert.deepEqual(terminalOrder, ["first-start", "first-end", "second"]);
assert.deepEqual(normalizeRecordingState({ status: "recording", recordingId: "recording-tab", startedAt: 1_000, mode: "full" }, "other-tab"), { status: "idle" });
assert.deepEqual(normalizeRecordingState({ status: "recording", recordingId: "recording-tab", startedAt: 1_000, mode: "full" }, "recording-tab"), { status: "recording", startedAt: 1_000, mode: "full" });
const resizeStart = { left: 100, top: 100, right: 300, bottom: 200 };
const resizeBounds = { left: 0, top: 0, right: 500, bottom: 500 };
assert.deepEqual(computeResizedEdges(resizeStart, "e", 50, 0, resizeBounds, 50, 50, true, false), {
  left: 100, top: 87.5, right: 350, bottom: 212.5,
});
assert.deepEqual(computeResizedEdges(resizeStart, "e", 50, 0, resizeBounds, 50, 50, false, true), {
  left: 50, top: 100, right: 350, bottom: 200,
});
assert.deepEqual(computeResizedEdges(resizeStart, "se", 50, 0, resizeBounds, 50, 50, true, true), {
  left: 50, top: 75, right: 350, bottom: 225,
});
assert.deepEqual(computeResizedEdges(resizeStart, "se", 500, 500, resizeBounds, 50, 50, true, true), {
  left: 0, top: 50, right: 400, bottom: 250,
});
assert.deepEqual(computeResizedEdges(resizeStart, "e", -500, 0, resizeBounds, 50, 50, true, false), {
  left: 100, top: 125, right: 200, bottom: 175,
});
const focusRegion = { x: 100, y: 100, width: 200, height: 100 };
assert.deepEqual(getResizeFocusPoint(focusRegion, "e", 309, 140), { x: 300, y: 140 });
assert.deepEqual(getResizeFocusPoint(focusRegion, "n", 150, 89), { x: 150, y: 100 });
assert.deepEqual(getResizeFocusPoint(focusRegion, "se", 309, 209), { x: 300, y: 200 });

function permutations(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) => permutations(items.filter((_, current) => current !== index))
    .map((rest) => [item, ...rest]));
}

function placementMap(layout) {
  return Object.fromEntries(layout.placements.map((placement) => [placement.crop.id, placement]));
}

function assertValid(layout, expectedCount) {
  assert.equal(layout.placements.length, expectedCount);
  for (const placement of layout.placements) {
    assert.ok(placement.dx >= 0 && placement.dy >= 0 && placement.dw > 0 && placement.dh > 0);
    assert.ok(placement.dx + placement.dw <= layout.output.width);
    assert.ok(placement.dy + placement.dh <= layout.output.height);
  }
  for (let first = 0; first < layout.placements.length; first += 1) {
    for (let second = first + 1; second < layout.placements.length; second += 1) {
      const a = layout.placements[first];
      const b = layout.placements[second];
      const overlapX = Math.min(a.dx + a.dw, b.dx + b.dw) - Math.max(a.dx, b.dx);
      const overlapY = Math.min(a.dy + a.dh, b.dy + b.dh) - Math.max(a.dy, b.dy);
      assert.ok(overlapX <= 0 || overlapY <= 0, `${a.crop.id} and ${b.crop.id} overlap`);
    }
  }
}

function assertScaledValid(layout, expectedCount) {
  const scale = 0.613;
  assertValid({
    output: {
      width: Math.max(1, Math.round(layout.output.width * scale)),
      height: Math.max(1, Math.round(layout.output.height * scale)),
    },
    placements: scaleLayout(layout, scale, 0, 0),
  }, expectedCount);
}

function assertMixedLayout(crops, pairRules, groupOrder, outerDirection) {
  const expectedSignature = (() => {
    const layout = computeDirectLayout(crops);
    assertValid(layout, crops.length);
    assertScaledValid(layout, crops.length);
    return JSON.stringify(placementMap(layout));
  })();

  for (const ordered of permutations(crops)) {
    const layout = computeDirectLayout(ordered);
    assertValid(layout, crops.length);
    assert.equal(JSON.stringify(placementMap(layout)), expectedSignature, "layout changed with input order");
  }

  const placements = placementMap(computeDirectLayout(crops));
  for (const { ids, direction } of pairRules) {
    const [first, second] = ids.map((id) => placements[id]);
    if (direction === "vertical") {
      assert.equal(first.dx, second.dx);
      assert.equal(Math.min(first.dy + first.dh, second.dy + second.dh), Math.max(first.dy, second.dy));
    } else {
      assert.equal(first.dy, second.dy);
      assert.equal(Math.min(first.dx + first.dw, second.dx + second.dw), Math.max(first.dx, second.dx));
    }
  }
  if (outerDirection === "horizontal") {
    assert.equal(
      Math.max(...groupOrder[0].map((id) => placements[id].dx + placements[id].dw)),
      Math.min(...groupOrder[1].map((id) => placements[id].dx)),
    );
  } else {
    assert.equal(
      Math.max(...groupOrder[0].map((id) => placements[id].dy + placements[id].dh)),
      Math.min(...groupOrder[1].map((id) => placements[id].dy)),
    );
  }
}

assertMixedLayout([
  { id: "A", x: 0, y: 0, width: 300, height: 80 },
  { id: "B", x: 0, y: 100, width: 300, height: 80 },
  { id: "C", x: 400, y: 40, width: 80, height: 240 },
  { id: "D", x: 500, y: 40, width: 80, height: 240 },
], [
  { ids: ["A", "B"], direction: "vertical" },
  { ids: ["C", "D"], direction: "horizontal" },
], [["A", "B"], ["C", "D"]], "horizontal");

assertMixedLayout([
  { id: "A", x: 0, y: 0, width: 80, height: 240 },
  { id: "B", x: 100, y: 0, width: 80, height: 240 },
  { id: "C", x: 300, y: 0, width: 300, height: 80 },
  { id: "D", x: 300, y: 100, width: 300, height: 80 },
], [
  { ids: ["A", "B"], direction: "horizontal" },
  { ids: ["C", "D"], direction: "vertical" },
], [["A", "B"], ["C", "D"]], "horizontal");

assertMixedLayout([
  { id: "A", x: 0, y: 0, width: 80, height: 240 },
  { id: "B", x: 100, y: 0, width: 80, height: 240 },
  { id: "C", x: 40, y: 350, width: 300, height: 80 },
  { id: "D", x: 40, y: 450, width: 300, height: 80 },
], [
  { ids: ["A", "B"], direction: "horizontal" },
  { ids: ["C", "D"], direction: "vertical" },
], [["A", "B"], ["C", "D"]], "vertical");

assertMixedLayout([
  { id: "A", x: 0, y: 0, width: 300, height: 80 },
  { id: "B", x: 0, y: 100, width: 300, height: 80 },
  { id: "C", x: 400, y: 40, width: 80, height: 240 },
], [
  { ids: ["A", "B"], direction: "vertical" },
], [["A", "B"], ["C"]], "horizontal");

assertMixedLayout([
  { id: "A", x: 0, y: 0, width: 80, height: 240 },
  { id: "B", x: 100, y: 0, width: 80, height: 240 },
  { id: "C", x: 40, y: 350, width: 300, height: 80 },
], [
  { ids: ["A", "B"], direction: "horizontal" },
], [["A", "B"], ["C"]], "vertical");

assertMixedLayout([
  { id: "A", x: 0, y: 0, width: 400, height: 100 },
  { id: "B", x: 0, y: 180, width: 100, height: 220 },
  { id: "C", x: 120, y: 180, width: 100, height: 220 },
  { id: "D", x: 240, y: 180, width: 100, height: 220 },
], [
  { ids: ["B", "C"], direction: "horizontal" },
  { ids: ["C", "D"], direction: "horizontal" },
], [["A"], ["B", "C", "D"]], "vertical");

assertMixedLayout([
  { id: "A", x: 0, y: 0, width: 100, height: 400 },
  { id: "B", x: 180, y: 0, width: 220, height: 100 },
  { id: "C", x: 180, y: 120, width: 220, height: 100 },
  { id: "D", x: 180, y: 240, width: 220, height: 100 },
], [
  { ids: ["B", "C"], direction: "vertical" },
  { ids: ["C", "D"], direction: "vertical" },
], [["A"], ["B", "C", "D"]], "horizontal");

const grid = computeDirectLayout([
  { id: "A", x: 0, y: 0, width: 100, height: 100 },
  { id: "B", x: 120, y: 0, width: 100, height: 100 },
  { id: "C", x: 0, y: 120, width: 100, height: 100 },
  { id: "D", x: 120, y: 120, width: 100, height: 100 },
]);
assertValid(grid, 4);
assert.deepEqual(grid.output, { width: 200, height: 200 });

const line = computeDirectLayout([
  { id: "A", x: 0, y: 0, width: 100, height: 100 },
  { id: "B", x: 120, y: 0, width: 100, height: 100 },
  { id: "C", x: 240, y: 0, width: 100, height: 100 },
  { id: "D", x: 360, y: 0, width: 100, height: 100 },
]);
assertValid(line, 4);
assert.equal(line.output.height, 100);

console.log("layout checks passed");
