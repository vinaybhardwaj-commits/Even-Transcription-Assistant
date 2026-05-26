import * as React from "react";

type Variant = "primary" | "secondary" | "ghost" | "destructive" | "ai";

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-even-blue-600 hover:bg-even-blue-700 text-white font-medium disabled:bg-even-ink-200 disabled:text-even-ink-500 disabled:cursor-not-allowed",
  secondary:
    "bg-even-white hover:bg-even-ink-50 text-even-navy-800 border border-even-ink-200 hover:border-even-ink-300 font-medium disabled:opacity-50 disabled:cursor-not-allowed",
  ghost:
    "bg-transparent hover:bg-even-blue-50 text-even-blue-600 hover:text-even-blue-700 font-medium disabled:text-even-ink-300 disabled:cursor-not-allowed",
  destructive:
    "bg-danger-500 hover:bg-danger-700 text-white font-medium disabled:bg-even-ink-200 disabled:text-even-ink-500 disabled:cursor-not-allowed",
  ai:
    "bg-ai-100 hover:bg-ai-200 text-ai-700 border border-ai-200 hover:border-ai-700 font-medium disabled:opacity-50 disabled:cursor-not-allowed",
};

const sizeClasses = {
  sm: "px-3 py-1.5 text-caption rounded-md",
  md: "px-4 py-2 text-label rounded-md min-h-[44px]",
  lg: "px-6 py-3 text-label rounded-xl min-h-[48px]",
};

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: keyof typeof sizeClasses;
};

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 transition-colors focus:outline-none focus:ring-2 focus:ring-even-blue-300 ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
