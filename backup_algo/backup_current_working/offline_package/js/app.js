/**
 * js/app.js
 * Frontend application controller and UI handlers.
 */

// Worker Source mapping (will be modified for offline package)
pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

const OCR_KEYWORDS = ["datum", "coloplast", "stoma", "messschablone", "name"];

const ocrMirrorCache = new Map();

// UI Elements
const dateiInput = document.getElementById("dateiInput");
const batchInput = document.getElementById("batchInput");
const rulerLengthInput = document.getElementById("rulerLengthInput");
const rulerLengthCustomInput = document.getElementById("rulerLengthCustomInput");
const erkennenBtn = document.getElementById("erkennenBtn");
const manuellBtn = document.getElementById("manuellBtn");
const downloadBtn = document.getElementById("downloadBtn");
const printBtn = document.getElementById("printBtn");
const batchBtn = document.getElementById("batchBtn");
const previewCanvas = document.getElementById("previewCanvas");
const previewCtx = previewCanvas.getContext("2d");
const statusBox = document.getElementById("statusBox");
const autoAlarm = document.getElementById("autoAlarm");
const busyIndicator = document.getElementById("busyIndicator");
const manualNote = document.getElementById("manualNote");
const batchLog = document.getElementById("batchLog");
const abortBtn = document.getElementById("abortBtn");

const methodValue = document.getElementById("methodValue");
const angleValue = document.getElementById("angleValue");
const distanceValue = document.getElementById("distanceValue");
const resolutionValue = document.getElementById("resolutionValue");
const sizeValue = document.getElementById("sizeValue");
const ocrNormalValue = document.getElementById("ocrNormalValue");
const ocrMirroredValue = document.getElementById("ocrMirroredValue");

// Application State
const appState = {
  cvReady: false,
  sourceName: "",
  sourceCanvas: null,
  sourceMeta: null,
  processedCanvas: null,
  calibration: null,
  manualActive: false,
  manualPoints: [],
  drag: { active: false, mode: null, last: null },
  alarmActive: false,
  outputOcrNormalWords: [],
  outputOcrMirroredWords: [],
  outputMirrored: null,
  ocrBusy: false,
  ocrRequestId: 0,
  userOverrodeLength: false,
  abortActive: false,
};
window.appState = appState;

function getRulerLengthCm() {
  if (rulerLengthInput && rulerLengthInput.value === "custom") {
    return parseFloat(rulerLengthCustomInput.value) || 12;
  }
  return parseFloat(rulerLengthInput ? rulerLengthInput.value : 12) || 12;
}

function getRulerLengthMm() {
  return getRulerLengthCm() * 10;
}
window.getRulerLengthMm = getRulerLengthMm;

function updateRulerLengthUi() {
  const len = getRulerLengthCm();
  manuellBtn.textContent = `Manuell 0 cm und ${len} cm setzen`;
  manualNote.textContent = `Manual active: click 0 cm, then ${len} cm in image.`;
  if (!appState.calibration || appState.calibration.pixelDist === undefined) {
    distanceValue.textContent = `0-${len} cm Distanz (px): -`;
  } else {
    distanceValue.textContent = `0-${len} cm Distanz (px): ` + appState.calibration.pixelDist.toFixed(2);
  }
  if (rulerLengthInput.value === "custom") {
    rulerLengthCustomInput.style.display = "inline-block";
  } else {
    rulerLengthCustomInput.style.display = "none";
  }
}
window.updateRulerLengthUi = updateRulerLengthUi;

// OpenCV load promise
const cvReadyPromise = waitForOpenCv();
cvReadyPromise.then(() => {
  appState.cvReady = true;
  setStatus("OpenCV.js ist geladen. Datei kann verarbeitet werden.");
  if (appState.sourceCanvas && !appState.calibration) {
    startAutoDetection();
  }
}).catch((err) => {
  setStatus("OpenCV.js konnte nicht geladen werden: " + err.message, true);
});

// Event Listeners
rulerLengthInput.addEventListener("change", () => {
  appState.userOverrodeLength = true;
  updateRulerLengthUi();
  if (appState.calibration) {
    appState.calibration.detectedLengthMm = getRulerLengthMm();
    updateCalibrationFromLine(
      "Manuell angepasst",
      appState.calibration.lineReliable,
      appState.calibration.forceLineScale
    );
  }
});

rulerLengthCustomInput.addEventListener("input", () => {
  appState.userOverrodeLength = true;
  updateRulerLengthUi();
  if (appState.calibration) {
    appState.calibration.detectedLengthMm = getRulerLengthMm();
    updateCalibrationFromLine(
      "Manuell angepasst",
      appState.calibration.lineReliable,
      appState.calibration.forceLineScale
    );
  }
});

dateiInput.addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  try {
    resetStateForNewFile();
    setStatus("Datei wird geladen ...");
    setBusy(true, "Datei wird geladen ...");
    await new Promise(r => setTimeout(r, 10));

    appState.sourceName = file.name;
    const source = await loadFileAsSource(file);
    appState.sourceCanvas = source.canvas;
    appState.sourceMeta = source.sourceMeta;

    drawBaseCanvas(appState.sourceCanvas);
    setStatus(appState.sourceMeta.isPdf
      ? "Datei geladen (PDF Seite 1). Auto-Erkennung startet ..."
      : "Datei geladen. Auto-Erkennung startet ...");

    erkennenBtn.disabled = false;
    manuellBtn.disabled = false;

    if (appState.cvReady) {
      await startAutoDetection();
    } else {
      setBusy(false);
    }
  } catch (err) {
    setStatus("Fehler beim Laden: " + err.message, true);
    setBusy(false);
  }
});

