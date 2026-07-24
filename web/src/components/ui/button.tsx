import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "~/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-chip hover:brightness-110 active:brightness-95",
        secondary: "bg-secondary text-secondary-foreground shadow-chip hover:bg-accent",
        ghost: "text-muted-foreground hover:bg-accent hover:text-foreground",
        outline: "bg-card text-foreground shadow-chip hover:bg-accent hover:text-foreground",
        destructive: "bg-destructive text-destructive-foreground shadow-chip hover:brightness-110",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-[13px]",
        lg: "h-10 rounded-xl px-6",
        pill: "h-10 rounded-full px-6",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** Interaction sound cue, played via cuelume's `data-cuelume-*` delegation
   *  (see lib/sounds.ts `bindCues`). Defaults to a subtle "press" tick on
   *  pointer-down; pass "toggle" for on/off controls, or null to stay silent
   *  (e.g. a button that already plays a semantic cue). The primary variant also
   *  gets a soft hover accent. */
  cue?: "press" | "toggle" | null;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, cue = "press", ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    // Cue attributes are injected before {...props}, so a caller can still
    // override them (or pass their own data-cuelume-*) explicitly.
    const cueProps =
      cue === "toggle"
        ? { "data-cuelume-toggle": "" }
        : cue === "press"
          ? { "data-cuelume-press": "" }
          : undefined;
    const prominent = variant === undefined || variant === "default";
    const hoverProps = cue !== null && prominent ? { "data-cuelume-hover": "" } : undefined;
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...cueProps}
        {...hoverProps}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };
