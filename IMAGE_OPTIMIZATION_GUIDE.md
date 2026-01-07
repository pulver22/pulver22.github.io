# Image Optimization Guide

This guide provides recommendations for optimizing images on the website to improve performance and reduce bandwidth usage.

## Current Status

- **Total image size:** ~134MB
- **Number of images:** 676
- **Largest images:** Some project images are 2-4MB

## Recommended Optimizations

### 1. Compress Existing Images

#### Online Tools (Free & Easy)
- **TinyPNG** (https://tinypng.com/) - Great for PNG and JPEG compression
- **Squoosh** (https://squoosh.app/) - Google's image optimization tool with before/after comparison
- **ImageOptim** (https://imageoptim.com/) - Mac app for drag-and-drop optimization

#### Command Line Tools
```bash
# Install ImageMagick
# On Ubuntu/Debian: sudo apt-get install imagemagick
# On macOS: brew install imagemagick

# Optimize JPEG images (adjust quality as needed, 85 is a good balance)
for file in images/**/*.jpg; do
  convert "$file" -quality 85 -strip "$file"
done

# Optimize PNG images
for file in images/**/*.png; do
  convert "$file" -strip "$file"
done
```

### 2. Convert to Modern Formats (WebP)

WebP provides 25-35% better compression than JPEG while maintaining quality.

#### Using ImageMagick
```bash
# Convert JPEG/PNG to WebP
for file in images/**/*.{jpg,png}; do
  cwebp -q 85 "$file" -o "${file%.*}.webp"
done
```

#### HTML Implementation with Fallback
```html
<picture>
  <source srcset="images/photo.webp" type="image/webp">
  <img src="images/photo.jpg" alt="Description" loading="lazy">
</picture>
```

### 3. Implement Responsive Images

Use `srcset` to serve appropriately sized images based on screen size:

```html
<img 
  src="images/photo-800w.jpg" 
  srcset="images/photo-400w.jpg 400w,
          images/photo-800w.jpg 800w,
          images/photo-1200w.jpg 1200w"
  sizes="(max-width: 600px) 400px,
         (max-width: 1200px) 800px,
         1200px"
  alt="Description"
  loading="lazy">
```

### 4. Automated Optimization with GitHub Actions

Create `.github/workflows/optimize-images.yml`:

```yaml
name: Optimize Images

on:
  push:
    paths:
      - 'images/**'
      - 'assets/img/**'

jobs:
  optimize:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Optimize images
        uses: calibreapp/image-actions@main
        with:
          githubToken: ${{ secrets.GITHUB_TOKEN }}
          jpegQuality: '85'
          pngQuality: '85'
          webpQuality: '85'
          ignorePaths: 'node_modules/**,dist/**'
```

### 5. Specific Recommendations

#### High Priority (Largest Impact)
1. **assets/img/RP_portrait.jpg** (1.3MB)
   - Reduce to ~200-300KB (it's displayed at max 300x300px)
   - Consider creating multiple sizes for responsive display

2. **Project Images** (images/projects/*.png)
   - Most are 600KB - 4MB
   - Convert to WebP with JPEG fallback
   - Compress to 50-70% of current size
   - Target: Keep under 500KB per image

3. **Gallery Images** (images/**/*)
   - Create thumbnails for gallery views
   - Lazy load full-size images
   - Consider progressive JPEG format

#### Medium Priority
4. **Logo and Icons**
   - Convert to SVG if possible for crisp display at any size
   - If raster required, use PNG with transparency

### 6. Expected Results

| Optimization | Expected Savings | Impact |
|--------------|------------------|---------|
| JPEG compression (85% quality) | 30-40% | High - Minimal visual quality loss |
| PNG optimization | 20-30% | Medium - Lossless compression |
| WebP conversion | 25-35% | High - Better compression, wide browser support |
| Responsive images | 40-60% on mobile | High - Serve appropriate sizes |
| Lazy loading (already implemented) | Initial load: 50-70% | High - Faster initial page load |

**Total expected reduction:** 60-80MB (45-60% reduction in total image size)

### 7. Testing After Optimization

1. **Visual Quality Check**
   - Compare before/after images
   - Check on multiple devices
   - Ensure no noticeable quality loss

2. **Performance Testing**
   - Use Google PageSpeed Insights
   - Use WebPageTest.org
   - Check Lighthouse scores in Chrome DevTools

3. **Browser Compatibility**
   - Test WebP support across browsers
   - Verify fallbacks work correctly
   - Check mobile display

### 8. Batch Processing Script

Save this as `optimize-images.sh`:

```bash
#!/bin/bash

# Optimize all JPEG images
echo "Optimizing JPEG images..."
find images -type f \( -iname "*.jpg" -o -iname "*.jpeg" \) | while read file; do
    echo "Processing: $file"
    convert "$file" -sampling-factor 4:2:0 -strip -quality 85 -interlace JPEG "$file"
done

# Optimize all PNG images
echo "Optimizing PNG images..."
find images -type f -iname "*.png" | while read file; do
    echo "Processing: $file"
    convert "$file" -strip "$file"
done

echo "Optimization complete!"
```

Make it executable:
```bash
chmod +x optimize-images.sh
./optimize-images.sh
```

### 9. Quick Wins

If you only have time for minimal changes:

1. **Compress RP_portrait.jpg** - Save ~1MB instantly
2. **Compress top 10 largest images** - Save ~15-20MB
3. **Add GitHub Actions workflow** - Automatic optimization going forward

### 10. Maintenance

- Add image optimization to your workflow before committing new images
- Set up automated checks in GitHub Actions
- Periodically audit image sizes
- Consider using a CDN with automatic image optimization (Cloudflare, Cloudinary, etc.)

## Need Help?

- Review the SECURITY_PERFORMANCE_AUDIT.md for overall website improvements
- Check browser DevTools Network tab to identify largest resources
- Use Lighthouse for comprehensive performance recommendations
