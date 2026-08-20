import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckIcon } from "@hugeicons/core-free-icons";
import { cn } from "~/lib/utils";

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

/** What a row of a menu measures under a thumb. See {@link DropdownMenuItem}. */
const COARSE_ROW = "[@media(pointer:coarse)]:min-h-11";

/**
 * A menu that opens anchored to its trigger (not a centered modal), portaled to
 * the body so it escapes overflow/stacking contexts. Styling mirrors the app's
 * popover surfaces (bg-popover + shadow-pop) and the floating rich-text menu.
 *
 * `collisionPadding` keeps a wide menu that gets shifted back into view (a
 * trigger near a window edge) from ending up flush against that edge — Radix
 * pads by 0 by default, which reads as the panel being glued to the window.
 */
export const DropdownMenuContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 6, collisionPadding = 12, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        "z-50 min-w-[9rem] overflow-hidden rounded-xl bg-popover p-1 shadow-pop",
        "origin-[var(--radix-dropdown-menu-content-transform-origin)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        "data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1",
        className,
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

export const DropdownMenuItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & { destructive?: boolean }
>(({ className, destructive, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      "flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-foreground outline-none transition-colors",
      // 44px under a thumb, which is the floor this app already holds a dialog's close, a
      // slider's thumb and the schedule menu's own rows to. A row is 32px tall at a pointer,
      // and this app is read from a phone — where "Copy" and "Delete for everyone" sat 32px
      // apart in the same column. It rides the shared primitive for the reason the dialog
      // close does: one rule, and every menu in the app carries it.
      COARSE_ROW,
      "focus:bg-accent focus:text-foreground data-[highlighted]:bg-accent data-[highlighted]:text-foreground",
      "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      destructive &&
        "text-destructive focus:text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive",
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

/**
 * A menu row that toggles rather than acts, with the tick in a fixed gutter so a
 * column of them stays aligned whether or not they are on.
 *
 * Radix closes a menu on select; a checkbox item keeps it open (`onSelect` is
 * defaulted to a no-op preventer), because flipping three display settings in a row is
 * the normal case and reopening the menu between each is not.
 */
export const DropdownMenuCheckboxItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, onSelect, ...props }, ref) => (
  <DropdownMenuPrimitive.CheckboxItem
    ref={ref}
    onSelect={onSelect ?? ((event) => event.preventDefault())}
    className={cn(
      "flex cursor-pointer select-none items-center gap-2.5 rounded-lg py-1.5 pl-2 pr-2.5 text-sm text-foreground outline-none transition-colors",
      COARSE_ROW,
      "focus:bg-accent focus:text-foreground data-[highlighted]:bg-accent data-[highlighted]:text-foreground",
      "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className,
    )}
    {...props}
  >
    <span className="grid size-4 shrink-0 place-items-center text-primary">
      <DropdownMenuPrimitive.ItemIndicator>
        <HugeiconsIcon icon={CheckIcon} className="size-3.5" strokeWidth={2.4} />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = DropdownMenuPrimitive.CheckboxItem.displayName;

/** A small caption above a group of rows. */
export const DropdownMenuLabel = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn(
      "px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-text-faint",
      className,
    )}
    {...props}
  />
));
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

export const DropdownMenuSeparator = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    className={cn("mx-1 my-1 h-px bg-border-subtle", className)}
    {...props}
  />
));
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;
