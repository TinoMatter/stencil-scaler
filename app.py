import os
import json
import uuid
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
import io

app = FastAPI(title="Stoma Calibration Training Data Ingestor")

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Ensure local dataset directories exist
DATASET_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dataset")
IMAGES_DIR = os.path.join(DATASET_DIR, "images")
LABELS_DIR = os.path.join(DATASET_DIR, "labels")

os.makedirs(IMAGES_DIR, exist_ok=True)
os.makedirs(LABELS_DIR, exist_ok=True)

@app.post("/api/collect-training-data")
async def collect_training_data(
    file: UploadFile = File(...),
    original_width: int = Form(...),
    original_height: int = Form(...),
    point_0cm: str = Form(...),
    point_12cm: str = Form(...)
):
    # Validate file format
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in (".jpg", ".jpeg", ".png"):
        raise HTTPException(
            status_code=400,
            detail="Unsupported image format. Must be JPG or PNG."
        )

    # Parse keypoints
    try:
        p0 = json.loads(point_0cm)
        p12 = json.loads(point_12cm)
    except json.JSONDecodeError:
        raise HTTPException(
            status_code=400,
            detail="Invalid JSON format for point_0cm or point_12cm."
        )

    if not isinstance(p0, list) or len(p0) != 2 or not isinstance(p12, list) or len(p12) != 2:
        raise HTTPException(
            status_code=400,
            detail="Keypoints must be in [x, y] list format."
        )

    # Process and save image as RGB JPEG
    unique_id = str(uuid.uuid4())
    img_filename = f"{unique_id}.jpg"
    img_path = os.path.join(IMAGES_DIR, img_filename)

    try:
        img_bytes = await file.read()
        image = Image.open(io.BytesIO(img_bytes))
        if image.mode in ("RGBA", "P"):
            image = image.convert("RGB")
        image.save(img_path, "JPEG")
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to process and save image: {str(e)}"
        )

    # YOLOv8-Pose formatting logic
    x0, y0 = p0
    x12, y12 = p12

    x_center = (x0 + x12) / 2
    y_center = (y0 + y12) / 2
    
    diff_x = abs(x0 - x12)
    diff_y = abs(y0 - y12)
    
    width = diff_x + (diff_x * 0.05)
    height = diff_y + 40

    # Normalize values to [0.0, 1.0]
    norm_x_center = x_center / original_width
    norm_y_center = y_center / original_height
    norm_width = width / original_width
    norm_height = height / original_height

    norm_x1 = x0 / original_width
    norm_y1 = y0 / original_height
    norm_x2 = x12 / original_width
    norm_y2 = y12 / original_height

    # Write YOLO label file
    label_filename = f"{unique_id}.txt"
    label_path = os.path.join(LABELS_DIR, label_filename)
    
    label_line = (
        f"0 {norm_x_center:.6f} {norm_y_center:.6f} {norm_width:.6f} {norm_height:.6f} "
        f"{norm_x1:.6f} {norm_y1:.6f} 2 {norm_x2:.6f} {norm_y2:.6f} 2\n"
    )

    try:
        with open(label_path, "w", encoding="utf-8") as f:
            f.write(label_line)
    except Exception as e:
        # Cleanup image on failure
        if os.path.exists(img_path):
            os.remove(img_path)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to save label: {str(e)}"
        )

    # Record mapping of UUID to original filename
    mapping_path = os.path.join(DATASET_DIR, "dataset_mapping.json")
    try:
        mapping = {}
        if os.path.exists(mapping_path):
            try:
                with open(mapping_path, "r", encoding="utf-8") as mf:
                    mapping = json.load(mf)
            except Exception:
                mapping = {}
        mapping[unique_id] = file.filename
        with open(mapping_path, "w", encoding="utf-8") as mf:
            json.dump(mapping, mf, indent=2, ensure_ascii=False)
    except Exception as e:
        if os.path.exists(img_path):
            os.remove(img_path)
        if os.path.exists(label_path):
            os.remove(label_path)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to update dataset mapping: {str(e)}"
        )

    return {
        "status": "success",
        "uuid": unique_id,
        "image_path": img_path,
        "label_path": label_path
    }

@app.post("/api/save-ground-truth")
async def save_ground_truth(
    filename: str = Form(...),
    point_0cm: str = Form(...),
    point_12cm: str = Form(...),
    ruler_length_mm: int = Form(...)
):
    try:
        p0 = json.loads(point_0cm)
        p12 = json.loads(point_12cm)
    except json.JSONDecodeError:
        raise HTTPException(
            status_code=400,
            detail="Invalid JSON format for point_0cm or point_12cm."
        )

    if not isinstance(p0, list) or len(p0) != 2 or not isinstance(p12, list) or len(p12) != 2:
        raise HTTPException(
            status_code=400,
            detail="Keypoints must be in [x, y] list format."
        )

    gt_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ruler_ground_truth.json")
    ground_truth = {}
    if os.path.exists(gt_path):
        try:
            with open(gt_path, "r", encoding="utf-8") as f:
                ground_truth = json.load(f)
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to read ruler_ground_truth.json: {str(e)}"
            )

    ground_truth[filename] = {
        "p0": {"x": round(p0[0], 2), "y": round(p0[1], 2)},
        "p12": {"x": round(p12[0], 2), "y": round(p12[1], 2)},
        "rulerLengthMm": ruler_length_mm
    }

    try:
        with open(gt_path, "w", encoding="utf-8") as f:
            json.dump(ground_truth, f, indent=2, ensure_ascii=False)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to write ruler_ground_truth.json: {str(e)}"
        )

    return {"status": "success", "filename": filename}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="127.0.0.1", port=8080, reload=True)

