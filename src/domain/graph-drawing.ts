/**
 * Line routes and caption placement for the funding graph, so text never sits on
 * text. Each wallet is a disc with its caption underneath; lines leave and enter
 * discs level and only bend in the gaps between columns, crossing a column on a clear
 * horizontal corridor. Captions are placed along their lines where they touch no
 * wallet, heading or other caption.
 *
 * Pure geometry: the caller supplies positions, radii and the obstacles to avoid.
 */

export interface Point {
  x: number;
  y: number;
}

/** A box centred on (cx, cy), with half-width hw and half-height hh, rotated by `angle` radians. */
export interface Rect {
  cx: number;
  cy: number;
  hw: number;
  hh: number;
  angle: number;
}

/**
 * A line's end at a wallet: its centre, disc radius, and how far either side of the
 * centre the line must stay level to clear the captions in that wallet's column.
 */
export interface End {
  x: number;
  y: number;
  r: number;
  clear: number;
}

interface Cubic {
  p0: Point;
  p1: Point;
  p2: Point;
  p3: Point;
}

export interface Route {
  path: string;
  segments: Cubic[];
  /** Cumulative length at the end of each segment. */
  lengths: number[];
  /** Where along the route (0 to 1) a caption reads best: the middle of its level run. */
  prefer: number;
}

export interface Caption {
  text: string;
  x: number;
  y: number;
  /** Degrees, kept upright. */
  angle: number;
  /** Under its line rather than over it: the lower line of a two-way pair. */
  below?: boolean;
}

/** Space the arrowhead needs between a line's end and the disc it points at. */
export const ARROW_GAP = 6;
/** The spacing of the lanes a fan's lines bend in; Graph.tsx widens columns to fit them. */
export const LANE = 10;
/** Spots to try for a caption, as shifts from its preferred spot along the line. */
const SHIFTS = [
  0,
  ...Array.from({ length: 11 }, (_, k) => [
    (k + 1) * 0.04,
    -(k + 1) * 0.04,
  ]).flat(),
];
/** Captions within this many degrees of horizontal count as level. */
const LEVEL = 12;
/** How far a corridor or loop keeps from the wallets it passes. */
const CLEAR = 16;
/** Horizontal room for a line to change height next to a column. */
const BEND = 26;

const lerp = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
const straight = (a: Point, b: Point): Cubic => ({
  p0: a,
  p1: lerp(a, b, 1 / 3),
  p2: lerp(a, b, 2 / 3),
  p3: b,
});
/** Leaves `a` and arrives at `b` level, changing height smoothly in between. */
const ease = (a: Point, b: Point): Cubic => {
  const k = (b.x - a.x) / 2;
  return {
    p0: a,
    p1: { x: a.x + k, y: a.y },
    p2: { x: b.x - k, y: b.y },
    p3: b,
  };
};
const cubicAt = ({ p0, p1, p2, p3 }: Cubic, t: number): Point => {
  const u = 1 - t;
  return {
    x:
      u * u * u * p0.x +
      3 * u * u * t * p1.x +
      3 * u * t * t * p2.x +
      t * t * t * p3.x,
    y:
      u * u * u * p0.y +
      3 * u * u * t * p1.y +
      3 * u * t * t * p2.y +
      t * t * t * p3.y,
  };
};
const cubicTangent = ({ p0, p1, p2, p3 }: Cubic, t: number): Point => {
  const u = 1 - t;
  return {
    x:
      3 * u * u * (p1.x - p0.x) +
      6 * u * t * (p2.x - p1.x) +
      3 * t * t * (p3.x - p2.x),
    y:
      3 * u * u * (p1.y - p0.y) +
      6 * u * t * (p2.y - p1.y) +
      3 * t * t * (p3.y - p2.y),
  };
};
const round = (n: number) => Math.round(n * 100) / 100;

/** `levelRun`: the index of the segment a caption should sit on. */
const toRoute = (segments: Cubic[], levelRun: number): Route => {
  const lengths: number[] = [];
  let total = 0;
  for (const segment of segments) {
    let previous = segment.p0;
    for (let i = 1; i <= 16; i++) {
      const next = cubicAt(segment, i / 16);
      total += Math.hypot(next.x - previous.x, next.y - previous.y);
      previous = next;
    }
    lengths.push(total);
  }
  const before = levelRun ? lengths[levelRun - 1] : 0;
  const run = lengths[levelRun] - before;
  return {
    path:
      `M ${round(segments[0].p0.x)} ${round(segments[0].p0.y)} ` +
      segments
        .map(
          ({ p1, p2, p3 }) =>
            `C ${round(p1.x)} ${round(p1.y)} ${round(p2.x)} ${round(p2.y)} ${round(p3.x)} ${round(p3.y)}`,
        )
        .join(" "),
    segments,
    lengths,
    prefer: total ? (before + run / 2) / total : 0.5,
  };
};

