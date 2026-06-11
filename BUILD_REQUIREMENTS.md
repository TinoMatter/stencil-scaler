# Stoma Stencil Scaler: Build Requirements

## Purpose
Build a browser-based tool that takes a scanned stoma template sheet and produces a print-ready A4 PDF at true 1:1 scale.

The application is intended for end users who may receive scans or PDFs of stoma sizing templates and need a reliable, printable output without manual image editing.

## Product Goal
The tool must:
- Accept a source document containing a ruler and the template sheet.
- Detect and calibrate the ruler from the scan.
- Normalize orientation so the ruler is at the top.
- Correct horizontal mirroring when needed.
- Produce a single-page A4 output that prints at actual size.
- Be usable locally without requiring Python or a developer environment.

## Conversation-Derived Requirements
This specification must explicitly reflect the concrete points raised during the product conversation, including later corrections that overruled earlier assumptions.

### Directly stated user requirements
- Crop the resulting PDF to only the first page.
- If the source is mirrored, mirror it back for output.
- Keep the ruler at the top after normalization.
- The local version must run on a fresh Windows laptop without assuming Python is installed.
- Output must use a 1 cm margin.
- Direct print must not spill onto two pages.
- Mirroring must be robust enough for real scanned inputs, not just ideal examples.
- The UI must show OCR output for mirrored and non-mirrored variants.
- The project should support both a local/offline package and a public static-hosted variant.

### Later corrections that supersede earlier behavior
- OCR diagnostics must be shown without requiring the user to click download first.
- `OCR (Final-Ausgabe)` is not needed in the UI and should not be part of the required surface.
- `OCR (Normal)` and `OCR (Gespiegelt)` must show real orientation-specific OCR results.
- The app must not use a display fallback that makes both OCR sides show the same canonical keywords.
- If OCR is weak, showing raw or weak OCR is preferable to hiding the difference between orientations.
- The app must support rulers whose real length is not 12 cm.
- The user must be able to enter the actual ruler length in cm.
- Automatic recognition of ruler length is optional and exploratory, but when active, it must work and snap to either `10` or `12` cm (these are the only two valid ruler lengths).
- The ruler length input must be restricted to a dropdown select of either `10` or `12` cm.
- The calibration line must align exactly with the **outer edges** of the 0 and 10/12 cm markings for scale accuracy. The visual design and instructions must reflect this.
- If auto-detection fails, the app must not fail with a blocking error. Instead, it must place a default horizontal calibration line (marked as uncertain/orange) in the middle of the image, show a warning, and allow the user to adjust the line manually and proceed to print/download.
- To handle photos where stencils are small in the image, the app must run contour detection to find the stencil sheet boundaries, crop to those boundaries, and scale the canvas up to ensure high calibration accuracy and print quality.
- Added a cancel/abort button to interrupt auto-detection if it takes too long or hangs, and implemented a Tesseract OCR timeout of 8 seconds.
- CRITICAL: The offline package (stoma_offline_package.zip / offline_package/) must NOT be built or synchronized continuously. It should only be built on-demand using the build command script when explicitly requested.
- A README.md must be added to the repository root.
- The stencils test folder `01_Schablonen_Vorlagen_für_Tests` is available for local testing.

### Important nuance on sample expectations
- Earlier in the conversation there was a desire that the difficult sample `20260408094907_001.pdf` should show the same meaningful words rather than only a bad token such as `wong`.
- Later, the stronger requirement became that mirrored and non-mirrored OCR outputs must visibly differ when orientation differs, and that the app must not fake this similarity through fallback display logic.
- When rebuilding from scratch, treat the later transparency requirement as authoritative for the OCR diagnostics UI.

## Delivery Modes
The same application must be available in two forms:
- Main local/source version: editable working copy.
- Offline/public package: a self-contained static web app suitable for local use and GitHub Pages hosting.

Both variants must stay behaviorally identical.

## Architecture Requirements
The application should run entirely in the browser.

### Hard constraints
- No server-side processing is required for core functionality.
- All image/PDF loading, OCR, orientation analysis, scaling, and PDF creation must happen client-side.
- The app must work as a static site.
- The public/offline package must be distributable as plain files plus simple launch scripts.

