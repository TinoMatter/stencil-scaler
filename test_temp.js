const fs = require('fs');
const path = require('path');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const { createCanvas, loadImage } = require('canvas');

global.Image = global.HTMLImageElement = require('canvas').Image;
global.HTMLCanvasElement = createCanvas(0, 0).constructor;
global.OffscreenCanvas = createCanvas(0, 0).constructor;
global.document = { createElement: tag => tag === 'canvas' ? createCanvas(1, 1) : null };

const cv = require('./offline_package/vendor/opencv.js');
global.cv = cv;
global.window = {
  cv: cv,
  requestAnimationFrame: cb => setImmediate(cb)
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

cv.onRuntimeInitialized = async () => {
  const filePath = './01_Schablonen_Vorlagen_für_Tests/08.04.2026 Vorname Nachname 12.pdf';
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjsLib.getDocument({
    data,
    canvasFactory: new NodeCanvasFactory(),
    disableFontFace: true,
  }).promise;
  const page = await doc.getPage(1);
  const scale = 3.0;
  const viewport = page.getViewport({ scale });
  
  const sourceCanvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = sourceCanvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;

  // Now, run the preparation step manually and trace deskew
  const { cropAndScaleStencilIfPossible } = require('./js/image-utils.js');
  const cropRes = await cropAndScaleStencilIfPossible(sourceCanvas);
  console.log('Crop results: x =', cropRes.x, 'y =', cropRes.y, 'scale =', cropRes.scale, 'w =', cropRes.canvas.width, 'h =', cropRes.canvas.height);

  const src = cv.imread(cropRes.canvas);
  const gray = new cv.Mat();
  const edges = new cv.Mat();
  const lines = new cv.Mat();

  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.threshold(gray, gray, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  cv.Canny(gray, edges, 50, 150, 3, false);
  cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 50, src.cols * 0.1, 15);

  const winkel = [];
  console.log(`Detected lines count: ${lines.rows}`);
  for (let i = 0; i < lines.rows; i += 1) {
    const x1 = lines.data32S[i * 4 + 0];
    const y1 = lines.data32S[i * 4 + 1];
    const x2 = lines.data32S[i * 4 + 2];
    const y2 = lines.data32S[i * 4 + 3];
    const len = Math.hypot(x2 - x1, y2 - y1);
    let deg = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
    if (deg > 90) deg -= 180;
    if (deg < -90) deg += 180;
    
    let valid = false;
    if (Math.abs(deg) <= 35) {
      winkel.push(deg);
      valid = true;
    } else if (Math.abs(deg) >= 55) {
      const dev = (deg > 0) ? deg - 90 : dev => deg + 90; // Wait, dev is not correct here, dev = (deg > 0) ? deg - 90 : deg + 90;
      const devVal = (deg > 0) ? deg - 90 : deg + 90;
      winkel.push(devVal);
      valid = true;
    }
    if (i < 20) {
      console.log(`Line ${i}: (${x1},${y1}) -> (${x2},${y2}), len=${len.toFixed(1)}, deg=${deg.toFixed(2)}, valid=${valid}`);
    }
  }

  // Calculate median
  winkel.sort((a, b) => a - b);
  console.log('Sorted valid angles:', winkel.map(w => w.toFixed(2)).join(', '));
  const mid = Math.floor(winkel.length / 2);
  const medianWinkel = winkel.length ? (winkel.length % 2 !== 0 ? winkel[mid] : (winkel[mid - 1] + winkel[mid]) / 2) : 0;
  console.log('Median angle:', medianWinkel);

  process.exit(0);
};
