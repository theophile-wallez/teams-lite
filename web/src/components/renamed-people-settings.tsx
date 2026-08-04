import { useCallback, useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { UserEdit01Icon } from "@hugeicons/core-free-icons";
import type { PersonOverride } from "~/lib/protocol";
import { Avatar } from "./avatar";
import { useController } from "./controller-context";
import { PersonEditDialog } from "./person-edit-dialog";

/**
 * Everybody the user renamed or gave a face to — and the one place to undo it.
 *
 * The rename itself is offered on a person's card, which is right: it is the surface
 * that already answers "who is this?". But a card has to be FOUND, and a nickname is
 * exactly the thing that makes somebody hard to find again — the user would be looking
 * for a name Teams never had. So the list belongs in Settings, where a decision made
 * months ago can still be reversed without hunting through threads for the person.
 *
 * Every row states both names, for the same reason the card and the dialog do: a
 * nickname the user cannot see through is one they cannot undo.
 */
export function RenamedPeopleSettings() {
  const controller = useController();
  const [overrides, setOverrides] = useState<PersonOverride[] | null>(null);
  const [editing, setEditing] = useState<PersonOverride | null>(null);

  const reload = useCallback(() => {
    controller
      .loadPersonOverrides()
      .then(setOverrides)
      .catch(() => setOverrides([]));
  }, [controller]);

  // Re-read on every change, whoever made it — this pane and the person card edit the
  // same list, and so does a second open page.
  useEffect(() => {
    reload();
    return controller.onPersonOverrideChange(reload);
  }, [controller, reload]);

  return (
    <section className="flex flex-col gap-4" data-testid="renamed-people-settings">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary shadow-chip">
          <HugeiconsIcon icon={UserEdit01Icon} className="size-5" strokeWidth={1.5} />
        </div>
        <div className="flex flex-col">
          <h3 className="text-[15px] font-medium text-foreground">Renamed people</h3>
          <p className="text-[13px] text-text-faint">
            The names and pictures you gave people, here only. Microsoft Teams keeps
            their own, and nothing you set is ever sent to them. Rename someone by
            resting the pointer on their name in a chat.
          </p>
        </div>
      </div>

      {overrides === null ? (
        // Two quiet bars while the list loads, so the section never flashes "nobody"
        // at a user who has renamed people.
        <div className="flex flex-col gap-2" data-testid="renamed-people-loading" aria-hidden>
          <span className="h-14 rounded-xl bg-card shadow-chip" />
          <span className="h-14 rounded-xl bg-card/70" />
        </div>
      ) : overrides.length === 0 ? (
        <p
          data-testid="renamed-people-empty"
          className="rounded-xl bg-card p-4 text-[13px] text-text-faint shadow-chip"
        >
          You haven&apos;t renamed anybody yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {overrides.map((person) => (
            <li key={person.mri}>
              <button
                type="button"
                data-testid="renamed-person-row"
                data-person-mri={person.mri}
                onClick={() => setEditing(person)}
                className="flex w-full items-center gap-3 rounded-xl bg-card p-3 text-left shadow-chip transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Avatar
                  seed={person.mri}
                  label={person.display_name || person.teams_name}
                  fallback="person"
                  className="size-9"
                  photo={{ kind: "user", id: person.mri }}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] font-medium text-foreground">
                    {person.display_name || person.teams_name || person.mri}
                  </span>
                  <span className="truncate text-[11px] text-text-faint">
                    {rowSubtitle(person)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <PersonEditDialog
          open
          onOpenChange={(open) => !open && setEditing(null)}
          mri={editing.mri}
          name={editing.display_name || editing.teams_name}
        />
      )}
    </section>
  );
}

/** What was overridden, and who Teams says this is. Both halves are independent, so
 *  the line says which of them the user actually changed. */
function rowSubtitle(person: PersonOverride): string {
  const teams = person.teams_name.trim();
  const renamed = person.display_name.trim().length > 0;
  const known = teams ? `Teams calls them ${teams}` : "Teams has no name for them here";
  if (renamed && person.has_avatar) return `${known} · custom picture`;
  if (renamed) return known;
  return person.has_avatar ? `${known} · custom picture only` : known;
}
