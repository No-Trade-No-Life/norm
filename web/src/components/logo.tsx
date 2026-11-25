/**
 * Logo 就是 NormAI 的那个环——**逐字节相同，不要「改进」它**。
 *
 * Norm 是 NormAI Next，同一条产品线的下一站，所以品牌标记必须与 NormAI 完全一致：
 * 页面上的环与 `web/public/normai.svg`（favicon）画的是同一个图形（circle r=19.5，
 * stroke-width 9），而那个 svg 文件与 NormAI 仓库里的同名文件一模一样，
 * 连「浅色描黑、深色描白」的 `prefers-color-scheme` 分支都是同一份。
 *
 * 页面里用 `currentColor`，于是环跟着主题走；favicon 那份自己带 media query，
 * 因为标签页里没有 CSS 上下文。改这里之前先问一句：NormAI 也跟着改了吗？
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className ?? 'size-7 shrink-0'} viewBox="0 0 64 64">
      <circle cx="32" cy="32" r="19.5" fill="none" stroke="currentColor" strokeWidth="9" />
    </svg>
  );
}