### Suggested browser-side libraries
These are not mandatory if replaced by equivalent behavior, but they reflect the intended architecture:
- `pdf.js`: render the first page of uploaded PDFs.
- `pdf-lib`: generate the final one-page A4 PDF.
- `OpenCV.js`: line detection, deskewing, ruler detection, orientation normalization.
- `Tesseract.js`: OCR for orientation/mirroring diagnostics and optional ruler-length inference.

## Input Requirements
The app must accept:
- PDF files
- JPG files
- JPEG files
- PNG files

### PDF behavior
- Only the first page of the uploaded PDF is used.
- The final generated PDF must also contain exactly one page.
- This first-page-only behavior applies both to downloaded output and to the direct-print path.

## Core User Flow
1. User uploads a PDF or image.
2. The app renders the source and starts automatic detection.
3. The app identifies the ruler line and uses it for scale calibration.
4. The app shows a preview with the detected calibration line.
5. The user can accept, drag-adjust, or manually set the ruler endpoints.
6. The app prepares a print-ready A4 composition.
7. The user can either:
   - Download a single-page A4 PDF
   - Print directly via the generated PDF flow

## Calibration Requirements
### Primary calibration behavior
- The app must calibrate scale from the ruler visible in the source document.
- The calibration line represents the actual known ruler length.
- The application must calculate pixels-per-mm from that span.

### Manual ruler length input
This is a required feature.
- The user must be able to enter the actual ruler length in centimeters.
- The default value may be `12`, but it must not be hardcoded as the only usable length.
- All scale calculations must use the user-entered ruler length.
- The UI must clearly indicate which two points the user is setting, e.g. `0 cm` and `{entered length} cm`.
- Any metric labels and status text must reflect the entered ruler length rather than always saying `12 cm`.

### Optional automatic ruler-length recognition
This is desirable but must not replace the manual input.
- If feasible, the app may try to infer ruler length automatically from:
  - OCR of printed numbers on the ruler
  - Counting tick marks / line intervals
  - Combining OCR and tick-count evidence
- Automatic inference should only be advisory unless confidence is strong.
- Manual input must remain the authoritative override.
- If auto-detection disagrees with the user-entered length, the user-entered value wins.
- A rebuild should consider both number recognition and tick-count analysis because those were explicitly discussed as candidate strategies.

### Manual calibration mode
- The user must be able to click two points manually on the preview.
- Those points represent `0 cm` and the configured ruler length.
- Manual calibration must update the scale immediately.

### Fine adjustment
- The calibration line must be draggable.
- The user must be able to drag each endpoint or the whole line.
- Dragging should trigger recalculation of scale and diagnostics.

## Automatic Detection Requirements
### Image preparation
The app must try to improve the source before calibration:
- Deskew/straighten rotated input.
- Detect the ruler line or ruler tick cluster.
- Use PDF page geometry when available as plausibility support.

### Stencil Anatomy

All stoma stencils share a common layout. Understanding this anatomy is critical for avoiding false positives during ruler detection.

### Ruler (edge-mounted)
- A **linear ruler** printed along one edge of the stencil card. The horizontal printed line sometimes spans edge-to-edge, and sometimes it does not.
- **Coloplast** stencils: ruler is at the **top** edge, spanning 0–12 cm with mm subdivisions.
- **Publicare** stencils: ruler is at the **bottom** edge, spanning 0–10 cm with mm subdivisions.
- The ruler has **tick marks** of varying lengths: **short** (for every mm), **medium** (for 5mm / half-cm marks), and **long** (for every cm).
- **Numbers** (1, 2, 3 ... 10 or 12) are printed at cm positions along the ruler.
- The distance between tick marks (1mm) is the key to determining the image's pixel-per-mm resolution.
- **CRITICAL DEFINITION:** For calibration, the exact coordinates must correspond to the **0 and 10/12 cm tick marks**, NOT the physical ends of the printed horizontal line (which often extends a few millimeters past the ticks).
- The ruler is the **only feature** that should be used for scale calibration.

### Concentric Circles (center of stencil)
- A set of **concentric circles** in the center of the card, used for stoma sizing.
- These circles have their **own numbers** printed alongside them (e.g., 40, 50, 60, 70, 80, 90, 100 on one side and 35, 45, 55, 65, 75, 85, 95 on the other).
- The circle numbers represent **mm diameters**, not ruler positions.
- The spacing between concentric circles is **larger** than ruler tick spacing.
- **These circle numbers and tick patterns MUST NOT be confused with the ruler.** They are a major source of false positives for both tick detection and OCR-based ruler recognition.