abortBtn.addEventListener("click", () => {
  appState.abortActive = true;
  resetStateForNewFile();
  if (appState.sourceCanvas) {
    drawBaseCanvas(appState.sourceCanvas);
  }
  setStatus("Erkennung abgebrochen. Sie können manuell kalibrieren oder eine neue Datei laden.");
  enableFallbackCalibration("Erkennung abgebrochen (Manuell)");
});

function enableFallbackCalibration(methodName) {
  if (!appState.sourceCanvas) return;
  const w = appState.sourceCanvas.width;
  const h = appState.sourceCanvas.height;
  const p0 = { x: w * 0.2, y: h * 0.4 };
  const p12 = { x: w * 0.8, y: h * 0.4 };
  appState.processedCanvas = appState.sourceCanvas;
  appState.calibration = {
    method: methodName,
    p0,
    p12,
    lineReliable: false,
    showRulerLine: true,
    overlayColor: "#d97706",
    forceLineScale: true,
    angleDeg: 0,
    detectedLengthMm: getRulerLengthMm() || 120,
  };
  updateCalibrationFromLine(methodName, false, true);
  downloadBtn.disabled = false;
  printBtn.disabled = false;
}

erkennenBtn.addEventListener("click", async () => {
  await startAutoDetection();
});

manuellBtn.addEventListener("click", () => {
  if (!appState.processedCanvas) {
    setStatus("Please load a file and start auto-detection first.", true);
    return;
  }
  appState.manualActive = true;
  appState.manualPoints = [];
  manualNote.style.display = "block";
  const len = getRulerLengthCm();
  setStatus(`Manuell aktiv: erst 0 cm, dann ${len} cm im Bild klicken.`);
});

previewCanvas.addEventListener("mousedown", (event) => {
  if (!appState.calibration || appState.manualActive) return;
  const p = canvasCoordinateFromClick(event, previewCanvas);
  if (!p) return;

  const mode = determineHoverMode(p);
  if (mode !== "none") {
    appState.drag = { active: true, mode, last: p };
    previewCanvas.style.cursor = "grabbing";
  }
});

previewCanvas.addEventListener("mousemove", (event) => {
  const p = canvasCoordinateFromClick(event, previewCanvas);
  if (!p) return;

  if (!appState.calibration || appState.manualActive) {
    previewCanvas.style.cursor = appState.manualActive ? "crosshair" : "default";
    if (appState.manualActive) {
      appState.manualHover = p;
      drawCurrentPreview();
    }
    return;
  }

  if (!appState.drag.active) {
    const hover = determineHoverMode(p);
    if (hover === "p0" || hover === "p12") {
      previewCanvas.style.cursor = "pointer";
    } else if (hover === "line") {
      previewCanvas.style.cursor = "grab";
    } else {
      previewCanvas.style.cursor = "default";
    }
    return;
  }

  const dx = p.x - appState.drag.last.x;
  const dy = p.y - appState.drag.last.y;

  if (appState.drag.mode === "p0") {
    appState.calibration.p0.x += dx;
    appState.calibration.p0.y += dy;
  } else if (appState.drag.mode === "p12") {
    appState.calibration.p12.x += dx;
    appState.calibration.p12.y += dy;
  } else if (appState.drag.mode === "line") {
    appState.calibration.p0.x += dx;
    appState.calibration.p0.y += dy;
    appState.calibration.p12.x += dx;
    appState.calibration.p12.y += dy;
  }

  appState.drag.last = p;
  updateCalibrationFromLine("Feinjustiert (Drag)", true, true);
});

window.addEventListener("mouseup", () => {
  if (appState.drag.active) {
    appState.drag = { active: false, mode: null, last: null };
    previewCanvas.style.cursor = "default";
    updateOcrDiagnosticsFromCalibration();
  }
});

previewCanvas.addEventListener("mouseleave", () => {
  if (!appState.drag.active) {
    previewCanvas.style.cursor = appState.manualActive ? "crosshair" : "default";
  }
  if (appState.manualActive) {
    appState.manualHover = null;
    drawCurrentPreview();
  }
});

previewCanvas.addEventListener("click", (event) => {
  if (!appState.manualActive || !appState.processedCanvas) return;
  const p = canvasCoordinateFromClick(event, previewCanvas);
  if (!p) return;

  appState.manualPoints.push(p);
  const len = getRulerLengthCm();
  if (appState.manualPoints.length === 1) {
    setStatus(`Punkt für 0 cm gesetzt. Jetzt Punkt für ${len} cm.`);
    drawCurrentPreview();
    return;
  }

  const [p0, p12] = appState.manualPoints;
  appState.calibration = {
    method: `Manuell gesetzt (0/${len} cm Klick)`,
    p0,
    p12,
    lineReliable: true,
    showRulerLine: true,
    overlayColor: "#0ea55f",
    forceLineScale: true,
    angleDeg: appState.calibration ? appState.calibration.angleDeg : 0,
  };

  appState.manualActive = false;
  appState.manualPoints = [];
  manualNote.style.display = "none";
  updateCalibrationFromLine(appState.calibration.method, true, true);
  updateOcrDiagnosticsFromCalibration();
  setAutoAlarm(false);
  setStatus("Manuelle Kalibrierung übernommen. Ausgabe ist bereit.");
});

