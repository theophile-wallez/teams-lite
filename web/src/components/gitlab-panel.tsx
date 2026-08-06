/** One panel of the merge-request page: a heading, an optional control on its right, and its
 *  content.
 *
 *  It lives in a module of its own because two files draw one — `gitlab-pane.tsx` for the
 *  pipeline, the approvals, the actions and the comments, and `gitlab-changes.tsx` for the
 *  diff. Two copies of the same heading would drift apart at the first change to either. */
export function Panel(props: {
  title: string;
  testId: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  "data-live"?: string;
}) {
  return (
    <section
      data-testid={props.testId}
      data-live={props["data-live"]}
      className="flex flex-col gap-2 rounded-2xl bg-card/60 p-3"
    >
      <div className="flex items-center gap-2">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-text-faint">
          {props.title}
        </h3>
        <div className="ml-auto flex items-center gap-2">{props.right}</div>
      </div>
      {props.children}
    </section>
  );
}
