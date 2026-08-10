import { useCallback, useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Delete02Icon,
  Download01Icon,
  PlusSignIcon,
  Search01Icon,
  StickerIcon,
} from "@hugeicons/core-free-icons";
import type { CustomEmoji } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { AddEmojiDialog } from "./add-emoji-dialog";
import { useAppState, useController } from "./controller-context";
import { PackEmoji } from "./custom-emoji";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/**
 * The custom emoji pack, and the one place to remove an emoji or an alias.
 *
 * ADDING one is a dialog, reached from the emoji picker and from the button here
 * ({@link AddEmojiDialog}) — the picker being right because it is the surface that already
 * offers the user their emoji. But emoji have to be FOUND again months later, and the name
 * is exactly what makes one hard to find — the user would be searching for a `:name:` Teams
 * never had. So the LIST belongs in Settings, where a decision made months ago can still be
 * undone without hunting through conversations for an emoji nobody remembers typing.
 *
 * The art travels inside the message, so everybody in the thread sees it whatever client
 * they use — but the pack itself never leaves this machine, and that is load-bearing.
 */
export function CustomEmojiSettings() {
  const controller = useController();
  const [emoji, setEmoji] = useState<CustomEmoji[] | null>(null);
  const [search, setSearch] = useState("");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showAddAlias, setShowAddAlias] = useState(false);
  const [aliasTarget, setAliasTarget] = useState("");
  const [aliasName, setAliasName] = useState("");
  // Which row is armed. Delete asks twice — the trash arms, the named button calls — the
  // way a message's own Delete does (message-bubble.tsx) and for the same reason: an
  // emoji is used in messages that are already sent, and nothing here brings it back.
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  // Whether a colleague's emoji joins this pack as their message arrives. It lives here
  // rather than in a section of its own because it is a fact about THIS list: what the
  // switch decides is what the rows below fill up with.
  const autoImport = useAppState((s) => s.settings.emoji_auto_import);
  const [autoImportBusy, setAutoImportBusy] = useState(false);
  const [autoImportError, setAutoImportError] = useState<string | null>(null);

  const toggleAutoImport = async () => {
    setAutoImportBusy(true);
    setAutoImportError(null);
    try {
      await controller.saveSettings({ emojiAutoImport: !autoImport });
    } catch (e) {
      setAutoImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setAutoImportBusy(false);
    }
  };

  const reload = useCallback(() => {
    controller
      .loadCustomEmoji()
      .then(setEmoji)
      .catch(() => setEmoji([]));
  }, [controller]);

  // Re-read on every change, whoever made it — this pane and the add-emoji dialog edit
  // the same pack, and so does a second open page and the other backend sharing the store.
  useEffect(() => {
    reload();
    return controller.onCustomEmojiChange(reload);
  }, [controller, reload]);

  const filtered =
    emoji === null
      ? null
      : search.trim() === ""
        ? emoji
        : emoji.filter((e) =>
            e.name.toLowerCase().includes(search.toLowerCase().trim()),
          );

  const handleDelete = async (name: string) => {
    try {
      await controller.removeCustomEmoji(name);
      setConfirmingDelete(null);
    } catch {
      // The backend already reported the failure; nothing more to show.
    }
  };

  const handleExport = async () => {
    try {
      const pack = await controller.exportCustomEmoji();
      const json = JSON.stringify(pack, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `custom-emoji-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // Export failures are silent; the user's retry is their only path forward.
    }
  };

  const handleAddAlias = async () => {
    if (!aliasName.trim() || !aliasTarget.trim()) return;
    try {
      await controller.addCustomEmoji({
        name: aliasName.trim(),
        alias_of: aliasTarget.trim(),
        source: "alias",
      });
      setShowAddAlias(false);
      setAliasName("");
      setAliasTarget("");
    } catch {
      // The backend reports the refusal; nothing more to show.
    }
  };

  const emojiForPicker = emoji?.filter((e) => !e.alias_of) ?? [];

  return (
    <section className="flex flex-col gap-4" data-testid="custom-emoji-settings">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary shadow-chip">
          <HugeiconsIcon icon={StickerIcon} className="size-5" strokeWidth={1.5} />
        </div>
        <div className="flex flex-col">
          <h3 className="text-[15px] font-medium text-foreground">Custom emoji</h3>
          <p className="text-[13px] text-text-faint">
            The art travels inside the message, so everybody in the thread sees it
            whatever client they use. The pack itself never leaves this machine.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4 shadow-chip">
        <div className="flex min-w-0 flex-col">
          <span className="text-[13px] font-medium text-foreground">
            Keep the emoji people send you
          </span>
          <span className="text-[11px] text-text-faint">
            {autoImport
              ? "On — a colleague's emoji joins this pack under the name they gave it, so you can type it too. One you already have is never replaced: theirs arrives as :name-2:."
              : "Off — a colleague's emoji is drawn in their message only. Take one with “Add to my emoji” in the message's own menu."}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={autoImport}
          aria-label="Keep the emoji people send you"
          data-testid="emoji-auto-import-toggle"
          disabled={autoImportBusy}
          onClick={() => void toggleAutoImport()}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            autoImportBusy && "opacity-60",
            autoImport ? "bg-primary" : "bg-element",
          )}
        >
          <span
            className={cn(
              "inline-block size-5 transform rounded-full bg-white shadow-sm transition-transform",
              autoImport ? "translate-x-[22px]" : "translate-x-0.5",
            )}
          />
        </button>
      </div>

      {autoImportError && (
        <span data-testid="emoji-auto-import-error" className="text-xs text-destructive">
          {autoImportError}
        </span>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowAddDialog(true)}
          data-testid="add-custom-emoji"
        >
          <HugeiconsIcon icon={PlusSignIcon} className="size-4" strokeWidth={1.8} />
          Add Custom Emoji
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowAddAlias((prev) => !prev)}
          data-testid="add-alias-open"
        >
          <HugeiconsIcon icon={PlusSignIcon} className="size-4" strokeWidth={1.8} />
          Add Alias
        </Button>
      </div>

      {showAddAlias && (
        <div className="flex flex-col gap-3 rounded-xl bg-card p-4 shadow-chip">
          <h4 className="text-[13px] font-medium text-foreground">Add Alias</h4>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] text-text-dim">Choose Emoji</span>
            <select
              value={aliasTarget}
              onChange={(e) => setAliasTarget(e.target.value)}
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">Select an emoji…</option>
              {emojiForPicker.map((e) => (
                <option key={e.name} value={e.name}>
                  :{e.name}:
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] text-text-dim">Enter an alias</span>
            <Input
              value={aliasName}
              onChange={(e) => setAliasName(e.target.value)}
              placeholder="my-alias"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={handleAddAlias}
              disabled={!aliasName.trim() || !aliasTarget.trim()}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setShowAddAlias(false);
                setAliasName("");
                setAliasTarget("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="relative">
        <HugeiconsIcon
          icon={Search01Icon}
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-faint"
          strokeWidth={1.6}
        />
        <Input
          data-testid="custom-emoji-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search emoji…"
          className="pl-9"
        />
      </div>

      {filtered === null ? (
        <div
          className="flex flex-col gap-2"
          data-testid="custom-emoji-loading"
          aria-hidden
        >
          <span className="h-14 rounded-xl bg-card shadow-chip" />
          <span className="h-14 rounded-xl bg-card/70" />
        </div>
      ) : filtered.length === 0 ? (
        <p
          data-testid="custom-emoji-empty"
          className="rounded-xl bg-card p-4 text-[13px] text-text-faint shadow-chip"
        >
          {search.trim() === ""
            ? "No custom emoji yet. Add one to get started."
            : "No emoji match your search."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {filtered.map((e) => {
            const isConfirming = confirmingDelete === e.name;
            return (
              <li key={e.name} data-testid={`custom-emoji-row-${e.name}`}>
                <div className="flex items-center gap-3 rounded-xl bg-card p-3 shadow-chip">
                  <PackEmoji name={e.name} className="size-6 shrink-0" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13px] font-medium text-foreground">
                      :{e.name}:
                    </span>
                    <span className="truncate text-[11px] text-text-faint">
                      {e.alias_of
                        ? `Alias of :${e.alias_of}:`
                        : new Date(e.added_ms).toLocaleDateString()}
                    </span>
                  </div>
                  {isConfirming ? (
                    <Button
                      size="sm"
                      variant="destructive"
                      data-testid="custom-emoji-confirm-delete"
                      onClick={() => void handleDelete(e.name)}
                    >
                      <HugeiconsIcon
                        icon={Delete02Icon}
                        className="size-4"
                        strokeWidth={1.8}
                      />
                      Delete Emoji
                    </Button>
                  ) : (
                    <button
                      type="button"
                      data-testid={`custom-emoji-delete-${e.name}`}
                      onClick={() => setConfirmingDelete(e.name)}
                      className="grid size-8 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground"
                      aria-label={`Delete :${e.name}:`}
                    >
                      <HugeiconsIcon
                        icon={Delete02Icon}
                        className="size-4"
                        strokeWidth={1.8}
                      />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {emoji && emoji.length > 0 && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => void handleExport()}
          data-testid="custom-emoji-export"
          className="self-start"
        >
          <HugeiconsIcon icon={Download01Icon} className="size-4" strokeWidth={1.8} />
          Export pack
        </Button>
      )}

      <AddEmojiDialog open={showAddDialog} onClose={() => setShowAddDialog(false)} />
    </section>
  );
}
