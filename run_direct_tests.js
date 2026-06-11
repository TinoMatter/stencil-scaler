/**
 * run_direct_tests.js — Fast CLI E2E test runner for all stencils.
 * 100% authentic browser pipeline replication using node-canvas.
 *
 * Usage: node run_direct_tests.js
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const os = require('os');

// --- 1. Shim DOM Canvas for OpenCV.js & App scripts ---
const { createCanvas, Image, loadImage, ImageData } = require('canvas');
global.Image = Image;
global.HTMLImageElement = Image;
global.HTMLCanvasElement = createCanvas(0, 0).constructor;
global.OffscreenCanvas = createCanvas(0, 0).constructor;
global.ImageData = ImageData;
global.document = { createElement: tag => tag === 'canvas' ? createCanvas(0, 0) : null };
global.window = {};

const STENCILS_DIR = '/Users/up273900/Documents/Coding/stoma_stencils/01_Schablonen_Vorlagen_für_Tests';
const OUTPUT_DIR = '/Users/up273900/Documents/Coding/stoma_stencils/test_outputs';
const RESULTS_MD = '/Users/up273900/Documents/Coding/stoma_stencils/test_results.md';
const MM_TO_PT = 72 / 25.4;

const RulerDetector = require('./js/ruler-detector.js');

resetTestOutputs();

console.log('Loading OpenCV.js...');
const cv = require('./offline_package/vendor/opencv.js');
global.cv = cv;
global.window.cv = cv;

const { prepareImageForDetection } = require('./js/gui_pipeline.js');
const { deskew, expectedDistanceFromMeta } = require('./js/image-utils.js');

cv.onRuntimeInitialized = () => {
  console.log('OpenCV.js ready.');
  runAllTests().catch(console.error);
};

// ─── 2. Drawing & Helper Functions ──────────────────────────────────────────

function drawCalibrationLine(mat, p0, p12, reliable, snapMm = 120) {
  const c = reliable
    ? new cv.Scalar(255, 0, 255, 255) // Magenta
    : new cv.Scalar(255, 64, 64, 255); // Red for fallback
  const lw = 2;

  cv.line(mat, new cv.Point(Math.round(p0.x), Math.round(p0.y)), new cv.Point(Math.round(p12.x), Math.round(p12.y)), c, lw);

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
      (f.endsWith('.pdf') || f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.png')))
    .sort((a, b) => a.localeCompare(b, 'de'));

  if (process.argv[2]) {
    const targetFile = process.argv[2];
    files = files.filter(f => f.includes(targetFile));
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
      let imgPath = filePath;

      if (file.endsWith('.pdf')) {
        const prefix = path.join(os.tmpdir(), `stoma_${Date.now()}`);
        const r = cp.spawnSync('pdftoppm',
          ['-png', '-r', '216', '-f', '1', '-l', '1', filePath, prefix],
          { timeout: 15000 });
        if (r.status !== 0) throw new Error('pdftoppm failed');
        tempPng = `${prefix}-1.png`;
        imgPath = tempPng;
      }

      // Load image into node-canvas (exact browser simulation)
      const img = await loadImage(imgPath);
      const sourceCanvas = createCanvas(img.width, img.height);
      const ctx = sourceCanvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      function detectExpectedRulerLengthFromFilename(filename) {
        if (!filename) return 120;
        const lower = filename.toLowerCase();
        if (lower.includes("publicare") || lower.includes("0-10") || lower.includes("spontantest") || lower.includes("spontan_test")) {
          return 100;
        }
        const match = lower.match(/(?:^|\D)(\d+)(?:\.[^.]+)?$/) || lower.match(/(\d+)/);
        if (match) {
          const num = parseInt(match[1], 10);
          if ([1, 2, 3, 4, 5, 16].includes(num)) {
            return 100;
          }
        }
        return 120;
      }
      
      const isVerified = gtExists && !!groundTruth[file];
      const rulerMm = isVerified ? groundTruth[file].rulerLengthMm : detectExpectedRulerLengthFromFilename(file);

      let meta = { filename: file };
      if (file.endsWith('.pdf')) {
        meta.isPdf = true;
        meta.pageIndex = 1;
        meta.pageBreitePt = img.width / 3;
        meta.pageHöhePt = img.height / 3;
        meta.renderScale = 3.0;
        meta.sourceWidthPx = img.width;
        meta.sourceHeightPx = img.height;
      }

      // --- Authentically simulate app.js autoDetectFromSource pipeline ---
      let angleDeg = 0;
      if (!meta.isPdf) {
        // Applies Crop -> Deskew -> Rotate
        const result = await prepareImageForDetection(sourceCanvas, meta);
        baseMat = result.baseMat;
        flippedMat = result.flippedMat;
        angleDeg = result.angle;
      } else {
        // Direct deskew for PDFs
        const src = cv.imread(sourceCanvas);
        const deskewRes = deskew(src);
        src.delete();

        baseMat = deskewRes.mat;
        flippedMat = new cv.Mat();
        cv.rotate(baseMat, flippedMat, cv.ROTATE_180);
        angleDeg = deskewRes.angle || 0;
      }

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
      tryDetect(flippedMat, "[rot180] ");

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
        const detP0_normal = isFlipped ? { x: activeMat.cols - p0.x, y: activeMat.rows - p0.y } : p0;
        const detP12_normal = isFlipped ? { x: activeMat.cols - p12.x, y: activeMat.rows - p12.y } : p12;

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
        if (isFlipped) {
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
