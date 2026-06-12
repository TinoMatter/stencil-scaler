const fs = require('fs');
const path = require('path');

// Setup Canvas and OpenCV
const { createCanvas, Image, loadImage, ImageData } = require('canvas');
global.Image = Image;
global.HTMLImageElement = Image;
global.HTMLCanvasElement = createCanvas(0, 0).constructor;
global.OffscreenCanvas = createCanvas(0, 0).constructor;
global.ImageData = ImageData;
global.document = { createElement: tag => tag === 'canvas' ? createCanvas(0, 0) : null };
global.window = { requestAnimationFrame: (cb) => setImmediate(cb) };

const cv = require('./offline_package/vendor/opencv.js');
global.cv = cv;
global.window.cv = cv;

const RulerDetector = require('./js/ruler-detector.js');

const STENCILS_DIR = './01_Schablonen_Vorlagen_für_Tests';
const GT_FILE = './ruler_ground_truth.json';

const files_to_update = [
  '08.04.2026 Vorname Nachname 12.pdf',
  '15.05.2026 Vorname Nachname 8.pdf',
  '15.05.2026 Vorname Nachname 3.pdf',
  '15.05.2026 Vorname Nachname 1_a4_1zu1.pdf',
  '11.03.2026 Vorname Nachname 16.pdf'
];

let groundTruth = JSON.parse(fs.readFileSync(GT_FILE, 'utf8'));
const updates = {};

cv.onRuntimeInitialized = async () => {
  const { prepareImageForDetection } = require('./js/gui_pipeline.js');
  
  for (const filename of files_to_update) {
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
        const pdf = await PDFDocument.getDocument({ data: new Uint8Array(pdfData) }).promise;
        const page = await pdf.getPage(1);
        const vp = page.getViewport({ scale: 2 });
        sourceCanvas = createCanvas(vp.width, vp.height);
        const ctx = sourceCanvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
      } else {
        const img = await loadImage(filepath);
        sourceCanvas = createCanvas(img.width, img.height);
        const ctx = sourceCanvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
      }
      
      // Prepare image (deskew, etc.)
      const result = await prepareImageForDetection(sourceCanvas, {});
      
      // Detect ruler
      const detector = new RulerDetector();
      const rulers = detector.detectAllRulers(result.baseMat);
      
      if (rulers.length > 0) {
        const ruler = rulers[0];
        updates[filename] = {
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
  
  // Print detected rulers in JSON format for easy copy
  console.log('\n=== Detected Rulers ===');
  console.log(JSON.stringify(updates, null, 2));
  process.exit(0);
};
