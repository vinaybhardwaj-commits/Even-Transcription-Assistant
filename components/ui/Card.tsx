import * as React from "react";

type Variant = "default" | "ai" | "clickable";

const base = "rounded-lg p-5 bg-even-white";

const variantClasses: Record<Variant, string> = {
  default: `${base} border border-even-ink-100`,
  ai: `${base.replace("bg-even-white", "bg-ai-50")} border border-ai-200`,
  clickable: `${base} border border-even-ink-100 hover:border-even-ink-200 hover:shadow-card cursor-pointer transition`,
};

export type CardProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: Variant;
};

export function Card({ variant = "default", className = "", children, ...rest }: CardProps) {
  return (
    <div className={`${variantClasses[variant]} ${className}`} {...rest}>
      {children}
    </div>
  );
}
