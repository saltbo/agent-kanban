import { agentColor, agentIdenticon } from "../lib/agentIdentity";

interface AgentIdenticonProps {
  publicKey: string;
  size?: number;
  glow?: boolean;
  crystallize?: boolean;
  leader?: boolean;
}

export function AgentIdenticon({ publicKey, size = 40, glow, crystallize, leader }: AgentIdenticonProps) {
  const grid = agentIdenticon(publicKey);
  const color = agentColor(publicKey);
  const cellSize = size / 7;
  const padding = cellSize;
  const gap = cellSize * 0.12;

  let cellIndex = 0;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      {glow && (
        <defs>
          <filter id={`glow-${publicKey.slice(0, 8)}`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
      )}
      {crystallize && (
        <style>{`
          @keyframes cell-in {
            from { opacity: 0; transform: scale(0.3); }
            to { opacity: 0.9; transform: scale(1); }
          }
        `}</style>
      )}
      <rect width={size} height={size} rx={size * 0.18} fill="var(--bg-tertiary)" stroke="var(--border)" strokeWidth="1" />
      <g filter={glow ? `url(#glow-${publicKey.slice(0, 8)})` : undefined}>
        {grid.map((row, y) =>
          row.map((filled, x) => {
            if (!filled) return null;
            const idx = cellIndex++;
            return (
              <rect
                key={`${y}-${x}`}
                x={padding + x * cellSize + gap}
                y={padding + y * cellSize + gap}
                width={cellSize - gap * 2}
                height={cellSize - gap * 2}
                rx={cellSize * 0.2}
                fill={color}
                opacity={crystallize ? 0 : 0.9}
                style={
                  crystallize
                    ? {
                        animation: `cell-in 0.4s ease-out ${idx * 60}ms forwards`,
                        transformOrigin: `${padding + x * cellSize + cellSize / 2}px ${padding + y * cellSize + cellSize / 2}px`,
                      }
                    : undefined
                }
              />
            );
          }),
        )}
      </g>
      {leader &&
        (() => {
          const s = size * 0.28;
          const cx = size - s * 0.35;
          const cy = s * 0.35;
          return (
            <g transform={`translate(${cx - s / 2}, ${cy - s / 2})`}>
              <circle cx={s / 2} cy={s / 2} r={s / 2 + 1} fill="var(--bg-secondary)" />
              <svg x={s * 0.15} y={s * 0.15} width={s * 0.7} height={s * 0.7} viewBox="0 0 24 24" fill="#EAB308" stroke="none">
                <path d="m2 4 3 12h14l3-12-6 5-4-5-4 5-6-5z" />
                <rect x="5" y="18" width="14" height="2" rx="1" />
              </svg>
            </g>
          );
        })()}
    </svg>
  );
}
