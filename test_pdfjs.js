const fs = require('fs');
const { createCanvas, Image } = require('canvas');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

// Mock DOM
global.Image = Image;
global.document = {
  createElement: (name) => {
    if (name === 'canvas') return createCanvas(1, 1);
    if (name === 'img') return new Image();
    return {};
  }
};

async function render() {
  const data = new Uint8Array(fs.readFileSync('01_Schablonen_Vorlagen_für_Tests/15.05.2026 Vorname Nachname 4.pdf'));
  const doc = await pdfjsLib.getDocument({ data }).promise;
  const page = await doc.getPage(1);
  const scale = 3.0;
  const viewport = page.getViewport({ scale });
  
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  await page.render({ canvasContext: ctx, viewport }).promise;
  fs.writeFileSync('test_pdfjs.png', canvas.toBuffer('image/png'));
  console.log('Saved test_pdfjs.png');
}
render().catch(console.error);