### Other Features
- A **dashed horizontal line** through the center of the stencil (body midline marker).
- Brand text, logos, and fields ("Name:", "Datum:").
- The stencil number (circled digit) in a corner.

### Orientation Variations
- Depending on how the stencil is scanned or photographed, the ruler may appear at **any edge** (top, bottom, left, right) and the text/numbers may be **mirrored**.
- The algorithm must handle both orientations: ruler at top (Coloplast default) and ruler at bottom (Publicare default).
- After processing, the ruler is **always rotated to the top**, even if that means the text body ends up upside down.

## Ruler detection strategy
The app should prefer a reliable ruler detection strategy such as:
- Tick-cluster detection for repeated ruler marks.
- Fallback to the strongest plausible line if tick clustering fails.

### Constrained Search Strategy
- After OCR determines the brand (Coloplast/Publicare) and the ruler position (top/bottom), and after rotating to place the ruler at the top, the ruler search must be **constrained to the top 25% band** of the oriented image.
- This eliminates false positives from concentric circle numbers, fold/dashed lines, and handwriting in the lower portions of the stencil.
- If the constrained search fails, a full-image fallback search is attempted.

### Confidence handling
- If detection is reliable, show a confident state.
- If detection is uncertain, show a visible warning/alarm and let the user correct it.

## Orientation and Mirroring Requirements
### Rotation normalization
- The content should be rotated so the ruler is horizontal.
- The ruler should end up on top of the page whenever possible.

### Mirroring correction
- If the source is mirrored, the app must be able to mirror it back.
- The mirror decision can use OCR and/or image heuristics.
- The applied print output must use the corrected orientation.
- The OCR diagnostics UI must remain transparent enough that a user can inspect why the mirrored or non-mirrored variant appears preferable.

## OCR Diagnostics Requirements
The UI should expose OCR diagnostics to make orientation decisions transparent.

### Required displayed diagnostics
- `OCR (Normal)`: OCR result on the non-mirrored candidate.
- `OCR (Gespiegelt)`: OCR result on the mirrored candidate.

### Explicitly not required
- `OCR (Final-Ausgabe)` is not needed in the UI.

### Behavior rules
- The app should show genuine orientation-specific OCR output.
- Do not artificially make both sides look the same via aggressive display fallback.
- If OCR is weak, show the weak/raw result rather than replacing both sides with identical canonical keywords.
- The two sample PDFs should demonstrate different results between normal and mirrored paths when the scan orientation differs.
- OCR diagnostics should appear during or immediately after detection, not only after export.

## Output Composition Requirements
### A4 output
- Output must be composed onto A4 size.
- The final file must be a one-page PDF only.
- The direct print flow must also use the single-page generated PDF path, not raw browser printing of the source canvas.

### Margins
- Use a fixed 10 mm margin on all sides.
- If necessary, centrally crop content to fit the printable area.
- The margin requirement is part of the product contract, not just an implementation detail.

### Scale fidelity
- Output must preserve true 1:1 scale based on calibration.
- The tool must warn users to print at `100%` or `Actual size`.

### Page count robustness
- Direct print must not produce two pages.
- Downloaded output must not produce two pages.
- The app must actively enforce single-page PDF output.
- A rebuild should treat two-page output as a regression even if the source document itself is larger or oddly scanned.

## Visual/UI Requirements
### Layout
The app should have a simple two-column workflow:
- Left panel: import, calibration controls, output actions, details.
- Right panel: preview canvas.

### Required controls
- File upload
- Re-run detection button
- Manual calibration button
- Ruler length input in cm
- Download PDF button
- Direct print button
- Batch-processing input/button

### Required details area
Show at least:
- Detection method
- Correction angle
- Pixel distance for the calibration span
- Calculated resolution in px/mm
- Estimated physical size at 1:1
- OCR Normal
- OCR Mirrored

### Preview semantics
- Show the detected/active ruler line on the preview.
- Use a clear visual difference for confident vs uncertain detection.

## Batch Mode Requirements
- The app should support selecting multiple files.
- It should process each file and generate downloadable PDFs.
- It should show a per-file success/error log.
- Batch mode should reuse the same calibration/output pipeline as single-file mode.

## Error Handling Requirements
The app must handle at least these cases gracefully:
- Unsupported file type
- No usable ruler found
- Calibration line too short
- OCR unavailable or failed
- PDF generation failure
- Print preparation failure

