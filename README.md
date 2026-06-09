# Stoma-Schablonen Skalierer (Stoma Stencil Scaler)

Ein reines Browser-basiertes Werkzeug, das eingescannte Stoma-Messschablonen oder Fotos davon in druckfertige A4-PDFs im exakten 1:1-Maßstab konvertiert.

## Features

- **Import**: Unterstützt PDF (Seite 1), JPG, JPEG und PNG.
- **Auto-Kompensierung**: Korrigiert automatisch schräge Scans (Deskewing) und unerwünschte Spiegelungen (Mirroring).
- **Ruler-Kalibrierung**:
  - Wählt zwischen **10 cm** und **12 cm** Lineallänge.
  - Erkennt das Lineal automatisch anhand von Strichen (Ticks) und OCR.
  - Ermöglicht das präzise Drag-and-Drop der Linie sowie manuelle Kalibrierung per Klick.
  - **Präzisions-Modus**: Die Kalibrierung richtet sich exakt an den **Außenkanten** der 0 cm und 10/12 cm Markierungen aus.
- **Intelligente Bildaufbereitung**:
  - Erkennt bei kleineren Objekten oder fernen Fotos (z.B. Smartphone-Fotos) die Konturen der Schablonenschablone, schneidet das Bild automatisch zu (Auto-Crop) und skaliert es hoch, um die Erkennungsrate und Druckauflösung zu optimieren.
- **Ausfallsicherheit**: Schlägt die automatische Erkennung fehl, blockiert die App nicht. Es wird eine Standard-Linie gesetzt, die manuell justiert werden kann, so dass der Druck- und Downloadpfad immer verfügbar bleibt.
- **Erkennungs-Abbruch**: Bietet einen Button zum sofortigen Beenden der Auto-Erkennung sowie ein automatisches Zeitlimit (Timeout von 8 Sekunden) für OCR-Vorgänge, um Systemhänger zu vermeiden.
- **Ausgabe**: Erzeugt ein einseitiges A4-PDF mit 10 mm Seitenrand. Direktes Drucken oder Herunterladen möglich.
- **Batch-Modus**: Ermöglicht die parallele Verarbeitung mehrerer Vorlagen.

## Lokale Nutzung

### macOS / Linux
Öffnen Sie einfach die Datei [index.html](index.html) in Ihrem Webbrowser oder doppelklicken Sie im Ordner `offline_package` auf die Datei `start_stoma.command` (startet einen lokalen Webserver für reibungslose PDF-Verarbeitung).

### Windows
Starten Sie im Ordner `offline_package` die Datei `start_stoma_windows.bat` oder `start_stoma_windows.ps1` per Doppelklick.

## Technologie-Stack

- **Struktur & Logik**: HTML5 und Vanilla JavaScript (ES6)
- **Styling**: Modernes CSS3 (Responsive Grid-Layout)
- **Bildverarbeitung**: OpenCV.js
- **Texterkennung (OCR)**: Tesseract.js (zur Erkennung von Orientierung und Linealwerten)
- **PDF-Rendering**: PDF.js
- **PDF-Generierung**: PDF-Lib

## Offline-Paket erzeugen (On-Demand)

Das Offline-Paket (`stoma_offline_package.zip` und der Ordner `offline_package/`) wird **ausschließlich bei Bedarf (on-demand)** gebaut. Es sollte **nicht** bei jeder Änderung automatisch neu generiert werden.

Um das Offline-Paket manuell zu aktualisieren, führen Sie das Build-Skript im Stammverzeichnis aus:
- **macOS/Linux**: Doppelklick auf `build_offline_package.command` oder Ausführen von `./build_offline_package.command` im Terminal.
- Das Skript kopiert die aktuelle `index.html`, ersetzt CDN-Ressourcen durch lokale Offline-Bibliotheken im Ordner `vendor/` und packt alles in das Zip-Archiv.

## Testing & Ground Truth Philosophy

The algorithm is only evaluated against purely human-measured ground truth to prepare for future ML training. Auto-passing is strictly disabled. 

- **Manual Verification Only:** The E2E tests (`run_direct_tests.js`) will fail loudly and abort if a stencil does not have a confirmed ground truth entry in `ruler_ground_truth.json`.
- **No Auto-Generation:** The test framework is forbidden from auto-generating baselines based on current algorithmic outputs.
- **Privacy:** Real medical images or PII/PHI must never be committed to the public repository. Use `.gitignore` rules for all test images and outputs.