// Automatic Training Data & Ground Truth Upload Logic
async function autoSendTrainingData() {
  if (!appState.calibration || !appState.processedCanvas || !appState.sourceName) {
    return;
  }

  appState.processedCanvas.toBlob(async (blob) => {
    if (!blob) {
      console.error("autoSendTrainingData: Failed to create image blob");
      return;
    }

    const formData = new FormData();
    formData.append("file", blob, appState.sourceName.replace(/\.pdf$/i, ".jpg"));
    formData.append("original_width", appState.processedCanvas.width);
    formData.append("original_height", appState.processedCanvas.height);
    formData.append("point_0cm", JSON.stringify([
      parseFloat(appState.calibration.p0.x.toFixed(2)),
      parseFloat(appState.calibration.p0.y.toFixed(2))
    ]));
    formData.append("point_12cm", JSON.stringify([
      parseFloat(appState.calibration.p12.x.toFixed(2)),
      parseFloat(appState.calibration.p12.y.toFixed(2))
    ]));

    try {
      console.log("autoSendTrainingData: Sending training data to API...");
      const response = await fetch("http://localhost:8080/api/collect-training-data", {
        method: "POST",
        body: formData
      });
      if (!response.ok) {
        const errText = await response.text();
        console.error("autoSendTrainingData: Error response:", errText || response.statusText);
      } else {
        const resData = await response.json();
        console.log("autoSendTrainingData: Success! UUID:", resData.uuid);
      }
    } catch (err) {
      console.error("autoSendTrainingData: Fetch error:", err.message);
    }
  }, "image/jpeg", 0.9);
}

async function autoSaveGroundTruth() {
  if (!appState.calibration || !appState.processedCanvas || !appState.sourceName) {
    return;
  }

  const formData = new FormData();
  formData.append("filename", appState.sourceName);
  formData.append("point_0cm", JSON.stringify([
    parseFloat(appState.calibration.p0.x.toFixed(2)),
    parseFloat(appState.calibration.p0.y.toFixed(2))
  ]));
  formData.append("point_12cm", JSON.stringify([
    parseFloat(appState.calibration.p12.x.toFixed(2)),
    parseFloat(appState.calibration.p12.y.toFixed(2))
  ]));
  formData.append("ruler_length_mm", appState.calibration.detectedLengthMm || 120);

  try {
    console.log("autoSaveGroundTruth: Saving ground truth to API...");
    const response = await fetch("http://localhost:8080/api/save-ground-truth", {
      method: "POST",
      body: formData
    });
    if (!response.ok) {
      const errText = await response.text();
      console.error("autoSaveGroundTruth: Error response:", errText || response.statusText);
    } else {
      console.log("autoSaveGroundTruth: Ground truth updated successfully in project file!");
    }
  } catch (err) {
    console.error("autoSaveGroundTruth: Fetch error:", err.message);
  }
}

printBtn.addEventListener("click", async () => {
  if (!appState.calibration || !appState.processedCanvas) {
    setStatus("Please run detection first.", true);
    return;
  }

  try {
    printBtn.disabled = true;
    setStatus("Druckansicht wird vorbereitet ...");

    await printCanvasDirect(appState.calibration, appState.processedCanvas);
  } catch (err) {
    setStatus("Fehler beim Drucken: " + err.message, true);
  } finally {
    printBtn.disabled = false;
  }
});

downloadBtn.addEventListener("click", async () => {
  if (!appState.calibration || !appState.processedCanvas) {
    setStatus("Please run detection first.", true);
    return;
  }

  try {
    downloadBtn.disabled = true;
    setStatus("A4-PDF wird erstellt ...");
    
    // Automatically trigger saving training data and ground truth
    autoSendTrainingData();
    autoSaveGroundTruth();

    const blob = await generateA4Pdf(appState.calibration, appState.processedCanvas);
    await ladeBlobHerunter(blob, filenameWithoutExtension(appState.sourceName) + " scaled.pdf");
    setStatus("PDF erfolgreich erstellt.");
  } catch (err) {
    setStatus("Fehler bei PDF-Erstellung: " + err.message, true);
  } finally {
    downloadBtn.disabled = false;
  }
});


batchInput.addEventListener("change", () => {
  const files = batchInput.files ? batchInput.files.length : 0;
  batchBtn.disabled = !appState.cvReady || files === 0;
});

batchBtn.addEventListener("click", async () => {
  const files = Array.from(batchInput.files || []);
  if (!files.length) {
    setStatus("Bitte Batch-Dateien auswählen.", true);
    return;
  }

  setBusy(true, "Batch wird verarbeitet ...");
  setBatchLogStart(files.length);
  batchBtn.disabled = true;
  let ok = 0;

  for (let i = 0; i < files.length; i += 1) {
    try {
      const source = await loadFileAsSource(files[i]);
      const result = await autoDetectFromSource(source.canvas, source.sourceMeta);
      const cal = calculateCalibrationFromLine(result, result.outputCanvas);
      const blob = await generateA4Pdf(cal, result.outputCanvas);
      await ladeBlobHerunter(blob, filenameWithoutExtension(files[i].name) + " scaled.pdf");
      writeBatchLog(files[i].name + " : OK (" + result.method + ")", "ok");
      ok += 1;
    } catch (err) {
      writeBatchLog(files[i].name + " : FEHLER - " + err.message, "error");
    }
  }

  setStatus(`Batch fertig: ${ok}/${files.length} erfolgreich.`);
  batchBtn.disabled = false;
  setBusy(false);
});

