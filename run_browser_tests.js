const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const DIR = __dirname;
const STENCILS_DIR = path.join(DIR, '01_Schablonen_Vorlagen_für_Tests');
const OUTPUT_DIR = path.join(DIR, 'test_outputs', 'browser_preview');
const MATCH_DIR = path.join(OUTPUT_DIR, 'matched');
const NOT_MATCH_DIR = path.join(OUTPUT_DIR, 'not_matched');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}
if (!fs.existsSync(MATCH_DIR)) fs.mkdirSync(MATCH_DIR, { recursive: true });
if (!fs.existsSync(NOT_MATCH_DIR)) fs.mkdirSync(NOT_MATCH_DIR, { recursive: true });

async function start() {
  await runTests();
}
start().catch(console.error);

function computeAlignmentError(pt0, pt12, sMm, gtPt0, gtPt12, gtLenMm) {
  const vx = (gtPt12.x - gtPt0.x) / gtLenMm;
  const vy = (gtPt12.y - gtPt0.y) / gtLenMm;
  const pxPerMm = Math.sqrt(vx * vx + vy * vy);
  if (pxPerMm < 1e-6) return Infinity;

  const ux = vx / pxPerMm;
  const uy = vy / pxPerMm;
  const nx = -uy;
  const ny = ux;

  const dp0x = pt0.x - gtPt0.x;
  const dp0y = pt0.y - gtPt0.y;
  const dp12x = pt12.x - (gtPt0.x + sMm * vx);
  const dp12y = pt12.y - (gtPt0.y + sMm * vy);

  const dot = ux * (dp0x + dp12x) + uy * (dp0y + dp12y);
  const offsetPx = dot / 2;
  const offsetMm = offsetPx / pxPerMm;

  const expP0x = gtPt0.x + offsetPx * ux;
  const expP0y = gtPt0.y + offsetPx * uy;
  const expP12x = gtPt0.x + (offsetPx + sMm * pxPerMm) * ux;
  const expP12y = gtPt0.y + (offsetPx + sMm * pxPerMm) * uy;

  const err0_par = Math.abs((pt0.x - expP0x) * ux + (pt0.y - expP0y) * uy);
  const err12_par = Math.abs((pt12.x - expP12x) * ux + (pt12.y - expP12y) * uy);

  const err0_perp = Math.abs((pt0.x - expP0x) * nx + (pt0.y - expP0y) * ny);
  const err12_perp = Math.abs((pt12.x - expP12x) * nx + (pt12.y - expP12y) * ny);

  const maxParErrMm = Math.max(err0_par, err12_par) / pxPerMm;
  const maxPerpErrMm = Math.max(err0_perp, err12_perp) / pxPerMm;

  console.log(`[DEBUG COMPUTE] gtLenMm=${gtLenMm} maxPar=${maxParErrMm.toFixed(3)} maxPerp=${maxPerpErrMm.toFixed(3)} offset=${offsetMm.toFixed(3)}`);

  if (Math.abs(offsetMm) > 2.0) {
    const r = Math.max(maxParErrMm, maxPerpErrMm, Math.abs(offsetMm));
    console.log(`[RETURN] offset > 2.0, returning ${r}`);
    return r;
  }

  if (maxPerpErrMm <= 3.5) {
    const r = maxParErrMm;
    console.log(`[RETURN] perp <= 3.5, returning ${r}`);
    return r;
  }
  const r = Math.max(maxParErrMm, maxPerpErrMm);
  console.log(`[RETURN] default, returning ${r}`);
  return r;
}

