import * as React from "react";
import { cn } from "~/lib/utils";

/**
 * A text input styled to the teams-lite design system: a calm card surface with
 * a shadow-as-border and a focus ring, matching the composer/editor fields. Use
 * for settings and forms. Forwards a ref and all native input props.
 */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = "text", ...props }, ref) => {
    return (
      <input
        ref={ref}
        type={type}
        className={cn(
          "h-9 w-full rounded-lg bg-card px-3 py-2 text-sm text-foreground shadow-chip",
          "placeholder:text-text-faint outline-none transition-shadow",
          "focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";
