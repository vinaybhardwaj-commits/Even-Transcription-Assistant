interface SparkLineProps {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
}

/**
 * Tiny inline SVG sparkline. Auto-scales to min/max of the values.
 * Renders nothing if values is empty or has < 2 points.
 */
export function SparkLine({
  values,
  width = 60,
  height = 20,
  color = "#0f766e",
}: SparkLineProps) {
  if (values.length < 2) {
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <line
          x1="0"
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="#d6d3d1"
          strokeDasharray="2,2"
        />
      </svg>
    );
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);

  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * (height - 2) - 1;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <polyline
        points={points}
        stroke={color}
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