/** The segment and its own parameter at fraction `u` of the route's length. */
const locate = (route: Route, u: number) => {
  const total = route.lengths[route.lengths.length - 1];
  const distance = Math.min(Math.max(u, 0), 1) * total;
  let i = 0;
  while (i < route.lengths.length - 1 && route.lengths[i] < distance) i++;
  const start = i ? route.lengths[i - 1] : 0;
  const span = route.lengths[i] - start;
  return {
    segment: route.segments[i],
    t: span ? (distance - start) / span : 0,
  };
};

export const pointAt = (route: Route, u: number): Point => {
  const { segment, t } = locate(route, u);
  return cubicAt(segment, t);
};

const angleAt = (route: Route, u: number) => {
  const { segment, t } = locate(route, u);
  const tangent = cubicTangent(segment, t);
  let angle = (Math.atan2(tangent.y, tangent.x) * 180) / Math.PI;
  if (angle > 90) angle -= 180;
  else if (angle <= -90) angle += 180;
  return angle;
};

const inside = (p: Point, r: Rect) =>
  Math.abs(p.x - r.cx) <= r.hw && Math.abs(p.y - r.cy) <= r.hh;
const hits = (route: Route, rects: Rect[]) =>
  route.segments.some((segment) =>
    Array.from({ length: 25 }, (_, i) => cubicAt(segment, i / 24)).some((p) =>
      rects.some((r) => inside(p, r)),
    ),
  );

/** The free height nearest `wanted` for a level run across [left, right]. */
const corridor = (
  wanted: number,
  left: number,
  right: number,
  rects: Rect[],
) => {
  const spans = rects
    .filter((r) => r.cx + r.hw > left && r.cx - r.hw < right)
    .map((r) => [r.cy - r.hh - CLEAR, r.cy + r.hh + CLEAR] as const);
  const free = (y: number) => spans.every(([low, high]) => y < low || y > high);
  return [wanted, ...spans.flatMap(([low, high]) => [low - 0.5, high + 0.5])]
    .filter(free)
    .sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted))[0];
};

/**
 * A line to a later column. It runs level past the captions at each end; `bend`
 * says where it changes height: next to the start (a fan out of one wallet), next to
 * the end (a fan into one wallet) or midway. If wallets in between are in the way it
 * crosses them on a clear corridor instead.
 */
export function routeForward(
  from: End,
  to: End,
  blockers: Rect[],
  bend: "start" | "end" | "middle" = "middle",
  fan: { slot: number; of: number } = { slot: 0, of: 1 },
): Route {
  // In a fan, each line meets the busy wallet at its own height (no stacked
  // arrowheads), and lines to the farthest wallets bend nearest it, so the curves
  // nest rather than cross. Slots run top to bottom by the other end's height.
  const offset = fan.slot - (fan.of - 1) / 2;
  const hub = bend === "start" ? from : bend === "end" ? to : null;
  const port = hub
    ? Math.max(-(hub.r - 6), Math.min(hub.r - 6, offset * 5))
    : 0;
  const rim = (r: number) => Math.sqrt(r * r - port * port);
  const fromY = from.y + (bend === "start" ? port : 0),
    toY = to.y + (bend === "end" ? port : 0);
  const s = { x: from.x + (bend === "start" ? rim(from.r) : from.r), y: fromY },
    s1 = { x: from.x + Math.max(from.clear, from.r) + 6, y: fromY };
  const e = {
      x: to.x - (bend === "end" ? rim(to.r) : to.r) - ARROW_GAP,
      y: toY,
    },
    e1 = { x: to.x - Math.max(to.clear, to.r) - 6, y: toY };
  const room = e1.x - s1.x;
  // Each line of a fan bends in a lane of its own, LANE apart, so no two share a
  // vertical run; the lanes nest as above.
  const lanes = (fan.of - 1) / 2;
  const reach = Math.max(16, Math.min(room * 0.7, 16 + lanes * 2 * LANE));
  const width = lanes
    ? 16 + (reach - 16) * (1 - Math.abs(offset) / (lanes + 0.5))
    : Math.max(16, Math.min(room * 0.4, 64));
  let direct: Route;
  if (bend === "start" && fromY !== toY) {
    const m = { x: s1.x + width, y: to.y };
    direct = toRoute(
      [straight(s, s1), ease(s1, m), straight(m, e1), straight(e1, e)],
      2,
    );
  } else if (bend === "end" && fromY !== toY) {
    const m = { x: e1.x - width, y: from.y };
    direct = toRoute(
      [straight(s, s1), straight(s1, m), ease(m, e1), straight(e1, e)],
      1,
    );
  } else direct = toRoute([straight(s, s1), ease(s1, e1), straight(e1, e)], 1);
  if (!hits(direct, blockers)) return direct;
  const w1x = s1.x + BEND,
    w2x = e1.x - BEND;
  const y = corridor((from.y + to.y) / 2, w1x, w2x, blockers);
  const w1 = { x: w1x, y },
    w2 = { x: w2x, y };
  return toRoute(
    [
      straight(s, s1),
      ease(s1, w1),
      straight(w1, w2),
      ease(w2, e1),
      straight(e1, e),
    ],
    2,
  );
}

