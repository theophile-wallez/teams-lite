import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ImageUpload01Icon, Undo02Icon } from "@hugeicons/core-free-icons";
import type { PersonOverride } from "~/lib/protocol";
import {
  loadPersonAvatar,
  MAX_PERSON_NAME_LENGTH,
  personAvatarAccept,
  type PersonAvatarPick,
} from "~/lib/person-override";
import { cn } from "~/lib/utils";
import { Avatar } from "./avatar";
import { useController } from "./controller-context";
import { FadeArc } from "./loading-ui/fade-arc";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

/**
 * Rename somebody, and give them a face — for this app only.
 *
 * Microsoft Teams offers neither: a colleague's display name and photo belong to them,
 * and nothing here writes to their account. So both are LOCAL overrides, stored on this
 * machine, and the dialog says so rather than leaving the user to wonder whether they
 * just edited a real person's profile.
 *
 * Two things about the shape are deliberate:
 *
 *  - **The real name stays visible.** Under the field, and again in the person card
 *    behind it, the dialog keeps saying what Teams calls this person. A rename that
 *    erased that would leave the user unable to tell who a message is from, which is
 *    worse than not offering the rename at all.
 *  - **The two halves are independent.** Undoing a rename never drops the picture and
 *    vice-versa, because they are two decisions and the store keeps them apart. Each
 *    has its own Reset, and neither is offered when there is nothing to reset.
 */

/** The picture the dialog is currently showing: the one already stored (undefined —
 *  load it the usual way, through the avatar cache), one the user just picked, or
 *  none because they cleared it. */
type PendingAvatar = { kind: "keep" } | { kind: "pick"; pick: PersonAvatarPick } | { kind: "clear" };

