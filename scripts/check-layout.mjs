import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const sourceText = fs.readFileSync(new URL("../src/content/region_selector.ts", import.meta.url), "utf8");
const sourceFile = ts.createSourceFile("region_selector.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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
  "regionEdges",
  "clamp",
]);
const selectedStatements = [];
function collectStatements(node) {
  if (ts.isFunctionDeclaration(node) && node.name && functionNames.has(node.name.text)) {
    selectedStatements.push(node.getText(sourceFile));
    return;
  }
  ts.forEachChild(node, collectStatements);
}
collectStatements(sourceFile);
const statements = selectedStatements.join("\n");
const runtime = ts.transpileModule(`${statements}\nreturn { computeDirectLayout, scaleLayout, computeResizedEdges, getResizeFocusPoint, getStreamerNameFromTitle, buildDirectFilename };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const { computeDirectLayout, scaleLayout, computeResizedEdges, getResizeFocusPoint, getStreamerNameFromTitle, buildDirectFilename } = new Function(runtime)();

assert.equal(getStreamerNameFromTitle("치지직 게임 - CHZZK"), "치지직 게임");
assert.equal(getStreamerNameFromTitle("치지직 스포츠 - CHZZK"), "치지직 스포츠");
assert.equal(getStreamerNameFromTitle("치지직 배구 중계 - CHZZK"), "치지직 배구 중계");
assert.equal(getStreamerNameFromTitle("치지직 - CHZZK"), "치지직");
assert.equal(getStreamerNameFromTitle("Streamer | CHZZK"), "Streamer");
assert.equal(buildDirectFilename({ baseName: "streamer_20260717_120000", extension: "webm", createdAt: 1_000, endedAt: 43_400 }), "streamer_20260717_120000_42s.webm");
assert.equal(buildDirectFilename({ baseName: "streamer_20260717_120000", extension: "webm", createdAt: 1_000, endedAt: 66_000 }), "streamer_20260717_120000_1m05s.webm");
assert.equal(buildDirectFilename({ baseName: "streamer_20260717_120000", extension: "mp4", createdAt: 1_000, endedAt: 3_724_000 }), "streamer_20260717_120000_1h02m03s.mp4");

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