/** The same line travelled the other way, for drawing money that flows back. */
export function reverseRoute(route: Route): Route {
  const segments = [...route.segments]
    .reverse()
    .map(({ p0, p1, p2, p3 }) => ({ p0: p3, p1: p2, p2: p1, p3: p0 }));
  return { ...toRoute(segments, 0), prefer: 1 - route.prefer };
}

/**
 * A line to the same or an earlier column. Within one column it bows out to the
 * right, past that column's captions. To an earlier column it leaves to the left,
 * drops below every wallet it passes, and rises into the target's right side.
 */
export function routeBackward(from: End, to: End, blockers: Rect[]): Route {
  if (from.x === to.x) {
    const clear = Math.max(from.clear, to.clear, from.r, to.r) + 6;
    const s = { x: from.x + from.r, y: from.y },
      s1 = { x: from.x + clear, y: from.y };
    const e = { x: to.x + to.r + ARROW_GAP, y: to.y },
      e1 = { x: to.x + clear, y: to.y };
    const w = { x: from.x + clear + BEND, y: (from.y + to.y) / 2 };
    return toRoute(
      [straight(s, s1), ease(s1, w), ease(w, e1), straight(e1, e)],
      1,
    );
  }
  const s = { x: from.x - from.r, y: from.y },
    s1 = { x: from.x - Math.max(from.clear, from.r) - 6, y: from.y };
  const e = { x: to.x + to.r + ARROW_GAP, y: to.y },
    e1 = { x: to.x + Math.max(to.clear, to.r) + 6, y: to.y };
  const w1x = s1.x - BEND,
    w2x = e1.x + BEND;
  const floor = Math.max(from.y, to.y) + 60;
  const below = blockers
    .filter((r) => r.cx + r.hw > w2x && r.cx - r.hw < w1x)
    .map((r) => r.cy + r.hh + CLEAR);
  const y = Math.max(floor, ...below);
  const w1 = { x: w1x, y },
    w2 = { x: w2x, y };
  return toRoute(
    [
      straight(s, s1),
      ease(s1, w1),
      straight(w1, w2),
      ease(w2, e1),
      straight(e1, e),
    ],
    2,
  );
}

/** A caption at fraction `u` of the route, along the line there. */
export const captionAt = (
  route: Route,
  text: string,
  u = route.prefer,
  below = false,
): Caption => ({
  text,
  ...pointAt(route, u),
  angle: angleAt(route, u),
  ...(below ? { below } : {}),
});

/** The box a caption's text occupies: about 11px tall, just over (or under) its line. */
export function captionBox(caption: Caption, width: number): Rect {
  const angle = (caption.angle * Math.PI) / 180;
  const side = caption.below ? -1 : 1;
  return {
    cx: caption.x + side * 6.5 * Math.sin(angle),
    cy: caption.y - side * 6.5 * Math.cos(angle),
    hw: width / 2 + 3,
    hh: 6.5,
    angle,
  };
}

const corners = (r: Rect): Point[] => {
  const c = Math.cos(r.angle),
    s = Math.sin(r.angle);
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([i, j]) => ({
    x: r.cx + i * r.hw * c - j * r.hh * s,
    y: r.cy + i * r.hw * s + j * r.hh * c,
  }));
};

