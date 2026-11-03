export async function drawScreenshotAnnotations({ png, annotations }) {
  const image = new Image();
  image.src = `data:image/png;base64,${png}`;
  await image.decode();

  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Chromium could not create a canvas for the screenshot.');
  }
  context.drawImage(image, 0, 0);
  const referenceWidth = 1280;
  const minScaledHeight = 400;
  const scale = Math.max(1, Math.min(canvas.width / referenceWidth, canvas.height / minScaledHeight));
  const drawingWidth = canvas.width / scale;
  const drawingHeight = canvas.height / scale;
  context.scale(scale, scale);
  const point = ([x, y]) => [x * (canvas.width - 1) / scale, y * (canvas.height - 1) / scale];

  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const { arrow } of annotations) {
    if (!arrow) {
      continue;
    }
    const [startX, startY] = point(arrow.from);
    const [tipX, tipY] = point(arrow.to);
    const dx = tipX - startX;
    const dy = tipY - startY;
    const angle = Math.atan2(dy, dx);
    const headLength = Math.min(20, Math.max(8, Math.hypot(dx, dy) / 3));

    context.beginPath();
    context.moveTo(startX, startY);
    context.lineTo(tipX, tipY);
    context.moveTo(tipX - headLength * Math.cos(angle - 0.5), tipY - headLength * Math.sin(angle - 0.5));
    context.lineTo(tipX, tipY);
    context.lineTo(tipX - headLength * Math.cos(angle + 0.5), tipY - headLength * Math.sin(angle + 0.5));
    context.lineWidth = 8;
    context.strokeStyle = '#ffffff';
    context.stroke();
    context.lineWidth = 4;
    context.strokeStyle = '#be123c';
    context.stroke();
  }

  context.font = '600 18px system-ui';
  context.textBaseline = 'middle';
  const margin = 8;
  const paddingX = 12;
  const paddingY = 7;
  const lineHeight = 23;
  const maxTextWidth = Math.min(456, drawingWidth - 2 * (margin + paddingX));
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const measure = (text) => context.measureText(text).width;

  for (const { label } of annotations) {
    if (!label) {
      continue;
    }
    const text = label.text.trim();
    const lines = [];
    let start = 0;
    let space = -1;
    for (const { segment, index } of graphemes.segment(text)) {
      if (measure(text.slice(start, index + segment.length).trim()) > maxTextWidth) {
        const split = space > start ? space : index;
        lines.push(text.slice(start, split).trim());
        start = split;
      }
      if (segment === ' ') {
        space = index;
      }
    }
    lines.push(text.slice(start).trim());

    const textWidth = Math.min(maxTextWidth, Math.max(...lines.map(measure)));
    const width = textWidth + 2 * paddingX;
    const height = lines.length * lineHeight + 2 * paddingY;
    const [anchorX, anchorY] = point(label.at);
    const x = Math.max(margin, Math.min(anchorX - width / 2, drawingWidth - margin - width));
    const y = Math.max(margin, Math.min(anchorY - height / 2, drawingHeight - margin - height));

    context.beginPath();
    context.roundRect(x, y, width, height, 7);
    context.fillStyle = '#191929';
    context.fill();
    context.strokeStyle = '#ffffff';
    context.lineWidth = 2;
    context.stroke();
    context.fillStyle = '#ffffff';
    for (const [index, line] of lines.entries()) {
      context.fillText(line, x + paddingX, y + paddingY + (index + 0.5) * lineHeight, textWidth);
    }
  }
  return canvas.toDataURL('image/png');
}