async function autoDetectFromSource(sourceCanvas, sourceMeta) {
  await cvReadyPromise;

  const isPdf = sourceMeta && sourceMeta.isPdf;
  if (!isPdf) {
    const croppedCanvas = await cropAndScaleStencilIfPossible(sourceCanvas);
    if (croppedCanvas !== sourceCanvas) {
      sourceCanvas = croppedCanvas;
      appState.sourceCanvas = croppedCanvas;
      drawBaseCanvas(croppedCanvas);
    }
  }

  if (appState.abortActive) throw new Error("Erkennung abgebrochen");

  const src = cv.imread(sourceCanvas);
  const deskewRes = deskew(src);
  src.delete();

  const baseMat = deskewRes.mat;
  const flippedMat = new cv.Mat();
  cv.rotate(baseMat, flippedMat, cv.ROTATE_180);

  const rulerLengthMm = getRulerLengthMm();
  const candidates = [];

  const tryDetect = (mat, label) => {
    const ruler = detect(mat, sourceMeta, rulerLengthMm);
    if (!ruler) return;
    candidates.push({
      detection: ruler,
      mat,
      label,
    });
  };

  tryDetect(baseMat, "");
  tryDetect(flippedMat, "[rot180] ");

  if (!candidates.length) {
    baseMat.delete();
    flippedMat.delete();
    throw new Error("Keine Skalierungslinie gefunden");
  }

  candidates.sort((a, b) => {
    const da = a.detection;
    const db = b.detection;
    const ma = da.ocrDigits ? da.ocrDigits.filter(d => d.matched).length : 0;
    const mb = db.ocrDigits ? db.ocrDigits.filter(d => d.matched).length : 0;
    if (ma !== mb) return mb - ma;
    
    const aMatchesHint = (da.detectedLengthMm === rulerLengthMm);
    const bMatchesHint = (db.detectedLengthMm === rulerLengthMm);
    if (aMatchesHint && !bMatchesHint) return -1;
    if (!aMatchesHint && bMatchesHint) return 1;

    if (da.reliable && !db.reliable) return -1;
    if (!da.reliable && db.reliable) return 1;
    const aIsTick = da.method && da.method.includes("Tick-Cluster");
    const bIsTick = db.method && db.method.includes("Tick-Cluster");
    if (aIsTick && !bIsTick) return -1;
    if (!aIsTick && bIsTick) return 1;
    return (db.score || 0) - (da.score || 0);
  });
  const best = candidates[0];

  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = best.mat.cols;
  outputCanvas.height = best.mat.rows;
  cv.imshow(outputCanvas, best.mat);

  const result = {
    outputCanvas,
    p0: best.detection.p0,
    p12: best.detection.p12,
    method: best.label + best.detection.method,
    lineReliable: Boolean(best.detection.reliable),
    angleDeg: deskewRes.angle || 0,
    detectedLengthMm: best.detection.detectedLengthMm || rulerLengthMm,
    ocrWordsNormal: [],
    ocrWordsMirrored: [],
    mirrored: best.label !== "",
    ocrDigits: best.detection.ocrDigits || [],
  };

  baseMat.delete();
  flippedMat.delete();

  appState.outputOcrNormalWords = result.ocrWordsNormal;
  appState.outputOcrMirroredWords = result.ocrWordsMirrored;
  appState.outputMirrored = result.mirrored;

  return result;
}

async function startAutoDetection() {
  if (!appState.sourceCanvas) {
    setStatus("Bitte zuerst eine Datei laden.", true);
    return;
  }

  appState.abortActive = false;

  try {
    setBusy(true, "Erkennung läuft ...");
    setStatus("Auto-Erkennung läuft ...");
    const result = await autoDetectFromSource(appState.sourceCanvas, appState.sourceMeta);

    if (appState.abortActive) throw new Error("Erkennung abgebrochen");

    appState.processedCanvas = result.outputCanvas;
    appState.calibration = {
      method: result.method,
      p0: result.p0,
      p12: result.p12,
      lineReliable: result.lineReliable,
      showRulerLine: true,
      overlayColor: result.lineReliable ? "#00a651" : "#d97706",
      forceLineScale: result.lineReliable,
      angleDeg: result.angleDeg,
      detectedLengthMm: result.detectedLengthMm,
      ocrDigits: result.ocrDigits || [],
    };

    if (result.detectedLengthMm === 100) {
      rulerLengthInput.value = "10";
    } else if (result.detectedLengthMm === 120) {
      rulerLengthInput.value = "12";
    } else {
      rulerLengthInput.value = "custom";
      rulerLengthCustomInput.value = (result.detectedLengthMm / 10).toString();
    }
    updateCalibrationFromLine(result.method, result.lineReliable, true);
    updateRulerLengthUi();
    await updateOcrDiagnosticsFromCalibration();

    if (appState.abortActive) throw new Error("Erkennung abgebrochen");

    if (!result.lineReliable) {
      setAutoAlarm(true, "ALARM: Automatische Erkennung unsicher. Vorschlagslinie prüfen, dann per Drag-and-Drop oder manuell korrigieren.");
      setStatus("Automatik unsicher: Bitte Vorschlagslinie prüfen.");
    } else {
      setAutoAlarm(false);
      if (appState.calibration.imageBreiteMm > A4_WIDTH_MM || appState.calibration.imageHöheMm > A4_HEIGHT_MM) {
        setStatus("Verarbeitung abgeschlossen. Hinweis: Inhalt ist bei 1:1 größer als A4 und kann beschnitten werden.");
      } else {
        setStatus("Verarbeitung abgeschlossen. PDF kann heruntergeladen werden.");
      }
    }

    downloadBtn.disabled = false;
    printBtn.disabled = false;
  } catch (err) {
    if (err.message === "Erkennung abgebrochen" || appState.abortActive) {
      // Handled by abortBtn click.
    } else {
      setStatus("Erkennung fehlgeschlagen: " + err.message + ". A default calibration line has been set.", true);
      enableFallbackCalibration("Standard-Vorgabe (Erkennung fehlgeschlagen)");
    }
  } finally {
    setBusy(false);
  }
}

