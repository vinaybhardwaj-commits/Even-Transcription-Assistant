"use client";

interface Point { x: number; y: number | null; label: string }

/**
 * Minimal inline SVG line chart for monthly metric trends.
 * 220x60 viewBox, auto-scales to min/max of non-null values.
 * Skips null values (gap in line) so missing months don't pin to 0.
 */
export function MiniLineChart({
  points,
  color = "#0f766e",
  height = 64,
}: {
  points: Point[];
  color?: string;
  height?: number;
}) {
  const W = 220;
  const H = height;
  const PAD_X = 6;
  const PAD_Y = 8;
  if (points.length === 0) {
    return <div className="text-xs text-stone-400 italic">no data</div>;
  }
  const validVals = points.map((p) => p.y).filter((v): v is number => v !== null);
  const yMin = Math.min(...validVals, 0);
  const yMax = Math.max(...validVals, 1);
  const yRange = yMax - yMin || 1;
  const xStep = (W - PAD_X * 2) / Math.max(1, points.length - 1);
  function project(p: Point, i: number) {
    const x = PAD_X + i * xStep;
    if (p.y === null) return null;
    const y = H - PAD_Y - ((p.y - yMin) / yRange) * (H - PAD_Y * 2);
    return { x, y };
  }
  const path: string[] = [];
  let pen = false;
  points.forEach((p, i) => {
    const proj = project(p, i);
    if (!proj) { pen = false; return; }
    path.push(pen ? `L ${proj.x.toFixed(1)} ${proj.y.toFixed(1)}` : `M ${proj.x.toFixed(1)} ${proj.y.toFixed(1)}`);
    pen = true;
  });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: "block" }}>
      <line x1={PAD_X} y1={H - PAD_Y} x2={W - PAD_X} y2={H - PAD_Y} stroke="#e7e5e4" strokeWidth={1} />
      <path d={path.join(" ")} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => {
        const proj = project(p, i);
        if (!proj) return null;
        return <circle key={i} cx={proj.x} cy={proj.y} r={2} fill={color} />;
      })}
    </svg>
  );
}
