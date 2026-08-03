import { cn } from "~/lib/utils";

/**
 * Linear's own logomark, as shipped in their brand assets
 * (`logo-dark.svg` / `logo-light.svg` in Linear-Brand-Assets.zip, linked from
 * linear.app/brand). The path below is that file's path, unaltered.
 *
 * Linear publishes the mark as two files whose geometry is identical and whose
 * only difference is the fill: Nordic Gray `#222326` for a light background, white
 * for a dark one. Both fills live in `.linear-logo` (app.css) and reach the path
 * through `currentColor`, so the theme picks the official version instead of the
 * component shipping the same 1 kB outline twice.
 *
 * Pass `title` where the mark is the only thing naming the tracker — it then reads
 * as an image called "Linear" — and omit it where the word is already on screen, so
 * a screen reader does not say "Linear" twice.
 */
const LOGO_PATH =
  "M1.22541 61.5228c-.2225-.9485.90748-1.5459 1.59638-.857L39.3342 97.1782c.6889.6889.0915 1.8189-.857 1.5964C20.0515 94.4522 5.54779 79.9485 1.22541 61.5228ZM.00189135 46.8891c-.01764375.2833.08887215.5599.28957165.7606L52.3503 99.7085c.2007.2007.4773.3075.7606.2896 2.3692-.1476 4.6938-.46 6.9624-.9259.7645-.157 1.0301-1.0963.4782-1.6481L2.57595 39.4485c-.55186-.5519-1.49117-.2863-1.648174.4782-.465915 2.2686-.77832 4.5932-.92588465 6.9624ZM4.21093 29.7054c-.16649.3738-.08169.8106.20765 1.1l64.77602 64.776c.2894.2894.7262.3742 1.1.2077 1.7861-.7956 3.5171-1.6927 5.1855-2.684.5521-.328.6373-1.0867.1832-1.5407L8.43566 24.3367c-.45409-.4541-1.21271-.3689-1.54074.1832-.99132 1.6684-1.88843 3.3994-2.68399 5.1855ZM12.6587 18.074c-.3701-.3701-.393-.9637-.0443-1.3541C21.7795 6.45931 35.1114 0 49.9519 0 77.5927 0 100 22.4073 100 50.0481c0 14.8405-6.4593 28.1724-16.7199 37.3375-.3903.3487-.984.3258-1.3542-.0443L12.6587 18.074Z";

export function LinearLogo(props: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="linear-logo"
      className={cn("linear-logo", props.className)}
      role={props.title ? "img" : undefined}
      aria-label={props.title}
      aria-hidden={props.title ? undefined : true}
    >
      {props.title && <title>{props.title}</title>}
      <path d={LOGO_PATH} />
    </svg>
  );
}