function drawBaseCanvas(canvas) {
  previewCanvas.width = canvas.width;
  previewCanvas.height = canvas.height;
  previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  previewCtx.drawImage(canvas, 0, 0);
}

function drawCurrentPreview() {
  if (!appState.processedCanvas || (!appState.calibration && !appState.manualActive)) {
    if (appState.sourceCanvas) drawBaseCanvas(appState.sourceCanvas);
    return;
  }

  drawBaseCanvas(appState.processedCanvas);

  if (appState.calibration) {
    const { p0, p12 } = appState.calibration;
    const color = appState.calibration.overlayColor || (appState.calibration.lineReliable ? "#00a651" : "#d97706");

    previewCtx.save();
    if (!appState.calibration.lineReliable) {
      previewCtx.setLineDash([10, 7]);
    }
    previewCtx.strokeStyle = color;
    previewCtx.fillStyle = color;
    previewCtx.lineWidth = Math.max(1.5, previewCanvas.width / 800);
    previewCtx.beginPath();
    previewCtx.moveTo(p0.x, p0.y);
    previewCtx.lineTo(p12.x, p12.y);
    previewCtx.stroke();
    previewCtx.setLineDash([]);

    drawEndpointMarker(previewCtx, p0, p12, color);
    drawEndpointMarker(previewCtx, p12, p0, color);
    
    // Draw tickmarks along the ruler
    const dx = p12.x - p0.x;
    const dy = p12.y - p0.y;
    const len = Math.hypot(dx, dy);
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;
    
    // Support dynamic ruler length (e.g. 100mm vs 120mm) instead of hardcoded 120
    const snapMm = appState.calibration.detectedLengthMm || getRulerLengthMm() || 120;
    const pxPerMm = len / snapMm;
    
    // Scale tick marks proportionally to canvas size so they are beautifully visible
    const maxDim = Math.max(previewCanvas.width, previewCanvas.height);
    const cmLen = Math.max(12, Math.round(maxDim / 100)); // 1 cm tick length
    const halfCmLen = Math.round(cmLen * 0.7);
    const mmLen = Math.round(cmLen * 0.4);
    
    const origWidth = previewCtx.lineWidth;
    
    for (let i = 0; i <= snapMm; i++) {
      const isCm = (i % 10 === 0);
      const isHalfCm = (i % 5 === 0 && !isCm);
      
      let tickLength = mmLen;
      let tickWidth = Math.max(1, origWidth * 0.5);
      
      if (isCm) {
        tickLength = cmLen;
        tickWidth = Math.max(1.5, origWidth * 1.2);
      } else if (isHalfCm) {
        tickLength = halfCmLen;
        tickWidth = Math.max(1.2, origWidth * 0.8);
      }
      
      const pxOffset = i * pxPerMm;
      const tx = p0.x + ux * pxOffset;
      const ty = p0.y + uy * pxOffset;
      
      previewCtx.beginPath();
      previewCtx.lineWidth = tickWidth;
      previewCtx.moveTo(tx, ty);
      previewCtx.lineTo(tx + nx * tickLength, ty + ny * tickLength);
      previewCtx.stroke();
    }
    
    previewCtx.lineWidth = origWidth;
    previewCtx.restore();
  }



  if (appState.manualActive && appState.manualPoints.length === 1) {
    const p0 = appState.manualPoints[0];
    previewCtx.fillStyle = "#0ea55f";
    zeichnePunkt(previewCtx, p0.x, p0.y, 7);

    if (appState.manualHover) {
      const p12 = appState.manualHover;
      const color = "#0ea55f";

      previewCtx.save();
      previewCtx.setLineDash([5, 5]);
      previewCtx.strokeStyle = color;
      previewCtx.lineWidth = Math.max(1.5, previewCanvas.width / 800);
      previewCtx.beginPath();
      previewCtx.moveTo(p0.x, p0.y);
      previewCtx.lineTo(p12.x, p12.y);
      previewCtx.stroke();
      previewCtx.setLineDash([]);

      // Draw tickmarks along the hover line
      const dx = p12.x - p0.x;
      const dy = p12.y - p0.y;
      const len = Math.hypot(dx, dy);
      if (len > 10) {
        const ux = dx / len;
        const uy = dy / len;
        const nx = -uy;
        const ny = ux;

        const snapMm = getRulerLengthMm() || 120;
        const pxPerMm = len / snapMm;

        const maxDim = Math.max(previewCanvas.width, previewCanvas.height);
        const cmLen = Math.max(12, Math.round(maxDim / 100));
        const halfCmLen = Math.round(cmLen * 0.7);
        const mmLen = Math.round(cmLen * 0.4);

        const origWidth = previewCtx.lineWidth;

        for (let i = 0; i <= snapMm; i++) {
          const isCm = (i % 10 === 0);
          const isHalfCm = (i % 5 === 0 && !isCm);

          let tickLength = mmLen;
          let tickWidth = Math.max(1, origWidth * 0.5);

          if (isCm) {
            tickLength = cmLen;
            tickWidth = Math.max(1.5, origWidth * 1.2);
          } else if (isHalfCm) {
            tickLength = halfCmLen;
            tickWidth = Math.max(1.2, origWidth * 0.8);
          }

          const pxOffset = i * pxPerMm;
          const tx = p0.x + ux * pxOffset;
          const ty = p0.y + uy * pxOffset;

          previewCtx.beginPath();
          previewCtx.lineWidth = tickWidth;
          previewCtx.moveTo(tx, ty);
          previewCtx.lineTo(tx + nx * tickLength, ty + ny * tickLength);
          previewCtx.stroke();
        }
        previewCtx.lineWidth = origWidth;
      }
      previewCtx.restore();
    }
  }

  const isDragging = appState.drag && appState.drag.active && (appState.drag.mode === "p0" || appState.drag.mode === "p12");
  const isHoveringManual = appState.manualActive && appState.manualHover;

  // Draw magnifying circle when dragging ruler endpoints p0 or p12 or hovering manually
  if (isDragging || isHoveringManual) {
    let dragPoint;
    if (isDragging) {
      dragPoint = appState.drag.mode === "p0" ? appState.calibration.p0 : appState.calibration.p12;
    } else {
      dragPoint = appState.manualHover;
    }
    const magRadius = 100;
    const zoom = 2.5;
    
    // Position of the magnifying glass (shifted upwards so user's cursor doesn't cover it)
    let magX = dragPoint.x;
    let magY = dragPoint.y - 140;
    
    // Bounds check to keep magnifier visible within the canvas
    if (magY - magRadius < 10) {
      // If too close to the top, position it below the drag point instead
      magY = dragPoint.y + 140;
    }
    if (magX - magRadius < 10) {
      magX = magRadius + 10;
    } else if (magX + magRadius > previewCanvas.width - 10) {
      magX = previewCanvas.width - magRadius - 10;
    }

    previewCtx.save();
    
    // Draw white shadow/background circle first
    previewCtx.beginPath();
    previewCtx.arc(magX, magY, magRadius, 0, 2 * Math.PI);
    previewCtx.fillStyle = "#ffffff";
    previewCtx.fill();

    // Clip to the magnifying circle
    previewCtx.beginPath();
    previewCtx.arc(magX, magY, magRadius, 0, 2 * Math.PI);
    previewCtx.clip();

    // Draw the zoomed-in image
    const srcSize = (magRadius * 2) / zoom;
    const sx = dragPoint.x - srcSize / 2;
    const sy = dragPoint.y - srcSize / 2;
    
    previewCtx.drawImage(
      appState.processedCanvas,
      sx, sy, srcSize, srcSize,
      magX - magRadius, magY - magRadius, magRadius * 2, magRadius * 2
    );

    // Restore clipping path so we can draw border and crosshair
    previewCtx.restore();

    previewCtx.save();
    // Draw the border of the magnifying glass
    previewCtx.beginPath();
    previewCtx.arc(magX, magY, magRadius, 0, 2 * Math.PI);
    previewCtx.strokeStyle = "#1e293b"; // Sleek dark slate
    previewCtx.lineWidth = 3;
    previewCtx.stroke();
    
    // Draw a thin inner white ring for premium look
    previewCtx.beginPath();
    previewCtx.arc(magX, magY, magRadius - 1.5, 0, 2 * Math.PI);
    previewCtx.strokeStyle = "#ffffff";
    previewCtx.lineWidth = 1;
    previewCtx.stroke();

    // Draw crosshair at the center of the magnifier
    previewCtx.strokeStyle = "#ff00ff"; // Match calibration color (magenta)
    previewCtx.lineWidth = 1.5;
    
    // Horizontal crosshair line
    previewCtx.beginPath();
    previewCtx.moveTo(magX - 10, magY);
    previewCtx.lineTo(magX + 10, magY);
    previewCtx.stroke();
    
    // Vertical crosshair line
    previewCtx.beginPath();
    previewCtx.moveTo(magX, magY - 10);
    previewCtx.lineTo(magX, magY + 10);
    previewCtx.stroke();

    previewCtx.restore();
  }
}

