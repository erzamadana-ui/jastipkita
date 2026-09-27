// JastipKita symbol geometry — shopping bag + airplane + orbital swoosh.
// All shapes are constructed from geometric primitives (fillets, ellipse arcs, variable-width
// strokes) and flattened with boolean operations so the exported SVG is plain <path> data:
// no masks, no strokes, no fonts. Coordinate system: 512 × 512 design grid, y grows downward.
import { requireDep } from './deps.mjs';

const paper = requireDep('paper');
paper.setup(new paper.Size(1024, 1024));
const { Path, Point, CompoundPath } = paper;

const DEG = Math.PI / 180;

/** Polygon with true circular fillets of radius radii[i] at each vertex. */
export function roundedPolygon(pts, radii) {
  const n = pts.length;
  const P = pts.map((p) => new Point(p[0], p[1]));
  const path = new Path();
  const corner = (i) => {
    const p = P[i];
    const a = P[(i - 1 + n) % n];
    const b = P[(i + 1) % n];
    const r = Array.isArray(radii) ? radii[i] : radii;
    const u1 = a.subtract(p).normalize();
    const u2 = b.subtract(p).normalize();
    const theta = Math.acos(Math.max(-1, Math.min(1, u1.dot(u2))));
    if (r <= 0.01) return { t1: p, m: null, t2: p };
    const d = r / Math.tan(theta / 2);
    const bis = u1.add(u2).normalize();
    return {
      t1: p.add(u1.multiply(d)),
      m: p.add(bis.multiply(r / Math.sin(theta / 2) - r)),
      t2: p.add(u2.multiply(d)),
    };
  };
  for (let i = 0; i < n; i++) {
    const c = corner(i);
    if (i === 0) path.moveTo(c.t1);
    else path.lineTo(c.t1);
    if (c.m) path.arcTo(c.m, c.t2);
  }
  path.closePath();
  return path;
}

/** Point + unit tangent on a rotated ellipse at parameter t (radians). */
function ellipsePoint(e, t) {
  const cr = Math.cos(e.rot * DEG);
  const sr = Math.sin(e.rot * DEG);
  const x = e.rx * Math.cos(t);
  const y = e.ry * Math.sin(t);
  const dx = -e.rx * Math.sin(t);
  const dy = e.ry * Math.cos(t);
  const p = new Point(e.cx + x * cr - y * sr, e.cy + x * sr + y * cr);
  const d = new Point(dx * cr - dy * sr, dx * sr + dy * cr).normalize();
  return { p, d };
}

/**
 * Variable-width band along an ellipse from t0 to t1. width(s) with s∈[0,1] gives the full width.
 * Returns a closed, smooth paper.Path.
 */
function ellipseBand(e, t0, t1, width, steps = 160) {
  const outer = [];
  const inner = [];
  for (let i = 0; i <= steps; i++) {
    const s = i / steps;
    const t = t0 + (t1 - t0) * s;
    const { p, d } = ellipsePoint(e, t);
    const nrm = new Point(-d.y, d.x);
    const w = Math.max(0, width(s)) / 2;
    outer.push(p.add(nrm.multiply(w)));
    inner.push(p.subtract(nrm.multiply(w)));
  }
  const path = new Path({ segments: [...outer, ...inner.reverse()], closed: true });
  path.simplify(0.08);
  return path;
}

/** Stylised airliner, top view, nose pointing +x, centred on the wing root. Length ≈ 1 unit × scale. */
function airplane(scale, shape = {}) {
  const s = scale;
  const f = { nose: 0.5, tail: -0.42, half: 0.068, wingRoot: [0.16, -0.1], wingTip: [-0.14, -0.27], span: 0.5, stabRoot: [-0.25, -0.38], stabTip: [-0.39, -0.47], stabSpan: 0.21, ...shape };
  const P = (x, y) => [x * s, y * s];
  const h = f.half;
  const fuselage = roundedPolygon(
    [P(f.nose, 0), P(f.nose - 0.14, h), P(f.tail + 0.05, h), P(f.tail, 0), P(f.tail + 0.05, -h), P(f.nose - 0.14, -h)],
    [0.07 * s, 0.1 * s, 0.04 * s, 0.03 * s, 0.04 * s, 0.1 * s],
  );
  const wing = (sgn) =>
    roundedPolygon(
      [P(f.wingRoot[0], 0.02 * sgn), P(f.wingTip[0], f.span * sgn), P(f.wingTip[1], f.span * sgn), P(f.wingRoot[1], 0.02 * sgn)],
      [0.01 * s, 0.045 * s, 0.045 * s, 0.01 * s],
    );
  const tail = (sgn) =>
    roundedPolygon(
      [P(f.stabRoot[0], 0.02 * sgn), P(f.stabTip[0], f.stabSpan * sgn), P(f.stabTip[1], f.stabSpan * sgn), P(f.stabRoot[1], 0.02 * sgn)],
      [0.01 * s, 0.03 * s, 0.03 * s, 0.01 * s],
    );
  let plane = fuselage;
  for (const part of [wing(1), wing(-1), tail(1), tail(-1)]) {
    const u = plane.unite(part);
    plane.remove();
    part.remove();
    plane = u;
  }
  return plane;
}

