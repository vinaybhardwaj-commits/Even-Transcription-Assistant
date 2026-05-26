import * as React from "react";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  error?: string;
  helper?: string;
};

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, helper, className = "", id, ...rest }, ref) => {
    const inputId = id ?? `in-${React.useId()}`;
    const hasError = !!error;
    return (
      <div className={className}>
        {label && (
          <label htmlFor={inputId} className="block text-label text-even-navy-800 mb-1">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={`block w-full px-3 py-2 rounded-md border text-body min-h-[44px] focus:outline-none focus:ring-2 focus:ring-even-blue-300 disabled:bg-even-ink-50 disabled:text-even-ink-400 ${
            hasError
              ? "border-danger-500 text-danger-700 focus:ring-danger-500"
              : "border-even-ink-200 text-even-ink-800 focus:border-even-blue-600"
          }`}
          aria-invalid={hasError}
          aria-describedby={hasError ? `${inputId}-error` : helper ? `${inputId}-helper` : undefined}
          {...rest}
        />
        {hasError && (
          <p id={`${inputId}-error`} className="mt-1 text-caption text-danger-700">
            {error}
          </p>
        )}
        {!hasError && helper && (
          <p id={`${inputId}-helper`} className="mt-1 text-caption text-even-ink-500">
            {helper}
          </p>
        )}
      </div>
    );
  }
);
Input.displayName = "Input";