function updateMetrics() {
  const rulerLengthCm = getRulerLengthCm();
  if (!appState.calibration) {
    methodValue.textContent = "Methode: -";
    angleValue.textContent = "Korrekturwinkel: -";
    distanceValue.textContent = `0-${rulerLengthCm} cm Distanz (px): -`;
    resolutionValue.textContent = "Berechnete Auflösung: -";
    sizeValue.textContent = "Bildgröße bei 1:1: -";
    ocrNormalValue.textContent = "OCR (Normal): -";
    ocrMirroredValue.textContent = "OCR (Gespiegelt): -";
    return;
  }

  const c = appState.calibration;
  methodValue.textContent = "Methode: " + c.method;
  angleValue.textContent = "Korrekturwinkel: " + (c.angleDeg || 0).toFixed(2) + "°";
  distanceValue.textContent = `0-${rulerLengthCm} cm Distanz (px): ` + c.pixelDist.toFixed(2);
  resolutionValue.textContent = "Berechnete Auflösung: " + c.pxPerMm.toFixed(4) + " px/mm";
  sizeValue.textContent = "Bildgröße bei 1:1: " + c.imageBreiteMm.toFixed(2) + " mm × " + c.imageHöheMm.toFixed(2) + " mm";
  const busyText = appState.ocrBusy ? "läuft ..." : "-";
  const wordsNormal = appState.outputOcrNormalWords && appState.outputOcrNormalWords.length
    ? appState.outputOcrNormalWords.join(", ")
    : busyText;
  const wordsMirrored = appState.outputOcrMirroredWords && appState.outputOcrMirroredWords.length
    ? appState.outputOcrMirroredWords.join(", ")
    : busyText;
  ocrNormalValue.textContent = "OCR (Normal): " + wordsNormal;
  ocrMirroredValue.textContent = "OCR (Gespiegelt): " + wordsMirrored;
}
window.updateMetrics = updateMetrics;

