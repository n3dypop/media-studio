// A mathematical lower bound for one uncompressed RGBA copy of explicitly
// selected input images. This is NOT an estimate of total peak memory, model
// memory, ComfyUI intermediates, PE batches, or a guarantee against OOM.
export function inputRgbaBytesFloor(assets,{maxImages=16,maxPixelsPerImage=12_000_000}={}){
  if(!Array.isArray(assets)||!Number.isSafeInteger(maxImages)||maxImages<1||assets.length>maxImages)throw new TypeError('Invalid input image count');
  let total=0;
  for(const asset of assets){
    if(!asset||asset.purpose!=='input'||![asset.width,asset.height].every(n=>Number.isSafeInteger(n)&&n>=16&&n<=4096)||asset.width*asset.height>maxPixelsPerImage)throw new TypeError('Invalid input image dimensions or purpose');
    total+=asset.width*asset.height*4;
    if(!Number.isSafeInteger(total))throw new RangeError('Input image byte floor is unsafe');
  }
  return total;
}
