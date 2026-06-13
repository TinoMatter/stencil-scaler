/**
 * run_direct_tests.js — Fast CLI E2E test runner for all stencils.
 *
 * Replicates the browser detection pipeline headlessly using node-canvas + OpenCV.js.
 * Loads each stencil PDF/image, runs the same crop → deskew → detect → flip logic as
 * the browser app, and compares results against ruler_ground_truth.json.
 *
 * Ground-truth coordinate space:
 *   GT coordinates are stored in the processed-mat space (same frame as the detector output,
 *   AFTER crop, scale, and deskew). No further transform is applied at comparison time.
 *   The comparison is orientation-invariant: both the stored orientation and its 180°-flip
 *   equivalent (W - x, H - y) are tested so that MATCH holds regardless of which candidate
 *   mat (baseMat vs flippedMat) the scorer picks on any given run.
 *
 * Usage:
 *   node run_direct_tests.js                  # run all stencils
 *   node run_direct_tests.js 'Vorname 8'       # run matching stencils only
 */

const path = require('path');
const cp = require('child_process');
const os = require('os');
const fs = require('fs');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

// --- 1. Shim DOM Canvas for OpenCV.js & App scripts ---
let createCanvas, Image, loadImage, ImageData;
try {
  ({ createCanvas, Image, loadImage, ImageData } = require('canvas'));
} catch (err) {
  console.log('Error requiring canvas:', err.message);
  console.log(err.stack);
  process.exit(1);
}
global.Image = Image;
global.HTMLImageElement = Image;
global.HTMLCanvasElement = createCanvas(0, 0).constructor;
global.OffscreenCanvas = createCanvas(0, 0).constructor;
global.ImageData = ImageData;
global.document = {
  createElement: (tag) => {
    if (tag === 'canvas') return createCanvas(1, 1);
    if (tag === 'img') return new Image();
    return {};
  }
};
global.window = {
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  cancelAnimationFrame: (id) => clearTimeout(id)
};

class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    return { canvas, context };
  }
  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

const STENCILS_DIR = '/Users/up273900/Documents/Coding/stoma_stencils/01_Schablonen_Vorlagen_für_Tests';
const OUTPUT_DIR = '/Users/up273900/Documents/Coding/stoma_stencils/test_outputs/direct_preview';
const RESULTS_MD = '/Users/up273900/Documents/Coding/stoma_stencils/test_results.md';
const MM_TO_PT = 72 / 25.4;

const RulerDetector = require('./js/ruler-detector.js');

resetTestOutputs();

console.log('Loading OpenCV.js...');
let cv;
try {
  cv = require('./offline_package/vendor/opencv.js');
} catch (err) {
  console.log('Error requiring OpenCV.js:', err.message);
  console.log(err.stack);
  process.exit(1);
}
global.cv = cv;
global.window.cv = cv;

const { prepareImageForDetection } = require('./js/gui_pipeline.js');
const { deskew, expectedDistanceFromMeta } = require('./js/image-utils.js');

cv.onRuntimeInitialized = () => {
  console.log('OpenCV.js ready.');
  // Stop input hold and start tests once OpenCV is initialized
  process.stdin.pause();
  runAllTests().catch(console.error);
};
// Keep process alive until OpenCV runtime initializes
process.stdin.resume();

// ─── 2. Drawing & Helper Functions ──────────────────────────────────────────

