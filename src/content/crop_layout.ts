import { MAX_MULTI_REGION_COUNT } from "../shared/types.js";

const MIN_GROUPED_LAYOUT_REGIONS = 3;

export interface DirectCropPlacement {
  crop: DirectCrop;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

export interface DirectCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DirectLayout {
  output: { width: number; height: number };
  placements: DirectCropPlacement[];
}

function computeDirectOutput(crop: { width: number; height: number }): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(crop.width)),
    height: Math.max(1, Math.round(crop.height)),
  };
}

export function scaleLayout(layout: DirectLayout, scale: number, dx: number, dy: number): DirectCropPlacement[] {
  return layout.placements.map((placement) => {
    const left = Math.round(placement.dx * scale);
    const top = Math.round(placement.dy * scale);
    const right = Math.round((placement.dx + placement.dw) * scale);
    const bottom = Math.round((placement.dy + placement.dh) * scale);
    return {
      crop: placement.crop,
      dx: dx + left,
      dy: dy + top,
      dw: Math.max(1, right - left),
      dh: Math.max(1, bottom - top),
    };
  });
}

function composeHorizontal(layouts: DirectLayout[]): DirectLayout {
  const height = Math.max(1, Math.round(Math.max(...layouts.map((layout) => layout.output.height))));
  let x = 0;
  const placements: DirectCropPlacement[] = [];
  for (const layout of layouts) {
    const scale = height / layout.output.height;
    placements.push(...scaleLayout(layout, scale, x, 0));
    x += Math.max(1, Math.round(layout.output.width * scale));
  }
  return { output: { width: Math.max(1, x), height }, placements };
}

function composeVertical(layouts: DirectLayout[]): DirectLayout {
  const width = Math.max(1, Math.round(Math.max(...layouts.map((layout) => layout.output.width))));
  let y = 0;
  const placements: DirectCropPlacement[] = [];
  for (const layout of layouts) {
    const scale = width / layout.output.width;
    placements.push(...scaleLayout(layout, scale, 0, y));
    y += Math.max(1, Math.round(layout.output.height * scale));
  }
  return { output: { width, height: Math.max(1, y) }, placements };
}

function getPairLayoutDirection(crops: DirectCrop[]): "horizontal" | "vertical" | null {
  if (crops.length !== 2) {
    return null;
  }

  const [first, second] = crops;
  const separatedX = first.x + first.width <= second.x || second.x + second.width <= first.x;
  const separatedY = first.y + first.height <= second.y || second.y + second.height <= first.y;
  if (separatedX !== separatedY) {
    return separatedX ? "horizontal" : "vertical";
  }

  const centerDistanceX = Math.abs((first.x + first.width / 2) - (second.x + second.width / 2));
  const centerDistanceY = Math.abs((first.y + first.height / 2) - (second.y + second.height / 2));
  const normalizedX = centerDistanceX / Math.max(1, (first.width + second.width) / 2);
  const normalizedY = centerDistanceY / Math.max(1, (first.height + second.height) / 2);
  return normalizedX >= normalizedY ? "horizontal" : "vertical";
}

