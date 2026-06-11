/**
 * run_direct_tests.js — Fast CLI E2E test runner for all stencils.
 * Uses standalone algorithm profiles in algorithms/.
 *
 * Usage: node run_direct_tests.js
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const os = require('os');

const STENCILS_DIR = '/Users/up273900/Documents/Coding/stoma_stencils/01_Schablonen_Vorlagen_für_Tests';
const OUTPUT_DIR = '/Users/up273900/Documents/Coding/stoma_stencils/test_outputs';
const RESULTS_MD = '/Users/up273900/Documents/Coding/stoma_stencils/test_results.md';
const MM_TO_PT = 72 / 25.4;

const RulerDetector = require('./js/ruler-detector.js');
const ALL_ALGORITHMS = [{
  id: 'current-merged',
  label: 'current',
  detect: RulerDetector.detect,
}];
const ACTIVE_ALGORITHMS = ALL_ALGORITHMS;
const ALL_VERSIONS = ALL_ALGORITHMS.map((a) => a.id);

resetTestOutputs();

// ─── 1. Load OpenCV.js ──────────────────────────────────────────────────────
console.log('Loading OpenCV.js...');
const cv = require('/Users/up273900/Documents/Coding/stoma_stencils/offline_package/vendor/opencv.js');
global.cv = cv;

cv.onRuntimeInitialized = () => {
  console.log('OpenCV.js ready.');
  runAllTests();
};

function median(values) {
  if (!values.length) return 0;
  const copy = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(copy.length / 2);
  return copy.length % 2 ? copy[mid] : (copy[mid - 1] + copy[mid]) / 2;
}

function rotateWithFrame(src, angleDeg) {
  const rad = Math.abs(angleDeg * Math.PI / 180);
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  const newW = Math.ceil(src.rows * sin + src.cols * cos);
  const newH = Math.ceil(src.rows * cos + src.cols * sin);

  const center = new cv.Point(src.cols / 2, src.rows / 2);
  const rotMat = cv.getRotationMatrix2D(center, angleDeg, 1);
  rotMat.data64F[2] += newW / 2 - center.x;
  rotMat.data64F[5] += newH / 2 - center.y;

  const dst = new cv.Mat();
  cv.warpAffine(
    src,
    dst,
    rotMat,
    new cv.Size(newW, newH),
    cv.INTER_CUBIC,
    cv.BORDER_CONSTANT,
    new cv.Scalar(255, 255, 255, 255)
  );
  rotMat.delete();
  return dst;
}

function deskew(src) {
  const gray = new cv.Mat();
  const edges = new cv.Mat();
  const lines = new cv.Mat();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0);
    cv.Canny(gray, edges, 50, 150, 3, false);
    cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 80, src.cols * 0.25, 20);

    const angles = [];
    for (let i = 0; i < lines.rows; i += 1) {
      const x1 = lines.data32S[i * 4 + 0];
      const y1 = lines.data32S[i * 4 + 1];
      const x2 = lines.data32S[i * 4 + 2];
      const y2 = lines.data32S[i * 4 + 3];
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < src.cols * 0.2) continue;

      let deg = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
      if (deg > 90) deg -= 180;
      if (deg < -90) deg += 180;
      if (Math.abs(deg) <= 35) {
        angles.push(deg);
      } else if (Math.abs(deg) >= 55) {
        const dev = (deg > 0) ? deg - 90 : deg + 90;
        angles.push(dev);
      }
    }

    const medianAngle = angles.length ? median(angles) : 0;
    if (Math.abs(medianAngle) < 0.01) {
      return { mat: src.clone(), angle: 0 };
    }
    const rotated = rotateWithFrame(src, -medianAngle);
    return { mat: rotated, angle: -medianAngle };
  } finally {
    gray.delete();
    edges.delete();
    lines.delete();
  }
}

function cropAndScaleStencilIfPossibleMat(srcMat) {
  const width = srcMat.cols;
  const height = srcMat.rows;
  const gray = new cv.Mat();
  const thresh = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  try {
    cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    cv.threshold(gray, thresh, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

    cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let maxArea = 0;
    let bestRect = null;
    const totalArea = width * height;

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const rect = cv.boundingRect(cnt);
      const area = rect.width * rect.height;
      if (area > maxArea && area > totalArea * 0.1 && area < totalArea * 0.98) {
        maxArea = area;
        bestRect = rect;
      }
    }

    if (bestRect) {
      const padX = Math.max(600, Math.round(width * 0.30));
      const padY = Math.max(600, Math.round(height * 0.30));

      let x0 = Math.max(0, bestRect.x - padX);
      let y0 = Math.max(0, bestRect.y - padY);
      let x1 = Math.min(width, bestRect.x + bestRect.width + padX);
      let y1 = Math.min(height, bestRect.y + bestRect.height + padY);

      const cropW = x1 - x0;
      const cropH = y1 - y0;

      if (cropW > 100 && cropH > 100) {
        const roi = new cv.Rect(x0, y0, cropW, cropH);
        const cropped = srcMat.roi(roi);

        const targetW = 2000;
        if (cropW < targetW) {
          const scale = targetW / cropW;
          const targetH = Math.round(cropH * scale);
          const scaled = new cv.Mat();
          cv.resize(cropped, scaled, new cv.Size(targetW, targetH), 0, 0, cv.INTER_CUBIC);
          cropped.delete();
          return scaled;
        }
        return cropped;
      }
    }
  } catch (err) {
    console.error("Auto-Crop in Mat failed: ", err);
  } finally {
    gray.delete();
    thresh.delete();
    contours.delete();
    hierarchy.delete();
  }

  return srcMat.clone();
}

function expectedDistanceFromMeta(meta, w, h, rulerLengthMm) {
  const pageHeightPt = meta ? (meta.pageHoehePt || meta.pageHöhePt) : null;
  if (!meta || !meta.isPdf || !meta.pageBreitePt || !pageHeightPt) return null;
  const pageWmm = meta.pageBreitePt / MM_TO_PT;
  const pageHmm = pageHeightPt / MM_TO_PT;
  if (pageWmm <= 0 || pageHmm <= 0) return null;

  const sourceW = Number(meta.sourceWidthPx);
  const sourceH = Number(meta.sourceHeightPx);
  const basisW = Number.isFinite(sourceW) && sourceW > 0 ? sourceW : w;
  const basisH = Number.isFinite(sourceH) && sourceH > 0 ? sourceH : h;

  const pxPerMmX = basisW / pageWmm;
  const pxPerMmY = basisH / pageHmm;
  const span = rulerLengthMm * ((pxPerMmX + pxPerMmY) / 2);
  return { horizontalPx: span, vertikalPx: span };
}

const PY_READ = `
import sys
from PIL import Image
img = Image.open(sys.argv[1]).convert('RGBA')
sys.stdout.write(f"{img.width} {img.height}\\n")
sys.stdout.flush()
sys.stdout.buffer.write(img.tobytes())
`;

const PY_WRITE = `
import sys
from PIL import Image
w, h, out = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
data = sys.stdin.buffer.read()
img = Image.frombytes('RGBA', (w, h), data)
img.save(out)
`;

// ─── 2. Drawing helpers (aligned with new arrow/crosshair style) ────────────
function drawCalibrationLine(mat, p0, p12, reliable, snapMm = 120) {
  const c = reliable
    ? new cv.Scalar(255, 0, 255, 255) // Magenta (high contrast, not used by stencil artwork)
    : new cv.Scalar(255, 64, 64, 255); // Red for fallback
  const lw = 2; // Thinner line width

  cv.line(mat, new cv.Point(Math.round(p0.x), Math.round(p0.y)), new cv.Point(Math.round(p12.x), Math.round(p12.y)), c, lw);

  // Draw the virtual ruler ticks (centimeters, half-centimeters, and millimeters)
  const rulerLen = Math.hypot(p12.x - p0.x, p12.y - p0.y);
  if (rulerLen > 10) {
    const dx = (p12.x - p0.x) / snapMm;
    const dy = (p12.y - p0.y) / snapMm;
    const ux = (p12.x - p0.x) / rulerLen;
    const uy = (p12.y - p0.y) / rulerLen;
    // Perpendicular vector
    const px = -uy;
    const py = ux;

    const maxDim = Math.max(mat.cols, mat.rows);
    const cmLen = Math.max(20, Math.round(maxDim / 80)); // Length of 1 cm tick
    const halfCmLen = Math.round(cmLen * 0.7);
    const mmLen = Math.round(cmLen * 0.45);

    for (let m = 0; m <= snapMm; m++) {
      const tx = p0.x + m * dx;
      const ty = p0.y + m * dy;
      
      let tickLen = mmLen;
      let tickWidth = 2;
      if (m % 10 === 0) {
        tickLen = cmLen;
        tickWidth = 5;
      } else if (m % 5 === 0) {
        tickLen = halfCmLen;
        tickWidth = 3;
      }
      
      const startPt = new cv.Point(Math.round(tx), Math.round(ty));
      const endPt = new cv.Point(Math.round(tx + px * tickLen), Math.round(ty + py * tickLen));
      cv.line(mat, startPt, endPt, c, tickWidth);


    }
  }

  function drawMarkers(endpoint, other) {
    const dx = other.x - endpoint.x;
    const dy = other.y - endpoint.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / len;
    const uy = dy / len;
    const px = -uy;
    const py = ux;

    const maxDim = Math.max(mat.cols, mat.rows);
    const half = Math.max(10, Math.round(maxDim / 120));
    const thick = Math.max(1.5, Math.round(maxDim / 600));
    const crosshairRadius = Math.max(4, Math.round(maxDim / 300));
    const lwCircle = Math.max(1, Math.round(maxDim / 1000));

    const tipPt = new cv.Point(Math.round(endpoint.x), Math.round(endpoint.y));

    const pts1 = new cv.Mat(4, 1, cv.CV_32SC2);
    pts1.data32S[0] = Math.round(endpoint.x + px * half);
    pts1.data32S[1] = Math.round(endpoint.y + py * half);
    pts1.data32S[2] = Math.round(endpoint.x + ux * thick);
    pts1.data32S[3] = Math.round(endpoint.y + uy * thick);
    pts1.data32S[4] = Math.round(endpoint.x - px * half);
    pts1.data32S[5] = Math.round(endpoint.y - py * half);
    pts1.data32S[6] = Math.round(endpoint.x - ux * thick);
    pts1.data32S[7] = Math.round(endpoint.y - uy * thick);
    const ptsVec1 = new cv.MatVector();
    ptsVec1.push_back(pts1);
    cv.fillPoly(mat, ptsVec1, c);
    pts1.delete();
    ptsVec1.delete();

    const pts2 = new cv.Mat(3, 1, cv.CV_32SC2);
    pts2.data32S[0] = Math.round(endpoint.x - ux * half);
    pts2.data32S[1] = Math.round(endpoint.y - uy * half);
    pts2.data32S[2] = Math.round(endpoint.x + px * thick);
    pts2.data32S[3] = Math.round(endpoint.y + py * thick);
    pts2.data32S[4] = Math.round(endpoint.x - px * thick);
    pts2.data32S[5] = Math.round(endpoint.y - py * thick);
    const ptsVec2 = new cv.MatVector();
    ptsVec2.push_back(pts2);
    cv.fillPoly(mat, ptsVec2, c);
    pts2.delete();
    ptsVec2.delete();

    cv.circle(mat, tipPt, crosshairRadius, new cv.Scalar(255, 255, 255, 216), -1);
    cv.circle(mat, tipPt, crosshairRadius, c, lwCircle);
  }

  drawMarkers(p0, p12);
  drawMarkers(p12, p0);
}

function drawGroundTruthLine(mat, p0, p12, snapMm = 120) {
  const c = new cv.Scalar(0, 255, 0, 255); // Bright Green
  const lw = 2; // Line width

  cv.line(mat, new cv.Point(Math.round(p0.x), Math.round(p0.y)), new cv.Point(Math.round(p12.x), Math.round(p12.y)), c, lw);

  const rulerLen = Math.hypot(p12.x - p0.x, p12.y - p0.y);
  if (rulerLen > 10) {
    const dx = (p12.x - p0.x) / snapMm;
    const dy = (p12.y - p0.y) / snapMm;
    const ux = (p12.x - p0.x) / rulerLen;
    const uy = (p12.y - p0.y) / rulerLen;
    // Perpendicular vector pointing opposite to detected ticks
    const px = uy;
    const py = -ux;

    const maxDim = Math.max(mat.cols, mat.rows);
    const cmLen = Math.max(20, Math.round(maxDim / 80)); // Length of 1 cm tick
    const halfCmLen = Math.round(cmLen * 0.7);
    const mmLen = Math.round(cmLen * 0.45);

    for (let m = 0; m <= snapMm; m++) {
      const tx = p0.x + m * dx;
      const ty = p0.y + m * dy;
      
      let tickLen = mmLen;
      let tickWidth = 2;
      if (m % 10 === 0) {
        tickLen = cmLen;
        tickWidth = 5;
      } else if (m % 5 === 0) {
        tickLen = halfCmLen;
        tickWidth = 3;
      }
      
      const startPt = new cv.Point(Math.round(tx), Math.round(ty));
      const endPt = new cv.Point(Math.round(tx + px * tickLen), Math.round(ty + py * tickLen));
      cv.line(mat, startPt, endPt, c, tickWidth);
    }

    // Label ground truth start/end
    const labelFontScale = Math.max(0.6, maxDim / 3000);
    const labelThick = Math.max(1, Math.round(labelFontScale * 2));
    cv.putText(mat, "0 (GT)", new cv.Point(Math.round(p0.x + px * 25), Math.round(p0.y + py * 25)), cv.FONT_HERSHEY_SIMPLEX, labelFontScale, new cv.Scalar(255, 255, 255, 255), labelThick + 2, cv.LINE_AA);
    cv.putText(mat, "0 (GT)", new cv.Point(Math.round(p0.x + px * 25), Math.round(p0.y + py * 25)), cv.FONT_HERSHEY_SIMPLEX, labelFontScale, c, labelThick, cv.LINE_AA);

    const labelTextEnd = `${snapMm / 10} (GT)`;
    cv.putText(mat, labelTextEnd, new cv.Point(Math.round(p12.x + px * 25), Math.round(p12.y + py * 25)), cv.FONT_HERSHEY_SIMPLEX, labelFontScale, new cv.Scalar(255, 255, 255, 255), labelThick + 2, cv.LINE_AA);
    cv.putText(mat, labelTextEnd, new cv.Point(Math.round(p12.x + px * 25), Math.round(p12.y + py * 25)), cv.FONT_HERSHEY_SIMPLEX, labelFontScale, c, labelThick, cv.LINE_AA);
  }

  // Draw circle markers for ground truth end points
  const maxDim = Math.max(mat.cols, mat.rows);
  const crosshairRadius = Math.max(6, Math.round(maxDim / 200));
  cv.circle(mat, new cv.Point(Math.round(p0.x), Math.round(p0.y)), crosshairRadius, c, 2);
  cv.circle(mat, new cv.Point(Math.round(p12.x), Math.round(p12.y)), crosshairRadius, c, 2);
}

function makePreviewBase(mat) {
  const gray = new cv.Mat();
  const out = new cv.Mat();
  cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
  cv.cvtColor(gray, out, cv.COLOR_GRAY2RGBA);
  gray.delete();
  return out;
}

function saveMatAsPng(mat, outPath) {
  let toSave = mat;
  const maxDim = 2000;
  if (mat.cols > maxDim || mat.rows > maxDim) {
    const scale = maxDim / Math.max(mat.cols, mat.rows);
    toSave = new cv.Mat();
    cv.resize(mat, toSave, new cv.Size(
      Math.round(mat.cols * scale),
      Math.round(mat.rows * scale)
    ), 0, 0, cv.INTER_AREA);
  }

  const runSave = () => cp.spawnSync('python3', ['-c', PY_WRITE,
    toSave.cols.toString(), toSave.rows.toString(), outPath
  ], { input: Buffer.from(toSave.data), maxBuffer: 150 * 1024 * 1024, timeout: 60000 });

  let proc = runSave();
  if (proc.status !== 0) {
    proc = runSave();
  }

  if (toSave !== mat) toSave.delete();
  if (proc.status !== 0) throw new Error(proc.stderr.toString().trim().substring(0, 200));
}

function loadImageAsMat(imgPath) {
  const proc = cp.spawnSync('python3', ['-c', PY_READ, imgPath],
    { maxBuffer: 150 * 1024 * 1024, timeout: 30000 });
  if (proc.status !== 0) throw new Error(proc.stderr.toString().trim().substring(0, 200));
  const buf = proc.stdout;
  const nl = buf.indexOf(10);
  const [w, h] = buf.slice(0, nl).toString().trim().split(' ').map(Number);
  const rgba = buf.slice(nl + 1);
  const mat = new cv.Mat(h, w, cv.CV_8UC4);
  mat.data.set(rgba);
  return { mat, width: w, height: h };
}

// ─── 3. Run all tests ───────────────────────────────────────────────────────
function runAllTests() {
  const GT_PATH = path.join(__dirname, 'ruler_ground_truth.json');
  let groundTruth = {};
  let gtExists = false;
  if (fs.existsSync(GT_PATH)) {
    try {
      groundTruth = JSON.parse(fs.readFileSync(GT_PATH, 'utf8'));
      gtExists = true;
      console.log(`Loaded ground truth for ${Object.keys(groundTruth).length} stencils.`);
    } catch (err) {
      console.error('Failed to parse ruler_ground_truth.json:', err.message);
    }
  }

  let files = fs.readdirSync(STENCILS_DIR)
    .filter(f => !f.startsWith('.') &&
      (f.endsWith('.pdf') || f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.png')))
    .sort((a, b) => a.localeCompare(b, 'de'));

  if (process.argv[2]) {
    const targetFile = process.argv[2];
    files = files.filter(f => f.includes(targetFile));
  }

  console.log(`Processing ${files.length} stencil files for ${ALL_VERSIONS.length} algorithm versions...\n`);
  const sep = '-'.repeat(130);
  console.log(sep);
  console.log(`| ${'File'.padEnd(38)} | ${'Version'.padEnd(18)} | ${'Status'.padEnd(8)} | ${'Method'.padEnd(30)} | ${'cm'.padEnd(5)} | ${'GT-Diff'.padEnd(12)} |`);
  console.log(sep);

  let successCount = 0;
  let fallbackCount = 0;
  let errorCount = 0;
  let gtPassedAll = true;
  let gtModified = false;
  const reportRows = [];
  const rowsByVersion = new Map();
  for (const v of ALL_VERSIONS) rowsByVersion.set(v, []);

  if (!files.length) {
    console.log('No stencil files found.');
    process.exit(1);
  }

  for (const file of files) {
    const filePath = path.join(STENCILS_DIR, file);
    let tempPng = null;
    let baseMat = null;

    try {
      let imgPath = filePath;

      if (file.endsWith('.pdf')) {
        const prefix = path.join(os.tmpdir(), `stoma_${Date.now()}`);
        const r = cp.spawnSync('/opt/homebrew/bin/pdftoppm',
          ['-png', '-r', '216', '-f', '1', '-l', '1', filePath, prefix],
          { timeout: 15000 });
        if (r.status !== 0) throw new Error('pdftoppm failed');
        tempPng = `${prefix}-1.png`;
        imgPath = tempPng;
      }

      const { mat: src, width, height } = loadImageAsMat(imgPath);
      let preProcessed = src;
      if (!file.endsWith('.pdf')) {
        preProcessed = cropAndScaleStencilIfPossibleMat(src);
        src.delete();
      }
      const deskewRes = deskew(preProcessed);
      baseMat = deskewRes.mat;
      preProcessed.delete();

      let meta = { filename: file };
      if (file.endsWith('.pdf')) {
        meta.isPdf = true;
        meta.pageIndex = 1;
        meta.pageBreitePt = width / 3;
        meta.pageHöhePt = height / 3;
        meta.renderScale = 3.0;
        meta.sourceWidthPx = width;
        meta.sourceHeightPx = height;
      }

      const isVerified = gtExists && !!groundTruth[file];
      const isPublicare = file.toLowerCase().includes('publicare') || file.includes('0-10') || file.includes('Spontantest');
      const rulerMm = isVerified ? groundTruth[file].rulerLengthMm : (isPublicare ? 100 : 120);

      const perVersionRows = new Map();

      for (const algo of ACTIVE_ALGORITHMS) {
        const mat = baseMat.clone();
        const flippedMat = new cv.Mat();
        cv.rotate(mat, flippedMat, cv.ROTATE_180);
        let activeMat = null;

        try {
          const rulerNormal = algo.detect(mat, meta, rulerMm);
          const rulerFlipped = algo.detect(flippedMat, meta, rulerMm);

          const cands = [];
          if (rulerNormal) cands.push({ ruler: rulerNormal, isFlipped: false, mat: mat });
          if (rulerFlipped) cands.push({ ruler: rulerFlipped, isFlipped: true, mat: flippedMat });

          let chosen = null;
          if (cands.length > 0) {
            cands.sort((a, b) => {
              const ra = a.ruler;
              const rb = b.ruler;
              if (ra.reliable && !rb.reliable) return -1;
              if (!ra.reliable && rb.reliable) return 1;

              if (Math.abs(ra.score - rb.score) > 200) {
                return rb.score - ra.score;
              }

              const ma = ra.ocrDigits ? ra.ocrDigits.filter(d => d.matched).length : 0;
              const mb = rb.ocrDigits ? rb.ocrDigits.filter(d => d.matched).length : 0;
              if (ma !== mb) return mb - ma;
              
              const aMatchesHint = (ra.detectedLengthMm === rulerMm);
              const bMatchesHint = (rb.detectedLengthMm === rulerMm);
              if (aMatchesHint && !bMatchesHint) return -1;
              if (!aMatchesHint && bMatchesHint) return 1;
              const aIsTick = ra.method && ra.method.includes("Tick-Cluster");
              const bIsTick = rb.method && rb.method.includes("Tick-Cluster");
              if (aIsTick && !bIsTick) return -1;
              if (!aIsTick && bIsTick) return 1;
              return (rb.score || 0) - (ra.score || 0);
            });
            chosen = cands[0];
          }

          let ruler;
          let methodPrefix = "";
          if (chosen) {
            ruler = chosen.ruler;
            activeMat = chosen.mat.clone();
            methodPrefix = chosen.isFlipped ? "[rot180] " : "";
          } else {
            ruler = null;
            activeMat = mat.clone();
          }

          let p0;
          let p12;
          let reliable;
          let method;
          let snapMm;

          let ocrDigits = [];
          if (ruler) {
            ({ p0, p12, reliable, method, detectedLengthMm: snapMm, ocrDigits } = ruler);
            method = methodPrefix + method;
          } else {
            p0 = { x: activeMat.cols * 0.2, y: activeMat.rows * 0.4 };
            p12 = { x: activeMat.cols * 0.8, y: activeMat.rows * 0.4 };
            reliable = false;
            method = '[' + algo.id + '] NONE (fallback)';
            snapMm = rulerMm;
          }

          const status = reliable ? 'OK' : 'FALLBK';
          if (reliable) {
            successCount += 1;
          } else {
            fallbackCount += 1;
          }

          const cm = `${snapMm / 10}`;
          const truncMethod = method.padEnd(30).substring(0, 30);
          const spanPx = Math.hypot(p12.x - p0.x, p12.y - p0.y);

          const printP0 = chosen && chosen.isFlipped ? { x: activeMat.cols - p0.x, y: activeMat.rows - p0.y } : p0;
          const printP12 = chosen && chosen.isFlipped ? { x: activeMat.cols - p12.x, y: activeMat.rows - p12.y } : p12;
          console.log(`[COORD PRINT] ${file}: p0=(${printP0.x.toFixed(2)}, ${printP0.y.toFixed(2)}), p12=(${printP12.x.toFixed(2)}, ${printP12.y.toFixed(2)}), rulerLengthMm=${snapMm}`);

          // Ground Truth check
          let gtStatus = '';
          let isMatch = false;
          let maxErrMm = 0;
          if (isVerified) {
            const gt = groundTruth[file];
            const detP0_normal = chosen && chosen.isFlipped ? { x: activeMat.cols - p0.x, y: activeMat.rows - p0.y } : p0;
            const detP12_normal = chosen && chosen.isFlipped ? { x: activeMat.cols - p12.x, y: activeMat.rows - p12.y } : p12;

            const gtP0_normal = gt.p0;
            const gtP12_normal = gt.p12;

            const gtP0_flipped = { x: activeMat.cols - gt.p0.x, y: activeMat.rows - gt.p0.y };
            const gtP12_flipped = { x: activeMat.cols - gt.p12.x, y: activeMat.rows - gt.p12.y };

            const err1 = Math.max(Math.hypot(detP0_normal.x - gtP0_normal.x, detP0_normal.y - gtP0_normal.y), Math.hypot(detP12_normal.x - gtP12_normal.x, detP12_normal.y - gtP12_normal.y));
            const err2 = Math.max(Math.hypot(detP0_normal.x - gtP12_normal.x, detP0_normal.y - gtP12_normal.y), Math.hypot(detP12_normal.x - gtP0_normal.x, detP12_normal.y - gtP0_normal.y));
            const err3 = Math.max(Math.hypot(detP0_normal.x - gtP0_flipped.x, detP0_normal.y - gtP0_flipped.y), Math.hypot(detP12_normal.x - gtP12_flipped.x, detP12_normal.y - gtP12_flipped.y));
            const err4 = Math.max(Math.hypot(detP0_normal.x - gtP12_flipped.x, detP0_normal.y - gtP12_flipped.y), Math.hypot(detP12_normal.x - gtP0_flipped.x, detP12_normal.y - gtP0_flipped.y));

            const finalErrPx = Math.min(err1, err2, err3, err4);
            const pxPerMm = spanPx / snapMm;
            maxErrMm = finalErrPx / pxPerMm;

            console.log(`[DEBUG GT] detP0_normal=(${detP0_normal.x.toFixed(1)}, ${detP0_normal.y.toFixed(1)})`);
            console.log(`[DEBUG GT] detP12_normal=(${detP12_normal.x.toFixed(1)}, ${detP12_normal.y.toFixed(1)})`);
            console.log(`[DEBUG GT] gtP0_normal=(${gtP0_normal.x.toFixed(1)}, ${gtP0_normal.y.toFixed(1)})`);
            console.log(`[DEBUG GT] gtP12_normal=(${gtP12_normal.x.toFixed(1)}, ${gtP12_normal.y.toFixed(1)})`);
            console.log(`[DEBUG GT] finalErrPx=${finalErrPx.toFixed(1)}, pxPerMm=${pxPerMm.toFixed(2)}, maxErrMm=${maxErrMm.toFixed(2)}`);

            let prefix = reliable ? '' : 'F_';

            if (maxErrMm > 2.0) {
              gtStatus = `NOT MATCH (${prefix}${maxErrMm.toFixed(2)}mm)`;
              gtPassedAll = false;
              isMatch = false;
            } else {
              gtStatus = `MATCH (${prefix}${maxErrMm.toFixed(2)}mm)`;
              isMatch = true;
            }
            if (!reliable) gtPassedAll = false;
          } else {
            gtStatus = 'SKIP';
          }

          const preview = makePreviewBase(activeMat);
          drawCalibrationLine(preview, p0, p12, reliable, snapMm);

          if (isVerified) {
            const gt = groundTruth[file];
            let gtP0_toDraw = gt.p0;
            let gtP12_toDraw = gt.p12;
            if (chosen && chosen.isFlipped) {
              gtP0_toDraw = { x: activeMat.cols - gt.p0.x, y: activeMat.rows - gt.p0.y };
              gtP12_toDraw = { x: activeMat.cols - gt.p12.x, y: activeMat.rows - gt.p12.y };
            }
            drawGroundTruthLine(preview, gtP0_toDraw, gtP12_toDraw, rulerMm);
          }


          const baseName = path.basename(file, path.extname(file));
          const folderName = isVerified ? (isMatch ? 'match' : 'not_match') : 'unsure';
          const versionDir = path.join(OUTPUT_DIR, folderName);
          if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });
          saveMatAsPng(preview, path.join(versionDir, `${baseName}_preview.png`));
          preview.delete();

          console.log(`| ${file.padEnd(38)} | ${algo.id.padEnd(18)} | ${status.padEnd(8)} | ${truncMethod} | ${cm.padEnd(5)} | ${gtStatus.padEnd(12)} |`);
          
          const expectedObj = expectedDistanceFromMeta(meta, activeMat.cols, activeMat.rows, rulerMm);
          const orientHorizontal = Math.abs(p12.x - p0.x) >= Math.abs(p12.y - p0.y);
          const expectedSpanPx = expectedObj ? (orientHorizontal ? expectedObj.horizontalPx : expectedObj.vertikalPx) : null;

          const row = {
            file,
            version: algo.id,
            status,
            method,
            cm,
            angle: `${(deskewRes.angle || 0).toFixed(1)}°`,
            spanPx,
            expectedSpanPx,
            gtStatus,
          };
          reportRows.push(row);
          rowsByVersion.get(algo.id).push(row);
          perVersionRows.set(algo.id, row);
        } finally {
          mat.delete();
          flippedMat.delete();
          if (activeMat) activeMat.delete();
        }
      }

    } catch (err) {
      for (const version of ALL_VERSIONS) {
        errorCount += 1;
        const msg = (err.message || '').substring(0, 30);
        console.log(`| ${file.padEnd(38)} | ${version.padEnd(18)} | ERROR    | ${msg.padEnd(30)} | -     |`);
        const row = { file, version, status: 'ERROR', method: msg, cm: '-', angle: '-' };
        reportRows.push(row);
        rowsByVersion.get(version).push(row);
      }
      console.error(err.stack || err);
    } finally {
      if (baseMat) {
        try { baseMat.delete(); } catch (_) {}
      }
      if (tempPng && fs.existsSync(tempPng)) {
        try { fs.unlinkSync(tempPng); } catch (_) {}
      }
    }
  }

  const totalReliable = reportRows.filter((r) => r.status === 'OK').length;
  const totalFallback = reportRows.filter((r) => r.status === 'FALLBK').length;
  const totalErrors = reportRows.filter((r) => r.status === 'ERROR').length;

  console.log(sep);
  console.log(`\nDone. ${totalReliable} reliable, ${totalFallback} fallback, ${totalErrors} errors.`);
  console.log(`Previews saved to: ${OUTPUT_DIR}/`);

  writeResultsReport(reportRows, {
    successCount: totalReliable,
    fallbackCount: totalFallback,
    errorCount: totalErrors,
    filesCount: files.length,
  });
  writePerAlgorithmReports(rowsByVersion, files.length);
  console.log(`Results report updated: ${RESULTS_MD}`);

  // Ground truth is strictly human-verified and no longer auto-updated here.

  if (!gtPassedAll) {
    console.error('\nERROR: Ground Truth validation failed for one or more stencils!');
    process.exit(1);
  }

  process.exit(0);
}

function resetTestOutputs() {
  if (fs.existsSync(OUTPUT_DIR)) {
    fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function writeResultsReport(rows, totals) {
  const now = new Date().toISOString();
  const lines = [];
  lines.push('# Stoma Scaling Tool: Test Execution Report');
  lines.push('');
  lines.push('Generated: ' + now);
  lines.push('');
  lines.push('Scope: Cleared previous outputs, tested with unified current-merged.');
  lines.push('');
  lines.push('## Results');
  lines.push('');
  lines.push('| File | Version | Status | Method | cm | Angle | GT Status |');
  lines.push('| :--- | :--- | :--- | :--- | :--- | :--- | :--- |');
  for (const row of rows) {
    lines.push('| ' + row.file + ' | ' + row.version + ' | ' + row.status + ' | ' + row.method + ' | ' + row.cm + ' | ' + row.angle + ' | ' + row.gtStatus + ' |');
  }
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('- Files tested: ' + totals.filesCount);
  lines.push('- Algorithm versions: ' + ALL_VERSIONS.length);
  lines.push('- Reliable detections: ' + totals.successCount);
  lines.push('- Fallback detections: ' + totals.fallbackCount);
  lines.push('- Errors: ' + totals.errorCount);
  fs.writeFileSync(RESULTS_MD, lines.join('\n') + '\n', 'utf8');
}

function writePerAlgorithmReports(rowsByVersion, filesCount) {
  for (const version of ALL_VERSIONS) {
    const rows = rowsByVersion.get(version) || [];
    const okCount = rows.filter((r) => r.status === 'OK').length;
    const fallbackCount = rows.filter((r) => r.status === 'FALLBK').length;
    const errorCount = rows.filter((r) => r.status === 'ERROR').length;

    const lines = [];
    lines.push('# Stoma Test Report: ' + version);
    lines.push('');
    lines.push('| File | Status | Method | cm | Angle | GT Status |');
    lines.push('| :--- | :--- | :--- | :--- | :--- | :--- |');
    for (const row of rows) {
      lines.push('| ' + row.file + ' | ' + row.status + ' | ' + row.method + ' | ' + row.cm + ' | ' + row.angle + ' | ' + row.gtStatus + ' |');
    }
    lines.push('');
    lines.push('Summary: tested=' + filesCount + ', ok=' + okCount + ', fallback=' + fallbackCount + ', errors=' + errorCount);

    const reportPath = path.join(OUTPUT_DIR, 'report.md');
    fs.writeFileSync(reportPath, lines.join('\n') + '\n', 'utf8');
  }
}