function resetStateForNewFile() {
  appState.calibration = null;
  appState.processedCanvas = null;
  appState.manualActive = false;
  appState.manualPoints = [];
  appState.manualHover = null;
  appState.drag = { active: false, mode: null, last: null };
  appState.outputOcrNormalWords = [];
  appState.outputOcrMirroredWords = [];
  appState.outputMirrored = null;
  appState.ocrBusy = false;
  appState.ocrRequestId += 1;
  appState.userOverrodeLength = false;
  manualNote.style.display = "none";
  setAutoAlarm(false);
  setBusy(false);
  downloadBtn.disabled = true;
  printBtn.disabled = true;
  updateMetrics();
}

function setAutoAlarm(aktiv, text = "") {
  appState.alarmActive = aktiv;
  if (!aktiv) {
    autoAlarm.style.display = "none";
    autoAlarm.textContent = "";
    return;
  }
  autoAlarm.textContent = text || "ALARM: Automatische Erkennung unsicher.";
  autoAlarm.style.display = "block";
}

function setBusy(aktiv, text = "In Bearbeitung ...") {
  if (!busyIndicator) {
    return;
  }
  if (!aktiv) {
    busyIndicator.style.display = "none";
    return;
  }
  const label = busyIndicator.querySelector(".busy-label");
  if (label) {
    label.textContent = text;
  }
  busyIndicator.style.display = "block";
}

function setBatchLogStart(count) {
  batchLog.innerHTML = "";
  writeBatchLog("Batch gestartet: " + count + " Datei(en)", "");
}

function writeBatchLog(text, type) {
  const item = document.createElement("div");
  item.className = "batch-item" + (type ? " " + type : "");
  item.textContent = text;
  batchLog.appendChild(item);
  batchLog.scrollTop = batchLog.scrollHeight;
}

async function ladeBlobHerunter(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  await new Promise((resolve) => setTimeout(resolve, 180));
  URL.revokeObjectURL(url);
}

async function printCanvasDirect(cal, imageCanvas) {
  const pdfBlob = await generateA4Pdf(cal, imageCanvas);
  const pdfUrl = URL.createObjectURL(pdfBlob);
  const frame = document.createElement("iframe");
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  frame.src = pdfUrl;
  document.body.appendChild(frame);

  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setTimeout(() => {
        frame.remove();
        URL.revokeObjectURL(pdfUrl);
        resolve();
      }, 1800);
    };

    frame.onload = () => {
      setTimeout(() => {
        try {
          frame.contentWindow.focus();
          frame.contentWindow.print();
          setStatus("Druckdialog geöffnet. Bitte auf 100% / Tatsächliche Größe achten.");
        } catch {
          setStatus("Druckdialog konnte nicht direkt geöffnet werden. Bitte PDF herunterladen und drucken.");
        } finally {
          finish();
        }
      }, 350);
    };

    frame.onerror = () => {
      try {
        setStatus("Druckdialog konnte nicht direkt geöffnet werden. Bitte PDF herunterladen und drucken.");
      } finally {
        finish();
      }
    };
  });
}

function setStatus(text, isError = false) {
  statusBox.textContent = "Status: " + text;
  statusBox.classList.toggle("error", Boolean(isError));
}

function waitForOpenCv() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const ready = window.cv && typeof cv.Mat === "function";
      if (ready) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > 45000) {
        clearInterval(timer);
        reject(new Error("Timeout loading OpenCV.js"));
      }
    }, 120);
  });
}

function canvasCoordinateFromClick(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    x: (event.clientX - rect.left) * (canvas.width / rect.width),
    y: (event.clientY - rect.top) * (canvas.height / rect.height),
  };
}

function pointToLineDistance(p, a, b) {
  const l2 = Math.max(1e-6, distance(a, b) ** 2);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
  const proj = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
  return distance(p, proj);
}

function determineHoverMode(p) {
  if (!appState.calibration) {
    return "none";
  }
  const { p0, p12 } = appState.calibration;
  const r = 18;
  if (distance(p, p0) <= r) {
    return "p0";
  }
  if (distance(p, p12) <= r) {
    return "p12";
  }
  if (pointToLineDistance(p, p0, p12) <= 14) {
    return "line";
  }
  return "none";
}

function drawEndpointMarker(ctx, endpoint, other, color) {
  const dx = other.x - endpoint.x;
  const dy = other.y - endpoint.y;
  const len = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;

  const maxDim = Math.max(previewCanvas.width, previewCanvas.height);
  const half = Math.max(10, Math.round(maxDim / 120));
  const thick = Math.max(1.5, Math.round(maxDim / 600));
  const crosshairRadius = Math.max(4, Math.round(maxDim / 300));

  ctx.save();
  ctx.fillStyle = color;

  ctx.beginPath();
  ctx.moveTo(endpoint.x + px * half, endpoint.y + py * half);
  ctx.lineTo(endpoint.x + ux * thick, endpoint.y + uy * thick);
  ctx.lineTo(endpoint.x - px * half, endpoint.y - py * half);
  ctx.lineTo(endpoint.x - ux * thick, endpoint.y - uy * thick);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(endpoint.x - ux * half, endpoint.y - uy * half);
  ctx.lineTo(endpoint.x + px * thick, endpoint.y + py * thick);
  ctx.lineTo(endpoint.x - px * thick, endpoint.y - py * thick);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, Math.round(maxDim / 1000));
  ctx.beginPath();
  ctx.arc(endpoint.x, endpoint.y, crosshairRadius, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function zeichnePunkt(ctx, x, y, radius) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI);
  ctx.fill();
}

