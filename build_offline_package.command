#!/bin/zsh
# Change directory to the script folder
cd "$(dirname "$0")"

echo "=== Stoma Scaling Tool: Building Offline Package ==="

# 1. Copy index.html to offline_package/index.html
if [ ! -f "index.html" ]; then
    echo "ERROR: index.html not found at root directory."
    exit 1
fi

cp index.html offline_package/index.html
cp -R js offline_package/
echo "[1/3] Copied root index.html and js/ to offline_package/"

# 2. Perform replacements using python3
python3 -c '
with open("offline_package/index.html", "r", encoding="utf-8") as f:
    content = f.read()

content = content.replace("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js", "./vendor/pdf.min.js")
content = content.replace("https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js", "./vendor/pdf-lib.min.js")
content = content.replace("https://docs.opencv.org/4.x/opencv.js", "./vendor/opencv.js")
content = content.replace("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js", "./vendor/pdf.worker.min.js")

with open("offline_package/index.html", "w", encoding="utf-8") as f:
    f.write(content)
'
echo "[2/3] Mapped CDN URLs to local vendor assets in offline_package/index.html"

# 3. Create zip file of offline_package
echo "Zipping offline package into stoma_offline_package.zip..."
# Remove old zip if it exists
rm -f stoma_offline_package.zip

# Zip offline_package
zip -r stoma_offline_package.zip offline_package -x "*.DS_Store" "*__MACOSX*" "*.git*"

echo "[3/3] Created stoma_offline_package.zip successfully!"
echo "===================================================="