export function PersonEditDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mri: string;
  /** The name currently shown for this person — already the nickname when one is set,
   *  since the backend resolves it on the way out of the store. Seeds the field. */
  name: string;
}) {
  const controller = useController();
  const [override, setOverride] = useState<PersonOverride | null | undefined>(undefined);
  const [draftName, setDraftName] = useState("");
  const [avatar, setAvatar] = useState<PendingAvatar>({ kind: "keep" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const nameField = useRef<HTMLInputElement>(null);

  // Read the current state each time the dialog opens, so a change made in another
  // page (or another backend on this store) is never edited from a stale copy.
  useEffect(() => {
    if (!props.open) return;
    let alive = true;
    setError(null);
    setAvatar({ kind: "keep" });
    setOverride(undefined);
    controller
      .loadPersonOverride(props.mri)
      .then((o) => {
        if (!alive) return;
        setOverride(o);
        setDraftName(o?.display_name || "");
      })
      .catch(() => {
        if (alive) setOverride(null);
      });
    return () => {
      alive = false;
    };
  }, [controller, props.mri, props.open]);

  // What Teams itself calls this person. The floor is the label we were opened with:
  // an override may already be in force, in which case that label IS the nickname, so
  // it is only used when the store could not name them at all.
  const teamsName = override?.teams_name?.trim() || (override?.display_name ? "" : props.name);
  const storedName = override?.display_name?.trim() || "";
  const hasStoredAvatar = !!override?.has_avatar;

  const trimmed = draftName.trim();
  const nameChanged = trimmed !== storedName;
  const avatarChanged = avatar.kind !== "keep";
  const dirty = nameChanged || avatarChanged;

  // What the preview shows. A freshly picked file renders from its own data URL; with
  // nothing picked it goes through the normal avatar path, so it shows the stored
  // override when there is one and the Teams photo when there is not.
  const previewName = trimmed || teamsName || props.name;
  const previewPhoto =
    avatar.kind === "clear" || avatar.kind === "pick"
      ? undefined
      : ({ kind: "user", id: props.mri } as const);

  async function pickFile(file: File | undefined): Promise<void> {
    if (!file) return;
    setError(null);
    try {
      setAvatar({ kind: "pick", pick: await loadPersonAvatar(file) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that image.");
    }
  }

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      // Two calls because they are two decisions, and only the ones that moved. The
      // backend keeps the other half either way, so an unchanged picture is never
      // re-uploaded and an unchanged name is never rewritten.
      if (nameChanged) await controller.setPersonName(props.mri, trimmed);
      if (avatar.kind === "pick") {
        await controller.setPersonAvatar(props.mri, {
          content_type: avatar.pick.content_type,
          data_base64: avatar.pick.data_base64,
        });
      } else if (avatar.kind === "clear") {
        await controller.setPersonAvatar(props.mri, null);
      }
      props.onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        data-testid="person-edit-dialog"
        className="max-w-md"
        // The dialog opens from a hover card, whose own dismissal must not steal the
        // focus the field needs.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          nameField.current?.focus();
          nameField.current?.select();
        }}
      >
        <DialogHeader>
          <DialogTitle>Rename and re-face</DialogTitle>
          <DialogDescription>
            Here only. Microsoft Teams keeps this person&apos;s own name and photo, and
            nothing you set here is sent to them or to your account.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-4">
          <div className="flex flex-col items-center gap-2">
            <Avatar
              key={avatar.kind === "pick" ? avatar.pick.previewUrl : `${props.mri}:${avatar.kind}`}
              seed={props.mri || previewName}
              label={previewName}
              fallback="person"
              className="size-16 text-xl"
              photo={previewPhoto}
              // A freshly picked file has not been stored yet, so it cannot come back
              // through the avatar path — show the data URL the reader already made.
              overrideSrc={avatar.kind === "pick" ? avatar.pick.previewUrl : undefined}
            />
            <input
              ref={fileInput}
              type="file"
              accept={personAvatarAccept()}
              className="hidden"
              data-testid="person-avatar-input"
              onChange={(e) => {
                void pickFile(e.target.files?.[0]);
                // Let the same file be picked again after a clear.
                e.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="person-avatar-pick"
              onClick={() => fileInput.current?.click()}
            >
              <HugeiconsIcon icon={ImageUpload01Icon} strokeWidth={1.8} />
              Picture
            </Button>
            {(hasStoredAvatar || avatar.kind === "pick") && avatar.kind !== "clear" && (
              <button
                type="button"
                data-testid="person-avatar-reset"
                className="text-xs text-text-dim underline-offset-2 hover:underline"
                onClick={() => setAvatar(hasStoredAvatar ? { kind: "clear" } : { kind: "keep" })}
              >
                Use their photo
              </button>
            )}
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <label htmlFor="person-name-field" className="text-xs font-medium text-text-dim">
              Name
            </label>
            <Input
              ref={nameField}
              id="person-name-field"
              type="text"
              data-testid="person-name-field"
              value={draftName}
              maxLength={MAX_PERSON_NAME_LENGTH}
              placeholder={teamsName || "Their name"}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && dirty && !saving) void save();
              }}
            />
            {/* Who this really is. Kept on screen the whole time the rename is being
                made, and again once it is: a nickname the user cannot see through is
                a nickname they cannot undo. */}
            {teamsName ? (
              <p data-testid="person-teams-name" className="text-xs text-text-faint">
                Teams calls them {teamsName}.
              </p>
            ) : (
              <p className="text-xs text-text-faint">
                Teams has no name for them here.
              </p>
            )}
            {storedName && (
              <button
                type="button"
                data-testid="person-name-reset"
                className={cn(
                  "self-start text-xs text-text-dim underline-offset-2 hover:underline",
                  trimmed === "" && "invisible",
                )}
                onClick={() => setDraftName("")}
              >
                <HugeiconsIcon icon={Undo02Icon} className="mr-1 inline size-3" strokeWidth={1.8} />
                Clear the name
              </button>
            )}
          </div>
        </div>

        {error && (
          <p data-testid="person-edit-error" className="text-xs text-destructive">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => props.onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="person-edit-save"
            onClick={() => void save()}
            disabled={!dirty || saving || override === undefined}
          >
            {saving && <FadeArc />}
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
