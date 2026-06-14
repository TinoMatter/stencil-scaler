const fs = require('fs');
const path = require('path');

// Setup Canvas and OpenCV
const { createCanvas, Image, loadImage, ImageData } = require('canvas');
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

const cv = require('./offline_package/vendor/opencv.js');
global.cv = cv;
global.window.cv = cv;

const RulerDetector = require('./js/ruler-detector.js');

const STENCILS_DIR = './01_Schablonen_Vorlagen_für_Tests';
const GT_FILE = './ruler_ground_truth.json';

let groundTruth = JSON.parse(fs.readFileSync(GT_FILE, 'utf8'));

cv.onRuntimeInitialized = async () => {
  const { prepareImageForDetection } = require('./js/gui_pipeline.js');
  
  for (const filename of Object.keys(groundTruth)) {
    const filepath = path.join(STENCILS_DIR, filename);
    if (!fs.existsSync(filepath)) {
      console.log(`⚠️  File not found: ${filepath}`);
      continue;
    }
    
    try {
      let sourceCanvas;
      
      // Load PDF or image
      if (filename.endsWith('.pdf')) {
        const pdfData = fs.readFileSync(filepath);
        const PDFDocument = require('pdfjs-dist/legacy/build/pdf');
        const pdf = await PDFDocument.getDocument({
          data: new Uint8Array(pdfData),
          canvasFactory: new NodeCanvasFactory(),
          disableFontFace: true
        }).promise;
        const page = await pdf.getPage(1);
        const vp = page.getViewport({ scale: 3.0 });
        sourceCanvas = createCanvas(vp.width, vp.height);
        const ctx = sourceCanvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
      } else {
        const img = await loadImage(filepath);
        sourceCanvas = createCanvas(img.width, img.height);
        const ctx = sourceCanvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
      }
      
      // Setup meta object
      let meta = { filename };
      if (filename.endsWith('.pdf')) {
        meta.isPdf = true;
        meta.pageIndex = 1;
        meta.pageBreitePt = sourceCanvas.width / 3;
        meta.pageHöhePt = sourceCanvas.height / 3;
        meta.renderScale = 3.0;
        meta.sourceWidthPx = sourceCanvas.width;
        meta.sourceHeightPx = sourceCanvas.height;
      }
      
      // Prepare image (deskew, etc.)
      const result = await prepareImageForDetection(sourceCanvas, meta);
      
      // Detect ruler
      function detectExpectedRulerLengthFromFilename(fname) {
        if (!fname) return 120;
        const lower = fname.toLowerCase();
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
      
      const rulerMm = detectExpectedRulerLengthFromFilename(filename);
      const ruler = RulerDetector.detect(result.baseMat, meta, rulerMm);
      
      if (ruler) {
        groundTruth[filename] = {
          p0: { x: Math.round(ruler.p0.x * 100) / 100, y: Math.round(ruler.p0.y * 100) / 100 },
          p12: { x: Math.round(ruler.p12.x * 100) / 100, y: Math.round(ruler.p12.y * 100) / 100 },
          rulerLengthMm: ruler.detectedLengthMm
        };
        console.log(`✓ ${filename}: ${ruler.detectedLengthMm}cm`);
      } else {
        console.log(`✗ ${filename}: No ruler detected`);
      }
    } catch (e) {
      console.error(`✗ ${filename}: ${e.message}`);
    }
  }
  
  // Write the updated ground truth back to the file
  fs.writeFileSync(GT_FILE, JSON.stringify(groundTruth, null, 2), 'utf8');
  console.log('\n=== Ground Truth Database Updated ===');
  process.exit(0);
};