The UI must provide human-readable status text for these conditions.

## Local/Offline Use Requirements
### Fresh Windows laptop requirement
A non-technical user on a fresh Windows laptop should be able to run the offline version without assuming Python is installed.

### Offline package contents
The offline package should include:
- Static app files
- Windows launcher scripts
- Clear README/instructions
- Bundled vendor assets where needed for offline/static use

### Launch behavior
- The Windows experience should support double-click startup.
- If a lightweight local server is needed due to browser restrictions, the package should provide that transparently.
- The offline package should not depend on the cockpit workspace.
- The offline package should be shareable as a practical handoff artifact, not only as a developer checkout.

## Public Hosting Requirements
- The public version must be deployable to GitHub Pages.
- It must behave the same as the offline package.
- Public hosting should remain static-only.

## Performance Expectations
- The app may take noticeable time for OCR and PDF processing, but it must surface busy/progress state.
- UI must remain understandable while processing is in progress.

## Implementation Notes to Preserve
These are behavior expectations, not strict implementation details, but they matter for compatibility with the intended product:
- Use only page 1 of uploaded PDFs.
- Generate only page 1 in the output PDF.
- Prefer central crop-to-fit within the 10 mm margin box.
- The ruler should be normalized to the top edge when possible.
- OCR-based mirroring should be conservative and transparent.
- Manual correction must always remain available when automation is uncertain.

## Suggested Acceptance Tests
### Functional acceptance
1. Upload PDF with visible ruler.
2. Auto-detection runs immediately.
3. Preview shows ruler line.
4. User can drag endpoints and line.
5. User can switch to manual calibration and click 0 and end point.
6. User can change ruler length from 12 cm to another value and scaling updates accordingly.
7. Downloaded PDF is exactly one page.
8. Direct print path also uses one-page output.
9. Printed result is true size when printer is set to `100%`.

### OCR transparency acceptance
1. The UI shows `OCR (Normal)` and `OCR (Gespiegelt)`.
2. These fields populate without requiring a download click.
3. They should reflect real OCR differences between orientations.
4. They should not be forced to identical values by a display fallback.
5. `OCR (Final-Ausgabe)` should not be required in the UI.

### Sample-file regression checks
Using these reference inputs from the current project:
- `20260408094907_001.pdf`
- `20260408100048_001.pdf`

Expected behavior:
- The app should produce non-empty OCR diagnostics for both files.
- At least one of the two files should show a meaningful difference between normal and mirrored OCR outputs.
- The app should still produce a valid one-page A4 output for both files.

## Automated Detection Test Suite

All 19 test stencils in `01_Schablonen_Vorlagen_für_Tests/` must be tested with the CLI test runner (`scratch/run_direct_tests.js`) which exercises the detection algorithm directly in Node.js without a browser.

### Running the tests

```bash
node scratch/run_direct_tests.js
```

The test runner:
- Extracts the pure detection functions (`deskew`, `findRuler`, `findTickCloud`, etc.) from `index.html`
- Loads OpenCV.js in Node.js
- Converts PDFs to images via `pdftoppm` (216 dpi)
- Reads images via Python Pillow subprocess
- Runs the full detection pipeline on each file
- Outputs a results table and preview PNGs to `test_outputs/`

### Test file expectations

Each test stencil has a known ruler length and expected detection outcome:

