/**
 * THE CHESS ENGINE, in Settings: what it weighs on this machine, and how to take it back.
 *
 * The engine is fetched from the conversation that wanted a game (§ Playing STOCKFISH) — that is
 * where the press belongs, because it is where the reader is when they want one. This pane exists
 * for the other half, which nothing else can offer honestly: 7.3 MB is sitting on the machine and
 * the only place a reader can find that out is a list of what this app keeps. It is the split
 * § Renamed people already makes — the act belongs where it is done, the INVENTORY belongs here,
 * because a thing you can only find by remembering where you left it is a thing you cannot remove.
 */

import { HugeiconsIcon } from "@hugeicons/react";
import { CpuIcon, Loading02Icon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { chessEngineRowLabel, megabytes } from "~/lib/chess-engine";
import { useAppState, useController } from "./controller-context";
import { Button } from "./ui/button";

export function ChessEngineSettings() {
  const controller = useController();
  const engine = useAppState((s) => s.chessEngine);
  const [busy, setBusy] = useState(false);

  return (
    <section className="flex flex-col gap-4" data-testid="chess-engine-settings">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary shadow-chip">
          <HugeiconsIcon icon={CpuIcon} className="size-5" strokeWidth={1.5} />
        </div>
        <div className="flex flex-col">
          <h3 className="text-[15px] font-medium text-foreground">Chess engine</h3>
          <p className="text-[13px] text-text-faint">
            {engine.label} plays the computer&apos;s side of a game (see a conversation&apos;s own
            menu). It is not part of this app: it is fetched once, verified against a checksum this
            build pins, kept in this machine&apos;s cache, and it runs in your browser — so nothing
            about your games is sent anywhere. Removing it costs one press to fetch again.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-border-subtle bg-panel px-3 py-2.5">
        <div className="flex min-w-0 flex-col">
          <span data-testid="chess-engine-state" className="text-[13px] text-foreground">
            {chessEngineRowLabel(engine)}
          </span>
          <span className="text-[12px] text-text-faint">
            {engine.present
              ? `${megabytes(engine.bytes)} in this machine's cache${engine.version ? ` · ${engine.version}` : ""}`
              : "Nothing is stored on this machine yet."}
          </span>
        </div>
        {engine.present && (
          <Button
            data-testid="chess-engine-remove"
            variant="outline"
            size="sm"
            className="ml-auto shrink-0"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await controller.forgetChessEngine();
              setBusy(false);
            }}
          >
            {busy ? (
              <HugeiconsIcon icon={Loading02Icon} className="size-4 animate-spin" strokeWidth={1.8} />
            ) : (
              "Remove"
            )}
          </Button>
        )}
      </div>

      {engine.error && (
        <p data-testid="chess-engine-settings-error" className="text-[12px] text-destructive">
          {engine.error}
        </p>
      )}

      <ChessSoundsRow />
    </section>
  );
}

/**
 * The board's own SOUNDS, in the same inventory and for the same reason.
 *
 * They are 64 KB rather than 7.3 MB, so there is no press that FETCHES them — a board asks for them
 * itself the first time one is opened with the app's sounds on (§ Chess in a conversation). What
 * belongs here is the other half: that they are on the machine at all, whose they are, and one press
 * to take them back. It is a row rather than a section of its own because a reader looking for what
 * a chess board keeps on this machine is looking in one place.
 */
function ChessSoundsRow() {
  const controller = useController();
  const sounds = useAppState((s) => s.chessSounds);
  const [busy, setBusy] = useState(false);

  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-border-subtle bg-panel px-3 py-2.5"
      data-testid="chess-sounds-settings"
    >
      <div className="flex min-w-0 flex-col">
        <span data-testid="chess-sounds-state" className="text-[13px] text-foreground">
          {sounds.present ? "Board sounds are on this machine" : "Board sounds are not stored yet"}
        </span>
        <span className="text-[12px] text-text-faint">
          {sounds.present
            ? `${kilobytes(sounds.bytes)} in this machine's cache · ${sounds.label}`
            : `Until they are, a board uses this app's own synthesized sounds. ${sounds.label} are fetched the first time you open a board.`}
        </span>
      </div>
      {sounds.present && (
        <Button
          data-testid="chess-sounds-remove"
          variant="outline"
          size="sm"
          className="ml-auto shrink-0"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await controller.forgetChessSounds();
            setBusy(false);
          }}
        >
          {busy ? (
            <HugeiconsIcon icon={Loading02Icon} className="size-4 animate-spin" strokeWidth={1.8} />
          ) : (
            "Remove"
          )}
        </Button>
      )}
    </div>
  );
}

/** A size a reader can read, for the one thing in this app measured in kilobytes rather than
 *  megabytes — `megabytes` would draw all twelve recordings as "0.1 MB". */
function kilobytes(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  return `${Math.round(bytes / 1000)} KB`;
}