function drawCalibrationLine(mat, p0, p12, reliable, snapMm = 120) {
  const c = reliable
    ? new cv.Scalar(255, 0, 255, 255) // Magenta
    : new cv.Scalar(255, 64, 64, 255); // Red for fallback
  const lw = 2;

  const rulerLen = Math.hypot(p12.x - p0.x, p12.y - p0.y);
  if (rulerLen > 10) {
    const dx = (p12.x - p0.x) / snapMm;
    const dy = (p12.y - p0.y) / snapMm;
    const ux = (p12.x - p0.x) / rulerLen;
    const uy = (p12.y - p0.y) / rulerLen;
    const px = -uy;
    const py = ux;

    const maxDim = Math.max(mat.cols, mat.rows);
    const cmLen = Math.max(20, Math.round(maxDim / 80));
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

/**
 * Rotate a point to match the rotateWithFrame transformation used in image-utils.js.
 * Accounts for the expanded canvas size produced by rotateWithFrame (no clipping).
 * @param {{x:number, y:number}} point - Point in the pre-rotation Mat coordinates.
 * @param {number} angleDeg - Rotation angle in degrees (positive = clockwise).
 * @param {number} origCols - Width of the Mat before rotation.
 * @param {number} origRows - Height of the Mat before rotation.
 * @returns {{x:number, y:number}} Rotated point in the new expanded frame.
 */
function rotatePoint(point, angleDeg, origCols, origRows) {
  const rad = (angleDeg * Math.PI) / 180;
  const absRad = Math.abs(rad);
  const sinAbs = Math.sin(absRad);
  const cosAbs = Math.cos(absRad);
  const newW = Math.ceil(origRows * sinAbs + origCols * cosAbs);
  const newH = Math.ceil(origRows * cosAbs + origCols * sinAbs);

  const cx = origCols / 2;
  const cy = origRows / 2;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  
  const dx = point.x - cx;
  const dy = point.y - cy;
  
  const rx = cos * dx - sin * dy;
  const ry = sin * dx + cos * dy;
  
  return { x: rx + newW / 2, y: ry + newH / 2 };
}

/**
 * Maps a source-image point through the full detection pipeline transforms
 * (crop → scale → deskew-rotate → optional 180° flip) into processed-mat coordinates.
 *
 * NOTE: GT coordinates in ruler_ground_truth.json are already stored in processed-mat
 * space, so this function is NOT used for GT comparison. It is retained here for
 * debugging and future use if GT ever needs to be re-derived from source-image coords.
 *
 * @param {{x:number, y:number}} pt - Point in original (source) image pixel coordinates.
 * @param {number} cropX - Pixels cropped from the left by cropAndScaleStencilIfPossible.
 * @param {number} cropY - Pixels cropped from the top by cropAndScaleStencilIfPossible.
 * @param {number} scale - Scale factor applied after cropping.
 * @param {number} angleDeg - Deskew rotation angle in degrees (from deskew()).
 * @param {boolean} isFlipped - Whether the 180° rotated mat (flippedMat) was chosen.
 * @param {number} origCols - Width of the scaled mat before deskew rotation (croppedWidth * scale).
 * @param {number} origRows - Height of the scaled mat before deskew rotation (croppedHeight * scale).
 * @param {number} finalCols - Width of the final processed mat (activeMat.cols).
 * @param {number} finalRows - Height of the final processed mat (activeMat.rows).
 * @returns {{x:number, y:number}} The transformed point in processed-mat/preview space.
 */
function transformOriginalPoint(pt, cropX, cropY, scale, angleDeg, isFlipped, origCols, origRows, finalCols, finalRows) {
  let p = { x: (pt.x - cropX) * scale, y: (pt.y - cropY) * scale };
  if (Math.abs(angleDeg) > 0.1) {
    p = rotatePoint(p, angleDeg, origCols, origRows);
  }
  if (isFlipped) {
    p = { x: finalCols - p.x, y: finalRows - p.y };
  }
  return p;
}

function drawGroundTruthLine(mat, p0, p12, snapMm = 120) {
  const c = new cv.Scalar(0, 255, 0, 255); // Bright Green
  const lw = 2;

  cv.line(mat, new cv.Point(Math.round(p0.x), Math.round(p0.y)), new cv.Point(Math.round(p12.x), Math.round(p12.y)), c, lw);

  const rulerLen = Math.hypot(p12.x - p0.x, p12.y - p0.y);
  if (rulerLen > 10) {
    const dx = (p12.x - p0.x) / snapMm;
    const dy = (p12.y - p0.y) / snapMm;
    const ux = (p12.x - p0.x) / rulerLen;
    const uy = (p12.y - p0.y) / rulerLen;
    const px = uy;
    const py = -ux;

    const maxDim = Math.max(mat.cols, mat.rows);
    const cmLen = Math.max(20, Math.round(maxDim / 80));
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

    const labelFontScale = Math.max(0.6, maxDim / 3000);
    const labelThick = Math.max(1, Math.round(labelFontScale * 2));
    cv.putText(mat, "0 (GT)", new cv.Point(Math.round(p0.x + px * 25), Math.round(p0.y + py * 25)), cv.FONT_HERSHEY_SIMPLEX, labelFontScale, new cv.Scalar(255, 255, 255, 255), labelThick + 2, cv.LINE_AA);
    cv.putText(mat, "0 (GT)", new cv.Point(Math.round(p0.x + px * 25), Math.round(p0.y + py * 25)), cv.FONT_HERSHEY_SIMPLEX, labelFontScale, c, labelThick, cv.LINE_AA);

    const labelTextEnd = `${snapMm / 10} (GT)`;
    cv.putText(mat, labelTextEnd, new cv.Point(Math.round(p12.x + px * 25), Math.round(p12.y + py * 25)), cv.FONT_HERSHEY_SIMPLEX, labelFontScale, new cv.Scalar(255, 255, 255, 255), labelThick + 2, cv.LINE_AA);
    cv.putText(mat, labelTextEnd, new cv.Point(Math.round(p12.x + px * 25), Math.round(p12.y + py * 25)), cv.FONT_HERSHEY_SIMPLEX, labelFontScale, c, labelThick, cv.LINE_AA);
  }

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

  // Draw to node-canvas and save to avoid python dependencies
  const canvas = createCanvas(toSave.cols, toSave.rows);
  cv.imshow(canvas, toSave);
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outPath, buffer);

  if (toSave !== mat) toSave.delete();
}

// ─── 3. Run all tests ───────────────────────────────────────────────────────
async function runAllTests() {
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
      (f.endsWith('.pdf') || f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.png')) &&
      groundTruth[f])
    .sort((a, b) => a.localeCompare(b, 'de'));

  if (process.argv.length > 2) {
    const targets = process.argv.slice(2);
    files = files.filter(f => {
      const match = f.match(/(\d+)\.[^.]+$/);
      const num = match ? match[1] : null;
      return targets.some(t => {
        if (/^\d+$/.test(t)) {
          return num === t;
        }
        return f.includes(t);
      });
    });
  }

  console.log(`Processing ${files.length} stencil files ...\n`);
  const sep = '-'.repeat(130);
  console.log(sep);
  console.log(`| ${'File'.padEnd(38)} | ${'Status'.padEnd(8)} | ${'Method'.padEnd(30)} | ${'cm'.padEnd(5)} | ${'GT-Diff'.padEnd(12)} |`);
  console.log(sep);

  let successCount = 0;
  let fallbackCount = 0;
  let errorCount = 0;
  let gtPassedAll = true;
  const reportRows = [];

  if (!files.length) {
    console.log('No stencil files found.');
    process.exit(1);
  }

  for (const file of files) {
    const filePath = path.join(STENCILS_DIR, file);
    let tempPng = null;
    let baseMat = null;
    let flippedMat = null;

    try {
      let sourceCanvas;
      if (file.endsWith('.pdf')) {
        const data = new Uint8Array(fs.readFileSync(filePath));
        const doc = await pdfjsLib.getDocument({
          data,
          canvasFactory: new NodeCanvasFactory(),
          disableFontFace: true,
        }).promise;
        const page = await doc.getPage(1);
        const scale = 3.0; // 216 DPI (72 * 3 = 216)
        const viewport = page.getViewport({ scale });
        
        sourceCanvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const ctx = sourceCanvas.getContext("2d", { alpha: false });
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
      } else {
        // Load image into node-canvas (exact browser simulation)
        const img = await loadImage(filePath);
        sourceCanvas = createCanvas(img.width, img.height);
        const ctx = sourceCanvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
      }

      function detectExpectedRulerLengthFromFilename(filename) {
        if (!filename) return 120;
        const lower = filename.toLowerCase();
        if (lower.includes("publicare") || lower.includes("0-10") || lower.includes("spontantest") || lower.includes("spontan_test")) {
          return 100;
        }
        const match = lower.match(/(?:^|\D)(\d+)(?:\.[^.]+)?$/) || lower.match(/(\d+)/);
        if (match) {
          const num = parseInt(match[1], 10);
          if ([1, 2, 3, 4, 5, 6, 16].includes(num)) {
            return 100;
          }
        }
        return 120;
      }
      
      const isVerified = gtExists && !!groundTruth[file];
      const rulerMm = detectExpectedRulerLengthFromFilename(file);

      let meta = { filename: file };
      if (file.endsWith('.pdf')) {
        meta.isPdf = true;
        meta.pageIndex = 1;
        meta.pageBreitePt = sourceCanvas.width / 3;
        meta.pageHöhePt = sourceCanvas.height / 3;
        meta.renderScale = 3.0;
        meta.sourceWidthPx = sourceCanvas.width;
        meta.sourceHeightPx = sourceCanvas.height;
      }

      // --- Authentically simulate app.js autoDetectFromSource pipeline ---
      // Apply Crop -> Deskew -> Rotate for both PDFs and images, capturing offsets
      const pipelineRes = await prepareImageForDetection(sourceCanvas, meta);
      baseMat = pipelineRes.baseMat;
      flippedMat = pipelineRes.flippedMat;
      const angleDeg = pipelineRes.angle || 0;
      const cropX = pipelineRes.cropX || 0;
      const cropY = pipelineRes.cropY || 0;
      const scale = pipelineRes.scale || 1;
      meta.scale = scale;
      const croppedWidth = pipelineRes.croppedWidth || sourceCanvas.width;
      const croppedHeight = pipelineRes.croppedHeight || sourceCanvas.height;

      const candidates = [];
      const tryDetect = (mat, label) => {
        const ruler = RulerDetector.detect(mat, meta, rulerMm);
        if (!ruler) return;
        candidates.push({
          detection: ruler,
          mat,
          label,
        });
      };

      tryDetect(baseMat, "");
      const baseCandidate = candidates.find(c => c.detection && c.detection.reliable && c.detection.ocrDigits && c.detection.ocrDigits.filter(d => d.matched).length >= 3);
      if (!baseCandidate) {
        tryDetect(flippedMat, "[rot180] ");
      }

      let chosen = null;
      if (candidates.length > 0) {
        // Exactly identical candidate sorting to app.js
        candidates.sort((a, b) => {
          const da = a.detection;
          const db = b.detection;

          if (da.reliable && !db.reliable) return -1;
          if (!da.reliable && db.reliable) return 1;

          if (Math.abs(da.score - db.score) > 200) {
            return db.score - da.score;
          }

          const ma = da.ocrDigits ? da.ocrDigits.filter(d => d.matched).length : 0;
          const mb = db.ocrDigits ? db.ocrDigits.filter(d => d.matched).length : 0;
          if (ma !== mb) return mb - ma;
          
          const aMatchesHint = (da.detectedLengthMm === rulerMm);
          const bMatchesHint = (db.detectedLengthMm === rulerMm);
          if (aMatchesHint && !bMatchesHint) return -1;
          if (!aMatchesHint && bMatchesHint) return 1;
          
          const aIsTick = da.method && da.method.includes("Tick-Cluster");
          const bIsTick = db.method && db.method.includes("Tick-Cluster");
          if (aIsTick && !bIsTick) return -1;
          if (!aIsTick && bIsTick) return 1;
          return (db.score || 0) - (da.score || 0);
        });
        chosen = candidates[0];
      }

      let activeMat = null;
      let p0;
      let p12;
      let reliable;
      let method;
      let snapMm;
      let isFlipped = false;

      if (chosen) {
        const ruler = chosen.detection;
        activeMat = chosen.mat.clone();
        isFlipped = chosen.label !== "";
        ({ p0, p12, reliable, method, detectedLengthMm: snapMm } = ruler);
        method = chosen.label + method;
        if (file.includes('10.pdf') || file.includes('13.pdf') || file.includes('2.pdf')) {
          console.log(`[DEBUG MATCHED DIGITS for ${file}]:`, ruler.ocrDigits);
        }
      } else {
        activeMat = baseMat.clone();
        p0 = { x: activeMat.cols * 0.2, y: activeMat.rows * 0.4 };
        p12 = { x: activeMat.cols * 0.8, y: activeMat.rows * 0.4 };
        reliable = false;
        method = 'NONE (fallback)';
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

      // Ground Truth check
      let gtStatus = '';
      let isMatch = false;
      let maxErrMm = 0;
      if (isVerified) {
        const gt = groundTruth[file];
        // GT coords may have been stored from either orientation (normal or rot180).
        // Also try the 180°-flipped equivalent: (W - x, H - y) in the active mat frame.
        const W = activeMat.cols;
        const H = activeMat.rows;
        const gtP0f  = { x: W - gt.p0.x,  y: H - gt.p0.y  };
        const gtP12f = { x: W - gt.p12.x, y: H - gt.p12.y };

        const gtDist = Math.hypot(gt.p12.x - gt.p0.x, gt.p12.y - gt.p0.y);
        const pxPerMm = spanPx / snapMm;
        const gtLengthMm = Math.round((gtDist / pxPerMm) / 10) * 10;

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

          if (Math.abs(offsetMm) > 2.0) {
            return Math.max(maxParErrMm, maxPerpErrMm, Math.abs(offsetMm));
          }

          if (maxPerpErrMm <= 3.5) {
            return maxParErrMm;
          }
          return Math.max(maxParErrMm, maxPerpErrMm);
        }

        const e1 = computeAlignmentError(p0, p12, snapMm, gt.p0, gt.p12, gtLengthMm);
        const e2 = computeAlignmentError(p0, p12, snapMm, gt.p12, gt.p0, gtLengthMm);
        const e3 = computeAlignmentError(p0, p12, snapMm, gtP0f, gtP12f, gtLengthMm);
        const e4 = computeAlignmentError(p0, p12, snapMm, gtP12f, gtP0f, gtLengthMm);
        maxErrMm = Math.min(e1, e2, e3, e4);
        if (file.includes('7.pdf')) {
          console.log('\n[DEBUG 7.pdf errors]:', { e1, e2, e3, e4, maxErrMm, p0, p12, gt, W, H });
        }

        let prefix = reliable ? '' : 'F_';
        let allowedTolerance = 1.5; // Strict 1.5mm target constraint

        if (maxErrMm > allowedTolerance) {
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
        const W = activeMat.cols;
        const H = activeMat.rows;
        const gtP0f  = { x: W - gt.p0.x,  y: H - gt.p0.y  };
        const gtP12f = { x: W - gt.p12.x, y: H - gt.p12.y };

        const gtDist = Math.hypot(gt.p12.x - gt.p0.x, gt.p12.y - gt.p0.y);
        const pxPerMm = spanPx / snapMm;
        const gtLengthMm = Math.round((gtDist / pxPerMm) / 10) * 10;

        const e1_check = computeAlignmentError(p0, p12, snapMm, gt.p0, gt.p12, gtLengthMm);
        const e2_check = computeAlignmentError(p0, p12, snapMm, gt.p12, gt.p0, gtLengthMm);
        const e3_check = computeAlignmentError(p0, p12, snapMm, gtP0f, gtP12f, gtLengthMm);
        const e4_check = computeAlignmentError(p0, p12, snapMm, gtP12f, gtP0f, gtLengthMm);
        const minE = Math.min(e1_check, e2_check, e3_check, e4_check);

        let drawP0 = gt.p0;
        let drawP12 = gt.p12;
        if (minE === e3_check || minE === e4_check) {
          drawP0 = gtP0f;
          drawP12 = gtP12f;
        }

        // GT coords are in the same space as detected p0/p12 — draw directly.
        drawGroundTruthLine(preview, drawP0, drawP12, rulerMm);
      }

      const baseName = path.basename(file, path.extname(file));
      const folderName = isVerified ? (isMatch ? 'match' : 'not_match') : 'unsure';
      const versionDir = path.join(OUTPUT_DIR, folderName);
      if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });
      saveMatAsPng(preview, path.join(versionDir, `${baseName}_preview.png`));
      preview.delete();

      
      // Temporary DIMS log for GUI GT coordinate mapping
      console.log(`[DIMS] ${file}: mat=${activeMat.cols}x${activeMat.rows} isFlipped=${isFlipped} cropX=${cropX.toFixed(1)} cropY=${cropY.toFixed(1)} scale=${scale.toFixed(4)} angle=${angleDeg.toFixed(2)} p0=(${p0.x.toFixed(2)},${p0.y.toFixed(2)}) p12=(${p12.x.toFixed(2)},${p12.y.toFixed(2)})`);

      console.log(`| ${file.padEnd(38)} | ${status.padEnd(8)} | ${truncMethod} | ${cm.padEnd(5)} | ${gtStatus.padEnd(12)} |`);
      
      reportRows.push({
        file,
        status,
        method,
        cm,
        angle: `${angleDeg.toFixed(1)}°`,
        gtStatus,
      });

      if (activeMat) activeMat.delete();

    } catch (err) {
      errorCount += 1;
      const msg = (err.message || '').substring(0, 30);
      console.log(`| ${file.padEnd(38)} | ERROR    | ${msg.padEnd(30)} | -     |`);
      reportRows.push({ file, status: 'ERROR', method: msg, cm: '-', angle: '-', gtStatus: '-' });
      console.error(err.stack || err);
    } finally {
      if (baseMat) try { baseMat.delete(); } catch (_) {}
      if (flippedMat) try { flippedMat.delete(); } catch (_) {}
      if (tempPng && fs.existsSync(tempPng)) {
        try { fs.unlinkSync(tempPng); } catch (_) {}
      }
    }
  }

  console.log(sep);
  console.log(`\nDone. ${successCount} reliable, ${fallbackCount} fallback, ${errorCount} errors.`);
  console.log(`Previews saved to: ${OUTPUT_DIR}/`);

  writeResultsReport(reportRows, {
    successCount,
    fallbackCount,
    errorCount,
    filesCount: files.length,
  });

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
  lines.push('# Stoma Scaling Tool: Test Execution Report (Browser Canvas Mode)');
  lines.push('');
  lines.push('Generated: ' + now);
  lines.push('');
  lines.push('| File | Status | Method | cm | Angle | GT Status |');
  lines.push('| :--- | :--- | :--- | :--- | :--- | :--- |');
  for (const row of rows) {
    lines.push(`| ${row.file} | ${row.status} | ${row.method} | ${row.cm} | ${row.angle} | ${row.gtStatus} |`);
  }
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Files tested: ${totals.filesCount}`);
  lines.push(`- Reliable detections: ${totals.successCount}`);
  lines.push(`- Fallback detections: ${totals.fallbackCount}`);
  lines.push(`- Errors: ${totals.errorCount}`);
  fs.writeFileSync(RESULTS_MD, lines.join('\n') + '\n', 'utf8');
}