/** Drop boolean-op crumbs (sub-paths with negligible area) and return clean path data. */
function clean(item, minArea = 4) {
  if (item.children) {
    for (const child of [...item.children]) if (Math.abs(child.area) < minArea) child.remove();
  }
  return item;
}

const smooth = (x) => x * x * (3 - 2 * x);

export const DEFAULT_PARAMS = {
  // Bag body — slightly tapered (wider base) for a grounded, friendly silhouette
  bagCx: 244,
  bagTop: 196,
  bagBottom: 432,
  bagTopHalf: 104,
  bagBottomHalf: 116,
  bagTopRadius: 22,
  bagBottomRadius: 34,
  // Handle — semicircular arch, strap threaded through two grommets (reads "shopping bag", not "padlock")
  handleThickness: 19,
  handleInnerHalf: 46,
  handleRise: 60,
  grommet: { offset: 30, r: 9, strap: 8 },
  hem: null,
  // Orbit — tilted ellipse; near side passes in front of the bag, far side hides behind it
  orbit: { cx: 254, cy: 294, rx: 200, ry: 78, rot: -15 },
  orbitStart: 237, // degrees — tail emerges from behind the bag (upper-left)
  orbitEnd: 22, // degrees — head, just before the right-most point
  orbitMaxWidth: 29,
  orbitPeak: 0.52,
  gap: 11,
  // Plane — departs the orbit, nose up-right
  planeScale: 96,
  planeT: -8,
  planeHeading: -42,
  planeDx: 14,
  planeDy: -4,
  // Favicon simplification
  dropPlane: false,
};

/** Simplified geometry for ≤ 32 px (favicon, notification icon): no plane, no strap lines, bolder
 * handle and swoosh, larger grommet dots, wider/lower handle arch so it never reads as a padlock. */
export const FAVICON_PARAMS = {
  grommet: { offset: 34, r: 14, strap: 0 },
  handleThickness: 24,
  handleInnerHalf: 58,
  handleRise: 50,
  bagTopHalf: 108,
  bagBottomHalf: 118,
  orbit: { rx: 194, ry: 80 },
  orbitStart: 232,
  orbitEnd: -12,
  orbitMaxWidth: 48,
  orbitPeak: 0.5,
  gap: 18,
  dropPlane: true,
};

/** Re-serialise path data through an affine transform [a, b, c, d, tx, ty] with fixed precision. */
export function transformPathData(d, m, precision = 2) {
  if (!d) return '';
  const cp = new CompoundPath(d);
  cp.transform(new paper.Matrix(m[0], m[1], m[2], m[3], m[4], m[5]));
  const out = cp.getPathData(null, precision);
  cp.remove();
  return out;
}