| # | File | Ruler | Expected Status | Notes |
|---|------|-------|-----------------|-------|
| 1 | `20260408094907_001.pdf` | 12 cm | OK or FALLBACK | Coloplast-style scan |
| 2 | `20260408100048_001.pdf` | 12 cm | OK or FALLBACK | Coloplast-style scan |
| 3 | `2026_06_04_Spontantest_mit_Foto.jpg` | **10 cm** | OK | Photo of Publicare stencil; must auto-detect 10 cm |
| 4 | `IMG_0674.jpg` | 12 cm | OK or FALLBACK | Photo of stencil |
| 5 | `IMG_0675.jpg` | 12 cm | OK | Photo of stencil |
| 6 | `Scan_20260311_184757.pdf` | 12 cm | OK or FALLBACK | Scanned stencil |
| 7 | `Stoma-Schablone 1 Publicare 0-10.pdf` | **10 cm** | OK | Publicare 0-10 digital PDF |
| 8 | `Stoma-Schablone 1 Publicare 0-10_a4_1zu1.pdf` | **10 cm** | OK | Publicare 0-10 at A4 1:1 |
| 9 | `Stoma-Schablone 10 Coloplast 0-12.pdf` | 12 cm | OK | Coloplast 0-12 |
| 10 | `Stoma-Schablone 2 Publicare 0-10.jpg` | **10 cm** | OK | Publicare 0-10 image |
| 11 | `Stoma-Schablone 2 Publicare 0-10.pdf` | **10 cm** | OK | Publicare 0-10 PDF |
| 12 | `Stoma-Schablone 3 Publicare 0-10.jpg` | **10 cm** | OK | Publicare 0-10 image |
| 13 | `Stoma-Schablone 3 Publicare 0-10.pdf` | **10 cm** | OK | Publicare 0-10 PDF |
| 14 | `Stoma-Schablone 4 Publicare 0-10.pdf` | **10 cm** | OK | Publicare 0-10 PDF |
| 15 | `Stoma-Schablone 5 Publicare 0-10.pdf` | **10 cm** | OK | Publicare 0-10 PDF |
| 16 | `Stoma-Schablone 6 Publicare 0-10.pdf` | **10 cm** | OK | Publicare 0-10 PDF |
| 17 | `Stoma-Schablone 7 Coloplast 0-12.pdf` | 12 cm | OK | Coloplast 0-12 |
| 18 | `Stoma-Schablone 8 Coloplast 0-12.pdf` | 12 cm | OK | Coloplast 0-12 |
| 19 | `Stoma-Schablone 9 Coloplast 0-12.pdf` | 12 cm | OK | Coloplast 0-12 |

### Pass/fail criteria

1. **Ruler length detection**: The `detectedLengthMm` must match the expected ruler length (100 or 120). This is the primary regression test for 10 cm vs 12 cm auto-recognition.
2. **Detection status**: Files marked "OK" in the table above must achieve `reliable = true` (i.e., the algorithm must not fall back to a generic line or return null).
3. **No errors**: All 19 files must process without errors (no crashes, no uncaught exceptions).
4. **Preview output**: Each file must produce a `_preview.png` in `test_outputs/` showing the detected calibration line with crosshair endpoints.
5. **Calibration line position**: The preview must show the calibration line on or very near the ruler (visual inspection). Lines that are clearly off-target (e.g., on the stencil circles instead of the ruler) are failures.

### Acceptable fallback cases

Some files may legitimately fall back to uncertain detection (e.g., heavily distorted scans, photos with poor lighting). These are acceptable as long as:
- The fallback line is placed in a reasonable position (not wildly off)
- The status shows as `FALLBACK` (not `ERROR`)
- The user can manually correct the line in the browser UI

### Current known limitations
- Photos (`IMG_*.jpg`, `Spontantest_mit_Foto.jpg`) may have lower detection reliability due to perspective distortion, shadows, and background noise.
- The `Scan_20260311_184757.pdf` is a challenging scan that may require manual adjustment.

## Rebuild Guidance
If a new engineer rebuilds this product from scratch, they should distinguish between three categories of requirements:
- Non-negotiable user-visible behavior: one-page output, 10 mm margins, ruler-on-top normalization, mirrored correction, Windows-friendly offline use, ruler-length input, OCR normal vs mirrored transparency.
- Current implementation choices that can be replaced: the exact libraries, scoring heuristics, or internal function structure.
- Exploratory enhancements: automatic ruler-length recognition from ruler numbers and tick counts.

Where the conversation changed direction over time, the latest explicit user correction should win over an earlier workaround.

## Nice-to-Have Extensions
These are useful but secondary to the core workflow:
- Confidence badge for OCR/mirror decision.
- Automatic ruler-length suggestion based on OCR and tick counting.
- Better explanation when ruler-length inference is low confidence.
- Stronger validation for unusually short/long ruler inputs.

## Non-Goals
- No requirement for backend storage.
- No requirement for user accounts.
- No requirement for preserving multi-page source PDFs.
- No requirement for editable project/session history.

## Build Priority Order
If rebuilding from scratch, prioritize in this order:
1. Single-file import and first-page PDF rendering
2. Reliable ruler calibration and manual correction
3. True-size A4 one-page output
4. Direct print via generated PDF
5. Orientation normalization and mirror correction
6. OCR diagnostics for normal vs mirrored
7. Ruler-length input and optional auto-length suggestion
8. Batch mode
9. Offline packaging and public static deployment
