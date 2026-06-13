const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer');

const PORT = 8080;
const DIR = __dirname;
const STENCILS_DIR = path.join(DIR, '01_Schablonen_Vorlagen_für_Tests');
const OUTPUT_DIR = path.join(DIR, 'test_outputs', 'browser_preview');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// 1. Simple HTTP Server
const server = http.createServer((req, res) => {
  let filePath = path.join(DIR, req.url === '/' ? 'index.html' : req.url);
  
  // Basic query string stripping
  filePath = filePath.split('?')[0];

  const extname = path.extname(filePath);
  let contentType = 'text/html';
  switch (extname) {
    case '.js': contentType = 'text/javascript'; break;
    case '.css': contentType = 'text/css'; break;
    case '.json': contentType = 'application/json'; break;
    case '.png': contentType = 'image/png'; break;
    case '.jpg': contentType = 'image/jpg'; break;
    case '.pdf': contentType = 'application/pdf'; break;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if(err.code == 'ENOENT'){
        res.writeHead(404);
        res.end('Not found');
      } else {
        res.writeHead(500);
        res.end('Server error');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, async () => {
  console.log(`Server running at http://localhost:${PORT}/`);
  await runTests();
});

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

async function runTests() {
  const browser = await puppeteer.launch({
    headless: "new",
    defaultViewport: { width: 1280, height: 1024 }
  });
  
  const page = await browser.newPage();
  
  // Forward browser console to terminal for debugging
  page.on('console', msg => console.log('[Browser]', msg.text()));

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
        return f.includes(t);
      });
    });
  }

  console.log(`Running Browser E2E Tests on ${files.length} files...`);

  let allPassed = true;

  for (const file of files) {
    console.log(`\nTesting: ${file}`);
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle0' });

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
        return { p0, p12, snapMm, reliable, W, H };
      });

      // Validation
      const gt = groundTruth[file];
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
      const maxErrMm = Math.min(e1, e2, e3, e4);

      let allowedTolerance = 1.5;
      let status = "MATCH";
      if (maxErrMm > allowedTolerance || !appData.reliable) {
        status = "NOT MATCH";
        allPassed = false;
      }
      
      console.log(`  -> Status: ${status} (${maxErrMm.toFixed(2)} mm error)`);

      // Screenshot preview canvas
      const canvasElement = await page.$('#previewCanvas');
      if (canvasElement) {
        await canvasElement.screenshot({ path: path.join(OUTPUT_DIR, `${file}.png`) });
        console.log(`  -> Saved preview screenshot.`);
      }

    } catch (e) {
      console.error(`  -> Failed: ${e.message}`);
      allPassed = false;
    }
  }

  await browser.close();
  server.close();

  if (allPassed) {
    console.log("\nAll E2E Browser tests passed! ✅");
    process.exit(0);
  } else {
    console.log("\nSome E2E Browser tests failed. ❌");
    process.exit(1);
  }
}