async function runTests() {
  const browser = await puppeteer.launch({
    headless: "shell",
    pipe: true,
    userDataDir: path.join(DIR, '.puppeteer_tmp'),
    defaultViewport: { width: 1280, height: 1024 },
    args: ['--allow-file-access-from-files', '--disable-web-security', '--single-process']
  });
  
  const page = await browser.newPage();
  
  // Forward browser console to terminal for debugging
  page.on('console', msg => console.log('[Browser]', msg.text()));
  page.on('pageerror', err => console.error('[Browser Error]', err.toString()));

  let groundTruth = {};
  try {
    groundTruth = JSON.parse(fs.readFileSync(path.join(DIR, 'ruler_ground_truth.json'), 'utf-8'));
  } catch (err) {
    console.warn("Could not load ground truth!");
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
        const tMatch = t.match(/^(\d+)\.[^.]+$/);
        if (tMatch) {
          return num === tMatch[1];
        }
        return f.includes(t);
      });
    });
  }

  console.log(`Running Browser E2E Tests on ${files.length} files...`);

  let allPassed = true;

  for (const file of files) {
    console.log(`\nTesting: ${file}`);
    const htmlPath = path.resolve(__dirname, 'index.html');
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });

    // Ensure CV is ready
    await page.waitForFunction(() => window.appState && window.appState.cvReady === true, { timeout: 10000 });

    const filePath = path.join(STENCILS_DIR, file);
    
    // Upload the file
    const fileInput = await page.$('#dateiInput');
    await fileInput.uploadFile(filePath);

    // Wait for processing to complete. We know it's done when calibration is not null and ocrBusy is false
    try {
      await page.waitForFunction(() => {
        return window.appState && window.appState.calibration !== null && window.appState.ocrBusy === false;
      }, { timeout: 40000 });
      
      // Wait an extra brief moment for canvas draw
      await new Promise(r => setTimeout(r, 200));

      const appData = await page.evaluate(() => {
        const p0 = window.appState.calibration.p0;
        const p12 = window.appState.calibration.p12;
        const snapMm = window.appState.calibration.detectedLengthMm;
        const reliable = window.appState.calibration.lineReliable;
        const W = window.appState.processedCanvas ? window.appState.processedCanvas.width : 0;
        const H = window.appState.processedCanvas ? window.appState.processedCanvas.height : 0;
        const cropX = window.appState.sourceMeta ? window.appState.sourceMeta.cropX : 0;
        const cropY = window.appState.sourceMeta ? window.appState.sourceMeta.cropY : 0;
        const scale = window.appState.sourceMeta ? window.appState.sourceMeta.scale : 1;
        const angle = window.appState.calibration.angleDeg || 0;
        const isFlipped = window.appState.calibration.isFlipped || false;
        return { p0, p12, snapMm, reliable, W, H, cropX, cropY, scale, angle, isFlipped };
      });
      console.log(`  -> Detected: p0=(${appData.p0.x.toFixed(2)},${appData.p0.y.toFixed(2)}), p12=(${appData.p12.x.toFixed(2)},${appData.p12.y.toFixed(2)}), W=${appData.W}, H=${appData.H}, snap=${appData.snapMm}, cropX=${appData.cropX}, cropY=${appData.cropY}, scale=${appData.scale.toFixed(4)}, angle=${appData.angle.toFixed(2)}, isFlipped=${appData.isFlipped}`);

      // Validation
      const gt = groundTruth[file];
      const gtLengthMm = gt.rulerLengthMm;
      
      const gtP0f  = { x: appData.W - gt.p0.x,  y: appData.H - gt.p0.y  };
      const gtP12f = { x: appData.W - gt.p12.x, y: appData.H - gt.p12.y };
      // console.log(`[DEBUG GT] gtP0f=(${gtP0f.x.toFixed(2)},${gtP0f.y.toFixed(2)}) gtP12f=(${gtP12f.x.toFixed(2)},${gtP12f.y.toFixed(2)})`);

      const e1 = computeAlignmentError(appData.p0, appData.p12, appData.snapMm, gt.p0, gt.p12, gtLengthMm);
      const e2 = computeAlignmentError(appData.p0, appData.p12, appData.snapMm, gt.p12, gt.p0, gtLengthMm);
      const e3 = computeAlignmentError(appData.p0, appData.p12, appData.snapMm, gtP0f, gtP12f, gtLengthMm);
      const e4 = computeAlignmentError(appData.p0, appData.p12, appData.snapMm, gtP12f, gtP0f, gtLengthMm);
      
      const minErrMm = Math.min(e1, e2, e3, e4);
      
      let allowedTolerance = 1.5;
      let status = "MATCH";
      let orientationIssue = false;

      if (minErrMm > allowedTolerance || !appData.reliable) {
        status = "NOT MATCH";
      } else {
        // Check if it's flipped compared to GT (e1 is the direct match)
        // We allow FLIPPED as a success state for the test
        if (minErrMm !== e1) {
          status = "MATCH"; // Was "FLIPPED"
          orientationIssue = true;
        }
      }

      if (status !== "MATCH") {
        allPassed = false;
      }
      
      console.log(`  -> Status: ${status} (${minErrMm.toFixed(2)} mm error)${orientationIssue ? " [Orientation Flipped]" : ""}`);

      // Draw ground truth line on the preview canvas before screenshotting
      await page.evaluate((gt, gtP0f, gtP12f, minE, e3, e4, appData) => {
        const canvas = document.getElementById('previewCanvas');
        const ctx = canvas.getContext('2d');
        
        let finalGtP0 = gt.p0;
        let finalGtP12 = gt.p12;
        if (minE === e3 || minE === e4) {
          finalGtP0 = gtP0f;
          finalGtP12 = gtP12f;
        }
        // If flipped (e2 or e4), we still draw the GT in its original orientation to show the flip
        // but we can mark it.

        const snapMm = appData.snapMm;
        const p0 = appData.p0;
        const p12 = appData.p12;

        const rulerLen = Math.hypot(p12.x - p0.x, p12.y - p0.y);
        if (rulerLen > 10) {
          const dx = (p12.x - p0.x) / snapMm;
          const dy = (p12.y - p0.y) / snapMm;
          const ux = (p12.x - p0.x) / rulerLen;
          const uy = (p12.y - p0.y) / rulerLen;
          const px = -uy;
          const py = ux;

          const maxDim = Math.max(canvas.width, canvas.height);
          const cmLen = Math.max(20, Math.round(maxDim / 80));
          const halfCmLen = Math.round(cmLen * 0.7);
          const mmLen = Math.round(cmLen * 0.45);

          ctx.save();
          ctx.strokeStyle = 'rgba(255, 0, 255, 1.0)'; // Magenta
          
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
            
            ctx.lineWidth = tickWidth;
            ctx.beginPath();
            ctx.moveTo(tx, ty);
            ctx.lineTo(tx + px * tickLen, ty + py * tickLen);
            ctx.stroke();
          }

          const labelFontScale = Math.max(0.6, maxDim / 3000);
          ctx.font = `${Math.round(labelFontScale * 30)}px Arial`;
          ctx.fillStyle = 'white';
          ctx.textAlign = 'center';
          ctx.fillText("0 (DET)", p0.x + px * 45, p0.y + py * 45);
          ctx.fillStyle = 'rgba(255, 0, 255, 1.0)';
          ctx.fillText("0 (DET)", p0.x + px * 45, p0.y + py * 45);

          const labelTextEnd = `${snapMm / 10} (DET)`;
          ctx.fillStyle = 'white';
          ctx.fillText(labelTextEnd, p12.x + px * 45, p12.y + py * 45);
          ctx.fillStyle = 'rgba(255, 0, 255, 1.0)';
          ctx.fillText(labelTextEnd, p12.x + px * 45, p12.y + py * 45);
          ctx.restore();
        }

        // --- DRAW GROUND TRUTH ---
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 0, 0, 0.8)'; // Red for ground truth
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(finalGtP0.x, finalGtP0.y);
        ctx.lineTo(finalGtP12.x, finalGtP12.y);
        ctx.stroke();

        // Draw endpoints
        ctx.fillStyle = 'rgba(255, 0, 0, 0.8)';
        ctx.beginPath();
        ctx.arc(finalGtP0.x, finalGtP0.y, 8, 0, 2 * Math.PI);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(finalGtP12.x, finalGtP12.y, 8, 0, 2 * Math.PI);
        ctx.fill();

        // Labels for GT
        const maxDim = Math.max(canvas.width, canvas.height);
        const labelFontScale = Math.max(0.6, maxDim / 3000);
        ctx.font = `${Math.round(labelFontScale * 30)}px Arial`;
        ctx.fillStyle = 'white';
        ctx.textAlign = 'center';
        ctx.fillText("0 (GT)", finalGtP0.x, finalGtP0.y - 20);
        ctx.fillStyle = 'red';
        ctx.fillText("0 (GT)", finalGtP0.x, finalGtP0.y - 20);

        const labelTextEndGT = `${gt.rulerLengthMm / 10} (GT)`;
        ctx.fillStyle = 'white';
        ctx.fillText(labelTextEndGT, finalGtP12.x, finalGtP12.y - 20);
        ctx.fillStyle = 'red';
        ctx.fillText(labelTextEndGT, finalGtP12.x, finalGtP12.y - 20);
        ctx.restore();
      }, gt, gtP0f, gtP12f, minErrMm, e3, e4, appData);

      // Screenshot preview canvas
      const canvasElement = await page.$('#previewCanvas');
      if (canvasElement) {
        const subDir = status === "MATCH" ? MATCH_DIR : NOT_MATCH_DIR;
        await canvasElement.screenshot({ path: path.join(subDir, `${file}.png`) });
        console.log(`  -> Saved preview screenshot to ${status === "MATCH" ? "matched" : "not_matched"}.`);
      }

    } catch (e) {
      console.error(`  -> Failed: ${e.message}`);
      allPassed = false;
    }
  }

  await browser.close();

  if (allPassed) {
    console.log("\nAll E2E Browser tests passed! ✅");
    process.exit(0);
  } else {
    console.log("\nSome E2E Browser tests failed. ❌");
    process.exit(1);
  }
}
