function computeAlignmentError(pt0, pt12, sMm, gtPt0, gtPt12, gtLenMm) {
  const vx = (gtPt12.x - gtPt0.x) / gtLenMm;
  const vy = (gtPt12.y - gtPt0.y) / gtLenMm;
  const vLenSq = vx * vx + vy * vy;
  if (vLenSq < 1e-6) return Infinity;
  const vLen = Math.sqrt(vLenSq);

  const ux = vx / vLen;
  const uy = vy / vLen;
  const nx = -uy;
  const ny = ux;

  const dp0x = pt0.x - gtPt0.x;
  const dp0y = pt0.y - gtPt0.y;
  const dp12x = pt12.x - gtPt0.x - sMm * vx;
  const dp12y = pt12.y - gtPt0.y - sMm * vy;

  const dot = vx * (dp0x + dp12x) + vy * (dp0y + dp12y);
  const offsetMm = dot / (2 * vLenSq);

  const expP0x = gtPt0.x + offsetMm * vx;
  const expP0y = gtPt0.y + offsetMm * vy;
  const expP12x = gtPt0.x + (offsetMm + sMm) * vx;
  const expP12y = gtPt0.y + (offsetMm + sMm) * vy;

  const err0_par = Math.abs((pt0.x - expP0x) * ux + (pt0.y - expP0y) * uy);
  const err12_par = Math.abs((pt12.x - expP12x) * ux + (pt12.y - expP12y) * uy);

  const err0_perp = Math.abs((pt0.x - expP0x) * nx + (pt0.y - expP0y) * ny);
  const err12_perp = Math.abs((pt12.x - expP12x) * nx + (pt12.y - expP12y) * ny);

  const maxParErrMm = Math.max(err0_par, err12_par) / vLen;
  const maxPerpErrMm = Math.max(err0_perp, err12_perp) / vLen;

  console.log(`maxPar=${maxParErrMm} maxPerp=${maxPerpErrMm} offset=${offsetMm}`);

  if (Math.abs(offsetMm) > 2.0) {
    return Math.max(maxParErrMm, maxPerpErrMm, Math.abs(offsetMm));
  }

  if (maxPerpErrMm <= 3.5) {
    return maxParErrMm;
  }
  return Math.max(maxParErrMm, maxPerpErrMm);
}

const appData = {
  p0: { x: 1370.04, y: 1422.21 },
  p12: { x: 520.04, y: 1422.74 },
  snapMm: 100,
  W: 1786,
  H: 2526
};

const gt = {
  p0: { x: 1372.54, y: 1397.31 },
  p12: { x: 519.65, y: 1399.64 }
};

const gtDist = Math.hypot(gt.p12.x - gt.p0.x, gt.p12.y - gt.p0.y);
const spanPx = Math.hypot(appData.p12.x - appData.p0.x, appData.p12.y - appData.p0.y);
const pxPerMm = spanPx / appData.snapMm;
const gtLengthMm = Math.round((gtDist / pxPerMm) / 10) * 10;

const gtP0f  = { x: appData.W - gt.p0.x,  y: appData.H - gt.p0.y  };
const gtP12f = { x: appData.W - gt.p12.x, y: appData.H - gt.p12.y };

const e1 = computeAlignmentError(appData.p0, appData.p12, appData.snapMm, gt.p0, gt.p12, gtLengthMm);
const e2 = computeAlignmentError(appData.p0, appData.p12, appData.snapMm, gt.p12, gt.p0, gtLengthMm);
const e3 = computeAlignmentError(appData.p0, appData.p12, appData.snapMm, gtP0f, gtP12f, gtLengthMm);
const e4 = computeAlignmentError(appData.p0, appData.p12, appData.snapMm, gtP12f, gtP0f, gtLengthMm);

console.log("e1 =", e1);
console.log("e2 =", e2);
console.log("e3 =", e3);
console.log("e4 =", e4);
console.log("Math.min =", Math.min(e1, e2, e3, e4));
