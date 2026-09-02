export function renderMetricBadge(label: string, value: string): string {
  const safeLabel = escapeXml(label);
  const safeValue = escapeXml(value);
  const labelWidth = Math.max(safeLabel.length * 7 + 16, 32);
  const valueWidth = Math.max(safeValue.length * 6.5 + 16, 64);
  const totalWidth = labelWidth + valueWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20">
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)"><rect width="${labelWidth}" height="20" fill="#18181b"/><rect x="${labelWidth}" width="${valueWidth}" height="20" fill="#0891b2"/><rect width="${totalWidth}" height="20" fill="url(#s)"/></g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${safeLabel}</text><text x="${labelWidth / 2}" y="14">${safeLabel}</text>
    <text x="${labelWidth + valueWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${safeValue}</text><text x="${labelWidth + valueWidth / 2}" y="14">${safeValue}</text>
  </g>
</svg>`;
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeXml(value: string): string {
  return escapeHtml(value).replace(/'/g, "&apos;");
}
