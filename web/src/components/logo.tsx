/**
 * Logo：固定 1.75rem 盒子，同一个图形同时写成页面 favicon。
 * 图形语义：两条相对的水流在中间被「转」了一下——无站的中转站。
 */
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="8" fill="#0a0a0a"/>
<path d="M8 20.5 16 11l8 9.5" fill="none" stroke="#fafafa" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M8 25h16" stroke="#fafafa" stroke-width="2.4" stroke-linecap="round"/>
</svg>`;

export const LOGO_DATA_URL = `data:image/svg+xml,${encodeURIComponent(SVG)}`;

export function Logo({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={className ?? 'flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md'}
      dangerouslySetInnerHTML={{ __html: SVG.replace(/width="32" height="32"/, 'width="100%" height="100%"') }}
    />
  );
}