function getGroupedLayout(crops: DirectCrop[]): DirectLayout | null {
  if (crops.length < MIN_GROUPED_LAYOUT_REGIONS || crops.length > MAX_MULTI_REGION_COUNT) {
    return null;
  }

  const fullMask = (1 << crops.length) - 1;
  let best: { score: number; horizontal: boolean; layout: DirectLayout } | null = null;
  for (let mask = 1; mask < fullMask; mask += 1) {
    if ((mask & 1) === 0) {
      continue;
    }
    const first: number[] = [];
    const second: number[] = [];
    for (let index = 0; index < crops.length; index += 1) {
      ((mask & (1 << index)) === 0 ? second : first).push(index);
    }
    const groups = [first, second].map((indices) => indices.map((index) => crops[index]));
    const bounds = groups.map((group) => ({
      left: Math.min(...group.map((crop) => crop.x)),
      top: Math.min(...group.map((crop) => crop.y)),
      right: Math.max(...group.map((crop) => crop.x + crop.width)),
      bottom: Math.max(...group.map((crop) => crop.y + crop.height)),
    }));
    const horizontalOrder = bounds[0].right <= bounds[1].left ? [0, 1] : bounds[1].right <= bounds[0].left ? [1, 0] : null;
    const verticalOrder = bounds[0].bottom <= bounds[1].top ? [0, 1] : bounds[1].bottom <= bounds[0].top ? [1, 0] : null;
    if (!horizontalOrder && !verticalOrder) {
      continue;
    }
    const layouts = groups.map((group) => computeDirectLayout(group));

    if (horizontalOrder) {
      const gap = bounds[horizontalOrder[1]].left - bounds[horizontalOrder[0]].right;
      const score = gap / Math.max(1, Math.max(bounds[0].right, bounds[1].right) - Math.min(bounds[0].left, bounds[1].left));
      if (!best || score > best.score || (score === best.score && !best.horizontal)) {
        best = { score, horizontal: true, layout: composeHorizontal(horizontalOrder.map((index) => layouts[index])) };
      }
    }

    if (verticalOrder) {
      const gap = bounds[verticalOrder[1]].top - bounds[verticalOrder[0]].bottom;
      const score = gap / Math.max(1, Math.max(bounds[0].bottom, bounds[1].bottom) - Math.min(bounds[0].top, bounds[1].top));
      if (!best || score > best.score) {
        best = { score, horizontal: false, layout: composeVertical(verticalOrder.map((index) => layouts[index])) };
      }
    }
  }

  return best?.layout ?? null;
}

export function computeDirectLayout(crops: DirectCrop[]): DirectLayout {
  if (crops.length <= 1) {
    const crop = crops[0];
    return {
      output: computeDirectOutput(crop),
      placements: [{ crop, dx: 0, dy: 0, dw: crop.width, dh: crop.height }],
    };
  }

  const left = Math.min(...crops.map((crop) => crop.x));
  const top = Math.min(...crops.map((crop) => crop.y));
  const right = Math.max(...crops.map((crop) => crop.x + crop.width));
  const bottom = Math.max(...crops.map((crop) => crop.y + crop.height));
  const pairDirection = getPairLayoutDirection(crops);
  const horizontal = pairDirection ? pairDirection === "horizontal" : right - left >= bottom - top;

  if (crops.length > 2) {
    const groupedLayout = getGroupedLayout(crops);
    if (groupedLayout) {
      return groupedLayout;
    }

    if (horizontal) {
      const ordered = [...crops].sort((a, b) => (a.x + a.width / 2) - (b.x + b.width / 2));
      const split = Math.ceil(ordered.length / 2);
      return composeHorizontal([
        composeVertical(ordered.slice(0, split).sort((a, b) => a.y - b.y).map((crop) => computeDirectLayout([crop]))),
        composeVertical(ordered.slice(split).sort((a, b) => a.y - b.y).map((crop) => computeDirectLayout([crop]))),
      ]);
    }

    const ordered = [...crops].sort((a, b) => (a.y + a.height / 2) - (b.y + b.height / 2));
    const split = Math.ceil(ordered.length / 2);
    return composeVertical([
      composeHorizontal(ordered.slice(0, split).sort((a, b) => a.x - b.x).map((crop) => computeDirectLayout([crop]))),
      composeHorizontal(ordered.slice(split).sort((a, b) => a.x - b.x).map((crop) => computeDirectLayout([crop]))),
    ]);
  }

  const ordered = [...crops].sort((a, b) => horizontal ? a.x - b.x : a.y - b.y);

  const layouts = ordered.map((crop) => computeDirectLayout([crop]));
  return horizontal ? composeHorizontal(layouts) : composeVertical(layouts);
}