function filenameWithoutExtension(name) {
  return (name || "schablone").replace(/\.[^/.]+$/, "");
}

function updateCalibrationFromLine(methodName, lineReliable, forceLineScale) {
  if (!appState.calibration || !appState.processedCanvas) return;

  const p0 = appState.calibration.p0;
  const p12 = appState.calibration.p12;
  const pixelDist = distance(p0, p12);
  if (!Number.isFinite(pixelDist) || pixelDist < 10) {
    setStatus("Kalibrierlinie zu kurz. Bitte korrigieren.", true);
    return;
  }

  const rulerLengthCm = getRulerLengthCm();
  const rulerLengthMm = getRulerLengthMm();

  let pointsPerPixel;
  if (forceLineScale || !appState.sourceMeta || !appState.sourceMeta.isPdf) {
    pointsPerPixel = mmToPt(rulerLengthMm) / pixelDist;
  } else {
    pointsPerPixel = appState.sourceMeta.pageBreitePt / appState.processedCanvas.width;
  }

  const pxPerMm = 1 / (pointsPerPixel / (72 / 25.4));
  const imageBreiteMm = appState.processedCanvas.width / pxPerMm;
  const imageHöheMm = appState.processedCanvas.height / pxPerMm;

  appState.calibration = {
    ...appState.calibration,
    method: methodName,
    lineReliable,
    forceLineScale,
    pixelDist,
    pxPerMm,
    pointsPerPixel,
    imageBreiteMm,
    imageHöheMm,
    detectedLengthMm: rulerLengthMm,
  };

  drawCurrentPreview();
  updateMetrics();
}

async function updateOcrDiagnosticsFromCalibration() {
  if (!appState.calibration || !appState.processedCanvas) {
    return;
  }

  if (appState.outputOcrNormalWords && appState.outputOcrNormalWords.length > 0) {
    appState.ocrBusy = false;
    updateMetrics();
    return;
  }

  const requestId = ++appState.ocrRequestId;
  appState.ocrBusy = true;
  updateMetrics();

  try {
    const normalized = await normalizeImageOrientation(appState.calibration, appState.processedCanvas);
    if (requestId !== appState.ocrRequestId) {
      return;
    }
    appState.outputOcrNormalWords = normalized.ocrWordsNormal || [];
    appState.outputOcrMirroredWords = normalized.ocrWordsMirrored || [];
    appState.outputMirrored = Boolean(normalized.mirrored);

    const detectedLengthMm = appState.calibration.detectedLengthMm || getRulerLengthMm();
    const detectedLengthCm = detectedLengthMm / 10;

    const ocrWords = [...appState.outputOcrNormalWords, ...appState.outputOcrMirroredWords];
    const ocrNumbers = [];
    for (const w of ocrWords) {
      const matches = w.match(/\b\d+\b/g);
      if (matches) {
        ocrNumbers.push(...matches.map(Number));
      }
    }
    const validOcrCms = ocrNumbers.filter(n => n === 10 || n === 12);

    let finalCm = detectedLengthCm;
    let methodRefined = false;
    const closeOcr = validOcrCms.find(n => Math.abs(n - detectedLengthCm) <= 1.5);
    if (closeOcr !== undefined) {
      finalCm = closeOcr;
      methodRefined = true;
    } else {
      const distTo10 = Math.abs(detectedLengthCm - 10);
      const distTo12 = Math.abs(detectedLengthCm - 12);
      finalCm = distTo10 < distTo12 ? 10 : 12;
    }

    if (finalCm !== 10 && finalCm !== 12) {
      finalCm = 12;
    }

    const currentInputVal = getRulerLengthCm();
    if (!appState.userOverrodeLength && currentInputVal !== finalCm) {
      if (finalCm === 10) {
        rulerLengthInput.value = "10";
      } else if (finalCm === 12) {
        rulerLengthInput.value = "12";
      } else {
        rulerLengthInput.value = "custom";
        rulerLengthCustomInput.value = finalCm.toString();
      }
      updateRulerLengthUi();
      updateCalibrationFromLine(
        appState.calibration.method + (methodRefined ? " + OCR-Korrektur" : " (automatisch erkannt)"),
        appState.calibration.lineReliable,
        appState.calibration.forceLineScale
      );
    }
  } catch {
    if (requestId !== appState.ocrRequestId) {
      return;
    }
    appState.outputOcrNormalWords = [];
    appState.outputOcrMirroredWords = [];
    appState.outputMirrored = null;
  } finally {
    if (requestId !== appState.ocrRequestId) {
      return;
    }
    appState.ocrBusy = false;
    updateMetrics();
  }
}

// Global initialization
(function initPreview() {
  previewCtx.fillStyle = "#f4f8f5";
  previewCtx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
  previewCtx.fillStyle = "#6b7e71";
  previewCtx.font = "600 24px Avenir Next";
  previewCtx.textAlign = "center";
  previewCtx.fillText("Vorschau erscheint nach Upload", previewCanvas.width / 2, previewCanvas.height / 2);
  updateRulerLengthUi();
})();