/** Whether two rotated boxes intersect (separating axis test). */
export function overlaps(a: Rect, b: Rect): boolean {
  const ca = corners(a),
    cb = corners(b);
  for (const r of [a, b]) {
    const c = Math.cos(r.angle),
      s = Math.sin(r.angle);
    for (const axis of [
      { x: c, y: s },
      { x: -s, y: c },
    ]) {
      const pa = ca.map((p) => p.x * axis.x + p.y * axis.y),
        pb = cb.map((p) => p.x * axis.x + p.y * axis.y);
      if (
        Math.max(...pa) < Math.min(...pb) ||
        Math.max(...pb) < Math.min(...pa)
      )
        return false;
    }
  }
  return true;
}

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const bounds = (r: Rect): Bounds => {
  const c = Math.abs(Math.cos(r.angle)),
    s = Math.abs(Math.sin(r.angle));
  const w = r.hw * c + r.hh * s,
    h = r.hw * s + r.hh * c;
  return { minX: r.cx - w, maxX: r.cx + w, minY: r.cy - h, maxY: r.cy + h };
};

const apart = (a: Bounds, b: Bounds) =>
  a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY;

/** How far a line may turn under its own caption before it counts as crossing it. */
const PARALLEL = (20 * Math.PI) / 180;
/** The angle between two directions, ignoring which way along the line each points. */
const turn = (a: number, b: number) => {
  const d = Math.abs(a - b) % Math.PI;
  return Math.min(d, Math.PI - d);
};

/** A line as thin boxes, one per sampled stretch, with their overall bounds. */
const stroke = (route: Route) => {
  const boxes: (Bounds & { rect: Rect })[] = [];
  for (const segment of route.segments) {
    let previous = segment.p0;
    for (let i = 1; i <= 8; i++) {
      const next = cubicAt(segment, i / 8);
      const length = Math.hypot(next.x - previous.x, next.y - previous.y);
      if (length) {
        const rect = {
          cx: (previous.x + next.x) / 2,
          cy: (previous.y + next.y) / 2,
          hw: length / 2,
          hh: 1,
          angle: Math.atan2(next.y - previous.y, next.x - previous.x),
        };
        boxes.push({ rect, ...bounds(rect) });
      }
      previous = next;
    }
  }
  return {
    route,
    boxes,
    minX: Math.min(...boxes.map((box) => box.minX)),
    maxX: Math.max(...boxes.map((box) => box.maxX)),
    minY: Math.min(...boxes.map((box) => box.minY)),
    maxY: Math.max(...boxes.map((box) => box.maxY)),
  };
};

/**
 * Place each line's caption where it touches no obstacle and no caption placed
 * before it, trying spots along the line from its preferred one outwards and each
 * text in turn (fullest first). A caption must also fit within its own line, and
 * takes a spot no other line crosses when it has one. Lines whose captions fit
 * nowhere are left out; requests earlier in the list win.
 */
export function placeCaptions(
  requests: { id: string; texts: string[]; route: Route; below?: boolean }[],
  obstacles: Rect[],
  width: (text: string) => number,
): Map<string, Caption> {
  const placed = new Map<string, Caption>();
  const taken: Rect[] = [...obstacles];
  const lines = requests.map(({ route }) => stroke(route));
  // Another line anywhere in the caption crosses it. The caption's own line touches
  // it all along the stretch it sits on, so only that line's turns count: parts more
  // than PARALLEL off the caption's direction.
  const crossed = (box: Rect, own: Route) => {
    const area = bounds(box);
    return lines.some(
      (line) =>
        !apart(line, area) &&
        line.boxes.some(
          (part) =>
            (line.route !== own ||
              turn(part.rect.angle, box.angle) > PARALLEL) &&
            !apart(part, area) &&
            overlaps(box, part.rect),
        ),
    );
  };
  for (const { id, texts, route, below } of requests) {
    const total = route.lengths[route.lengths.length - 1];
    const spots = SHIFTS.map((shift) => route.prefer + shift).filter(
      (u) => u > 0 && u < 1,
    );
    // Text no other line runs through reads best, then level text: every text gets
    // a clear level spot, then a clear angled one, before any spot a line crosses.
    search: for (const clear of [true, false])
      for (const level of [true, false])
        for (const text of texts) {
          const w = width(text);
          for (const u of spots) {
            if (w / 2 + 4 > Math.min(u, 1 - u) * total) continue;
            const caption = captionAt(route, text, u, below);
            if (level && Math.abs(caption.angle) > LEVEL) continue;
            const box = captionBox(caption, w);
            if (taken.some((other) => overlaps(box, other))) continue;
            if (clear && crossed(box, route)) continue;
            placed.set(id, caption);
            taken.push(box);
            break search;
          }
        }
  }
  return placed;
}
