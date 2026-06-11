/**
 * js/gui_pipeline.js
 * Encapsulates the GUI-specific image preparation pipeline.
 */

 (function (env) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const helpers = isNode ? require('./image-utils.js') : env;
  const { cropAndScaleStencilIfPossible, deskew: deskewFn } = helpers;
  // OpenCV.js loaded in Node for headless pipeline
  const cv = isNode ? (env.cv || require('../offline_package/vendor/opencv.js')) : env.cv;

/**
 * Prepares a raw image for detection by cropping, deskewing, and rotating.
 * This represents the current GUI-only pipeline.
 * 
 * @param {HTMLCanvasElement} sourceCanvas - The raw input canvas.
 * @param {Object} sourceMeta - Metadata about the source file.
 * @returns {Promise<Object>} An object containing the prepared Mat, the angle, and the cropped canvas.
 */
async function prepareImageForDetection(sourceCanvas, sourceMeta) {
  let currentCanvas = sourceCanvas;

  // 1. Auto-Crop
  const croppedCanvas = await cropAndScaleStencilIfPossible(currentCanvas);
  if (croppedCanvas !== currentCanvas) {
    currentCanvas = croppedCanvas;
  }

  // 2. Deskew
  const src = cv.imread(currentCanvas);
  const deskewRes = deskewFn(src);
  src.delete();

  const baseMat = deskewRes.mat;

  // 3. Rotation (180 degrees)
  const flippedMat = new cv.Mat();
  cv.rotate(baseMat, flippedMat, cv.ROTATE_180);

  // Return the prepared data
  return {
    baseMat: baseMat,
    flippedMat: flippedMat,
    angle: deskewRes.angle || 0,
    canvas: currentCanvas // Return the cropped canvas for UI updates
  };
}

  if (isNode) {
    module.exports = { prepareImageForDetection };
  }

  if (env) {
    env.prepareImageForDetection = prepareImageForDetection;
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