/** Build the symbol. Returns path data for each layer + bounds. */
export function buildSymbol(params = {}) {
  const q = { ...DEFAULT_PARAMS, ...params, orbit: { ...DEFAULT_PARAMS.orbit, ...(params.orbit ?? {}) } };
  const project = paper.project;
  project.clear();

  // --- Bag body
  const cx = q.bagCx;
  const body = roundedPolygon(
    [
      [cx - q.bagTopHalf, q.bagTop],
      [cx + q.bagTopHalf, q.bagTop],
      [cx + q.bagBottomHalf, q.bagBottom],
      [cx - q.bagBottomHalf, q.bagBottom],
    ],
    [q.bagTopRadius, q.bagTopRadius, q.bagBottomRadius, q.bagBottomRadius],
  );

  // --- Handle: inverted U of constant thickness, legs sink into the body.
  const ri = q.handleInnerHalf;
  const ro = ri + q.handleThickness;
  const apexY = q.bagTop - q.handleRise + ri; // centre of the semicircle
  const outer = new Path();
  outer.moveTo(new Point(cx - ro, q.bagTop + 30));
  outer.lineTo(new Point(cx - ro, apexY));
  outer.arcTo(new Point(cx, apexY - ro), new Point(cx + ro, apexY));
  outer.lineTo(new Point(cx + ro, q.bagTop + 30));
  outer.closePath();
  const inner = new Path();
  inner.moveTo(new Point(cx - ri, q.bagTop + 40));
  inner.lineTo(new Point(cx - ri, apexY));
  inner.arcTo(new Point(cx, apexY - ri), new Point(cx + ri, apexY));
  inner.lineTo(new Point(cx + ri, q.bagTop + 40));
  inner.closePath();
  const handle = outer.subtract(inner);
  let bag = body.unite(handle);
  // Optional hem: a negative band just below the top edge — the signature of a paper shopping bag.
  if (q.hem) {
    const hy = q.bagTop + q.hem.offset;
    const band = new Path.Rectangle({ point: [cx - 400, hy], size: [800, q.hem.thickness] });
    const inset = new Path.Rectangle({ point: [cx - q.bagTopHalf + q.hem.inset, hy - 50], size: [2 * (q.bagTopHalf - q.hem.inset), 100] });
    const cut = q.hem.full ? band : band.intersect(inset);
    bag = bag.subtract(cut);
  }
  // Optional grommets: two negative circles where the handle meets the body. With `strap`, the
  // handle continues inside the body as a negative line down to the grommet (strap threaded through).
  if (q.grommet) {
    for (const sx of [-1, 1]) {
      const gx = cx + sx * (ri + q.handleThickness / 2);
      const gy = q.bagTop + q.grommet.offset;
      let cut = new Path.Circle({ center: [gx, gy], radius: q.grommet.r });
      if (q.grommet.strap) {
        const w = q.grommet.strap;
        const line = new Path.Rectangle({ point: [gx - w / 2, q.bagTop], size: [w, gy - q.bagTop] });
        const u = cut.unite(line);
        cut = u;
      }
      bag = bag.subtract(cut);
    }
  }

  // --- Orbit swoosh
  const t0 = q.orbitStart * DEG;
  const t1 = q.orbitEnd * DEG;
  const peak = q.orbitPeak;
  const widthFn = (extra) => (s) => {
    // rises from a hairline tail to the peak, then eases to a fine point at the head
    const a = s < peak ? smooth(s / peak) : smooth((1 - s) / (1 - peak));
    const base = q.orbitMaxWidth * Math.pow(a, s < peak ? 0.85 : 0.7);
    return base + extra;
  };
  const swoosh = ellipseBand(q.orbit, t0, t1, widthFn(0));

  // The swoosh passes IN FRONT of the bag only on its lower (near) half. Knock a gap out of the bag
  // along the near-side part of the swoosh; the far side (tail) disappears behind the bag.
  const nearT0 = 162 * DEG; // from the left edge, around the bottom, to the right edge
  const knock = ellipseBand(q.orbit, nearT0 + 0.2, t1 - 0.25, (s) => {
    const tt = nearT0 + 0.2 + (t1 - 0.25 - (nearT0 + 0.2)) * s;
    const sGlobal = (tt - t0) / (t1 - t0);
    return widthFn(q.gap * 2)(Math.min(1, Math.max(0, sGlobal)));
  });
  const bagCut = bag.subtract(knock);

  // Hide the tail behind the bag (far side): subtract the bag (+gap) from the tail portion.
  const bagGrown = bag.clone();
  // approximate outward offset by scaling about the bag centre for the occlusion only
  const bb = bag.bounds;
  bagGrown.scale((bb.width + q.gap * 2) / bb.width, (bb.height + q.gap * 2) / bb.height, bb.center);
  // far side = region above the orbit's major axis line through the centre
  const { p: pl } = ellipsePoint(q.orbit, Math.PI);
  const { p: pr } = ellipsePoint(q.orbit, 0);
  const far = new Path({ segments: [[-50, -50], [562, -50], [pr.x + 400 * (pr.x - pl.x) / 512, pr.y + 400 * (pr.y - pl.y) / 512], [pl.x - 400 * (pr.x - pl.x) / 512, pl.y - 400 * (pr.y - pl.y) / 512]], closed: true });
  const occluder = bagGrown.intersect(far);
  const swooshFinal = swoosh.subtract(occluder);

  // --- Airplane: rides the orbit just beyond the head of the swoosh, nose pitched up (departure).
  const { p: pp, d: pd } = ellipsePoint(q.orbit, q.planeT * DEG);
  const plane = airplane(q.planeScale);
  const heading = q.planeHeading ?? Math.atan2(-pd.y, -pd.x) / DEG;
  plane.rotate(heading, new Point(0, 0));
  plane.translate(pp.add(new Point(q.planeDx ?? 0, q.planeDy ?? 0)));

  clean(bagCut);
  clean(swooshFinal);
  clean(plane);
  if (q.dropPlane) plane.remove();
  const out = {
    bag: bagCut.pathData,
    swoosh: swooshFinal.pathData,
    plane: q.dropPlane ? '' : plane.pathData,
    bounds: q.dropPlane ? bagCut.bounds.unite(swooshFinal.bounds) : bagCut.bounds.unite(swooshFinal.bounds).unite(plane.bounds),
  };
  const b = out.bounds;
  out.bounds = { x: b.x, y: b.y, width: b.width, height: b.height };
  return out;
}
