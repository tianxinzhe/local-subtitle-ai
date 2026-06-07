const sharp = require('sharp');
const path = require('path');

const sizes = [16, 48, 128];
const outDir = path.resolve(__dirname, '..', 'icons');

const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#4a7dff"/>
      <stop offset="100%" style="stop-color:#a855f7"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="24" fill="url(#bg)"/>
  <!-- Subtitles icon: two rounded rectangles with lines -->
  <rect x="20" y="36" width="88" height="56" rx="8" fill="rgba(255,255,255,0.2)" stroke="white" stroke-width="2"/>
  <line x1="36" y1="52" x2="92" y2="52" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="36" y1="64" x2="76" y2="64" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="36" y1="76" x2="60" y2="76" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
  <!-- Play triangle -->
  <polygon points="78,58 78,76 92,67" fill="white" opacity="0.6"/>
</svg>`;

async function main() {
  const svgBuffer = Buffer.from(svgContent);
  for (const size of sizes) {
    const filePath = path.join(outDir, `icon${size}.png`);
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(filePath);
    console.log(`Created ${filePath} (${size}x${size})`);
  }
}

main().catch(console.error);
