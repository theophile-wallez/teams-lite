import { useEffect, useState } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  BellIcon,
  CheckIcon,
  ChevronLeftIcon,
  CircleDotIcon,
  ComputerIcon,
  ExternalLinkIcon,
  GhostIcon,
  GitPullRequestArrowIcon,
  Loading02Icon,
  Mail01Icon,
  Moon02Icon,
  Settings02Icon,
  Sun03Icon,
  ViewIcon,
  ViewOffIcon,
  VolumeHighIcon,
  VolumeOffIcon,
} from "@hugeicons/core-free-icons";
import { APPEARANCES, appearanceLabel, type Appearance } from "~/lib/appearance";
import {
  availabilityLine,
  hoursDraft,
  hoursFromSlider,
  hoursLabel,
  hoursSlider,
  HOURS_STEP_MINUTES,
  MACHINE_ZONE_LABEL,
  MINUTES_PER_DAY,
  suggestedZone,
  zoneOptions,
} from "~/lib/presence-hours";
import type { AvailableHours, SettingsPatch } from "~/lib/protocol";
import { pushBlockerMessage, pushBlockerRemedy } from "~/lib/push";
import { cn } from "~/lib/utils";
import { AiProvidersSettings } from "./ai-providers-settings";
import { CallRecordingsSettings } from "./call-recordings-settings";
import { ChessEngineSettings } from "./chess-engine-settings";
import { CustomAgentsSettings } from "./custom-agents-settings";
import { CustomEmojiSettings } from "./custom-emoji-settings";
import { MaintenanceSettings } from "./maintenance-settings";
import { RenamedPeopleSettings } from "./renamed-people-settings";
import { SealSettings } from "./seal-settings";
import { useAppState, useController } from "./controller-context";
import { LinearLogo } from "./linear-logo";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Slider } from "./ui/slider";

const APPEARANCE_ICONS: Record<Appearance, IconSvgElement> = {
  system: ComputerIcon,
  light: Sun03Icon,
  dark: Moon02Icon,
};

type SaveState = { kind: "idle" | "saving" | "saved" } | { kind: "error"; message: string };

/** Where the presence slider's two thumbs stand before a window exists: a working day, which
 *  is what the reader is almost certainly about to drag towards — a slider that opened at
 *  00:00-24:00 would say "all day" while the fields beside it said nothing. */
const DEFAULT_SPAN: [number, number] = [8 * 60, 19 * 60];

/** The zone THIS browser is in, which is where the reader is. Guarded, because a page can be
 *  server-rendered and `Intl` has no zone to report there. */
function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * The Settings surface, rendered in the right pane in place of a conversation
 * (see components/app.tsx). It hosts the AI providers this machine can run, the
 * integration configuration — the GitLab host and the access tokens that power rich
 * link previews — and the appearance preference. All values persist through the
 * backend (a token is write-only: the UI only ever learns whether one is stored,
 * never its value).
 */
export function SettingsPane(props: { onBack?: () => void }) {
  return (
    <section
      data-testid="settings-pane"
      className="flex min-w-0 flex-1 flex-col bg-background"
    >
      <header className="flex min-h-16 shrink-0 items-center gap-2 border-b border-border-subtle px-3 pt-[env(safe-area-inset-top)] md:gap-3 md:px-5">
        {props.onBack && (
          <button
            type="button"
            onClick={props.onBack}
            aria-label="Back to conversations"
            data-testid="back-to-list"
            className="-ml-1 grid size-9 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground md:hidden"
          >
            <HugeiconsIcon icon={ChevronLeftIcon} className="size-5" strokeWidth={1.6} />
          </button>
        )}
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary shadow-chip">
          <HugeiconsIcon icon={Settings02Icon} className="size-5" strokeWidth={1.5} />
        </div>
        <div className="flex min-w-0 flex-col">
          <h2 className="truncate text-sm font-medium text-foreground">Settings</h2>
          <p className="truncate text-[11px] text-text-faint">
            AI providers, custom agents, integrations, privacy, people, appearance, sounds,
            companions, and this app
          </p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6 md:px-5">
        <div className="mx-auto flex max-w-xl flex-col gap-8 pb-[env(safe-area-inset-bottom)]">
          <AiProvidersSettings />
          {/* Directly under the providers: a custom agent IS one of them wearing a name, so
              the two read as one subject and the picker in the dialog names the rows above. */}
          <CustomAgentsSettings />
          <GitLabSettings />
          <LinearSettings />
          <GhostModeSettings />
          {/* Inside the privacy run and between its two neighbours on purpose: who is told the
              user READ a message, then who can read what they WRITE, then what leaves this
              machine for a stranger's server. It draws nothing at all on a backend with no seal
              (see components/seal-settings.tsx). */}
          <SealSettings />
          <SenderIconSettings />
          <AlwaysAvailableSettings />
          <CallRecordingsSettings />
          {/* The CHESS ENGINE, beside the recordings for the same reason: both are things this app
              keeps on the machine, and an inventory is the only place a reader can find out that
              7 MB is sitting there. */}
          <ChessEngineSettings />
          <CustomEmojiSettings />
          <RenamedPeopleSettings />
          <NotificationSettings />
          <AppearanceSettings />
          <SoundsSettings />
          {/* Beside the sounds, at the end of the run that says what this WINDOW is like:
              appearance, then what it plays, then what it draws. */}
          <CompanionsSettings />
          <MaintenanceSettings />
        </div>
      </div>
    </section>
  );
}

/** GitLab integration: host + personal access token for rich link previews. */
function GitLabSettings() {
  const controller = useController();
  const settings = useAppState((s) => s.settings);

  const [host, setHost] = useState(settings.gitlab_host);
  const [token, setToken] = useState("");
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  // Sync the host field when the backend settings load/change (they arrive
  // shortly after connect). The token field stays empty — it is write-only.
  useEffect(() => setHost(settings.gitlab_host), [settings.gitlab_host]);

  const tokenSet = settings.gitlab_token_set;
  const tokenHelpUrl = `https://${(host || "gitlab.com").trim()}/-/user_settings/personal_access_tokens`;

  const persist = async (patch: SettingsPatch) => {
    setSave({ kind: "saving" });
    try {
      await controller.saveSettings(patch);
      setToken("");
      setSave({ kind: "saved" });
    } catch (e) {
      setSave({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const onSave = () => {
    const patch: SettingsPatch = { gitlabHost: host.trim() };
    // Only send the token when the user actually typed one; an empty field means
    // "leave the stored token unchanged".
    if (token.trim().length > 0) patch.gitlabToken = token;
    void persist(patch);
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary shadow-chip">
          <HugeiconsIcon icon={GitPullRequestArrowIcon} className="size-5" strokeWidth={1.5} />
        </div>
        <div className="flex flex-col">
          <h3 className="text-[15px] font-medium text-foreground">GitLab</h3>
          <p className="text-[13px] text-text-faint">
            Show rich previews for GitLab links (merge requests, issues, projects).
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-4 rounded-xl bg-card p-4 shadow-chip">
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-foreground">Host</span>
          <Input
            data-testid="gitlab-host-input"
            value={host}
            placeholder="gitlab.com"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setHost(e.target.value)}
          />
          <span className="text-[11px] text-text-faint">
            The GitLab instance to query — gitlab.com or your self-hosted host.
          </span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="flex items-center gap-2 text-[13px] font-medium text-foreground">
            Personal access token
            {tokenSet && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                <HugeiconsIcon icon={CheckIcon} className="size-3" strokeWidth={2.5} /> Saved
              </span>
            )}
          </span>
          <Input
            data-testid="gitlab-token-input"
            type="password"
            value={token}
            placeholder={tokenSet ? "•••••••••• (leave blank to keep)" : "glpat-…"}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setToken(e.target.value)}
          />
          <span className="text-[11px] text-text-faint">
            A token with the{" "}
            <code className="rounded bg-element px-1 py-0.5 font-mono text-[10px] text-text-dim">
              read_api
            </code>{" "}
            scope. Needed for private projects; public gitlab.com projects work
            without one.{" "}
            <a
              href={tokenHelpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 text-primary underline underline-offset-2 hover:opacity-80"
            >
              Create one{" "}
              <HugeiconsIcon icon={ExternalLinkIcon} className="size-3" strokeWidth={1.6} />
            </a>
          </span>
        </label>

        <div className="flex items-center gap-3 pt-1">
          <Button
            size="sm"
            data-testid="gitlab-save"
            onClick={onSave}
            disabled={save.kind === "saving"}
          >
            {save.kind === "saving" ? (
              <>
                <HugeiconsIcon
                  icon={Loading02Icon}
                  className="size-4 animate-spin"
                  strokeWidth={1.8}
                />{" "}
                Saving…
              </>
            ) : (
              "Save"
            )}
          </Button>
          {tokenSet && (
            <Button
              size="sm"
              variant="ghost"
              data-testid="gitlab-remove-token"
              disabled={save.kind === "saving"}
              onClick={() => void persist({ gitlabHost: host.trim(), gitlabToken: "" })}
            >
              Remove token
            </Button>
          )}
          {save.kind === "saved" && (
            <span
              data-testid="gitlab-save-status"
              className="flex items-center gap-1 text-xs text-emerald-600 animate-in fade-in-0 zoom-in-95 duration-200 ease-out dark:text-emerald-400"
            >
              <HugeiconsIcon icon={CheckIcon} className="size-3.5" strokeWidth={2} /> Saved
            </span>
          )}
          {save.kind === "error" && (
            <span data-testid="gitlab-save-status" className="text-xs text-destructive">
              {save.message}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Linear integration: an API key for rich link previews.
 *
 * Simpler than the GitLab section by one field, and deliberately so: Linear is
 * SaaS-only, so there is no host to configure — and no anonymous read either, which
 * is why the key is not optional here. Without one, a Linear link stays a bare URL.
 */
function LinearSettings() {
  const controller = useController();
  const tokenSet = useAppState((s) => s.settings.linear_token_set);

  const [token, setToken] = useState("");
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  const persist = async (patch: SettingsPatch) => {
    setSave({ kind: "saving" });
    try {
      await controller.saveSettings(patch);
      setToken("");
      setSave({ kind: "saved" });
    } catch (e) {
      setSave({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        {/* Linear's own mark, so the section is recognised before it is read. It
            sits on the neutral surface rather than the accent tint the sections
            above use: the mark is monochrome brand colour, and Linear asks that it
            not be laid over a field that competes with it. */}
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-element shadow-chip">
          <LinearLogo className="size-[18px]" />
        </div>
        <div className="flex flex-col">
          <h3 className="text-[15px] font-medium text-foreground">Linear</h3>
          <p className="text-[13px] text-text-faint">
            Show rich previews for Linear links (issues, projects, documents).
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-4 rounded-xl bg-card p-4 shadow-chip">
        <label className="flex flex-col gap-1.5">
          <span className="flex items-center gap-2 text-[13px] font-medium text-foreground">
            API key
            {tokenSet && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                <HugeiconsIcon icon={CheckIcon} className="size-3" strokeWidth={2.5} /> Saved
              </span>
            )}
          </span>
          <Input
            data-testid="linear-token-input"
            type="password"
            value={token}
            placeholder={tokenSet ? "•••••••••• (leave blank to keep)" : "lin_api_…"}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setToken(e.target.value)}
          />
          <span className="text-[11px] text-text-faint">
            A personal API key from your Linear settings. Linear has no public read
            access, so previews need one.{" "}
            <a
              href="https://linear.app/settings/account/security"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 text-primary underline underline-offset-2 hover:opacity-80"
            >
              Create one{" "}
              <HugeiconsIcon icon={ExternalLinkIcon} className="size-3" strokeWidth={1.6} />
            </a>
          </span>
        </label>

        <div className="flex items-center gap-3 pt-1">
          <Button
            size="sm"
            data-testid="linear-save"
            disabled={save.kind === "saving" || token.trim().length === 0}
            onClick={() => void persist({ linearToken: token })}
          >
            {save.kind === "saving" ? (
              <>
                <HugeiconsIcon
                  icon={Loading02Icon}
                  className="size-4 animate-spin"
                  strokeWidth={1.8}
                />{" "}
                Saving…
              </>
            ) : (
              "Save"
            )}
          </Button>
          {tokenSet && (
            <Button
              size="sm"
              variant="ghost"
              data-testid="linear-remove-token"
              disabled={save.kind === "saving"}
              onClick={() => void persist({ linearToken: "" })}
            >
              Remove key
            </Button>
          )}
          {save.kind === "saved" && (
            <span
              data-testid="linear-save-status"
              className="flex items-center gap-1 text-xs text-emerald-600 animate-in fade-in-0 zoom-in-95 duration-200 ease-out dark:text-emerald-400"
            >
              <HugeiconsIcon icon={CheckIcon} className="size-3.5" strokeWidth={2} /> Saved
            </span>
          )}
          {save.kind === "error" && (
            <span data-testid="linear-save-status" className="text-xs text-destructive">
              {save.message}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Ghost mode — read a conversation without telling Teams.
 *
 * Off by default, and deliberately so: what every chat client does, and what the user
 * expects, is that opening a chat marks it read everywhere (their phone, the desktop
 * app) — which is also what shows the sender a read receipt. Turning this on keeps the
 * second half from happening: the marker clears here, Teams keeps the thread unread,
 * and a small ghost icon on the row says so.
 */
function GhostModeSettings() {
  const controller = useController();
  const enabled = useAppState((s) => s.settings.ghost_mode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await controller.saveSettings({ ghostMode: !enabled });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-4" data-testid="ghost-mode-settings">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary shadow-chip">
          <HugeiconsIcon icon={GhostIcon} className="size-5" strokeWidth={1.5} />
        </div>
        <div className="flex flex-col">
          <h3 className="text-[15px] font-medium text-foreground">Ghost mode</h3>
          <p className="text-[13px] text-text-faint">
            Read a conversation without telling Teams. The unread marker clears here,
            the chat stays unread everywhere else, and the sender sees no read receipt.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4 shadow-chip">
        <div className="flex min-w-0 flex-col">
          <span className="text-[13px] font-medium text-foreground">Read invisibly</span>
          <span className="text-[11px] text-text-faint">
            {enabled
              ? "On — a ghost icon marks the chats read only here"
              : "Off — opening a chat marks it read on Teams too"}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Ghost mode"
          data-testid="ghost-mode-toggle"
          disabled={busy}
          onClick={() => void toggle()}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            busy && "opacity-60",
            enabled ? "bg-primary" : "bg-element",
          )}
        >
          <span
            className={cn(
              "inline-block size-5 transform rounded-full bg-white shadow-sm transition-transform",
              enabled ? "translate-x-[22px]" : "translate-x-0.5",
            )}
          />
        </button>
      </div>

      {error && (
        <span data-testid="ghost-mode-error" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </section>
  );
}

/**
 * Sender icons — the mark of the organisation a mail came from.
 *
 * ON by default, and the only switch here that is: a mail from a colleague shows their
 * real photo, while a mail from Sentry or Linear has no directory entry at all, and its
 * own favicon is the mark the reader already knows.
 *
 * It is a switch because it is the one place this app requests something from a server
 * nobody here configured. What makes that defensible is not this toggle but the rails in
 * `src/sender_icon.rs`: only the registrable domain is ever asked for, so a
 * per-recipient subdomain never reaches the wire; the answer is remembered per
 * organisation, so a server is asked once rather than once per mail; and the request is
 * made when a LIST renders, never when a body is opened, so it cannot say a mail was
 * read. The copy below says exactly that, because a setting whose cost the user cannot
 * read is a setting they cannot judge.
 */
function SenderIconSettings() {
  const controller = useController();
  const enabled = useAppState((s) => s.settings.sender_icons);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await controller.saveSettings({ senderIcons: !enabled });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-4" data-testid="sender-icon-settings">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary shadow-chip">
          <HugeiconsIcon icon={Mail01Icon} className="size-5" strokeWidth={1.5} />
        </div>
        <div className="flex flex-col">
          <h3 className="text-[15px] font-medium text-foreground">Sender icons</h3>
          <p className="text-[13px] text-text-faint">
            Show the mark of the organisation a mail came from, for a sender the Teams
            directory cannot name. It is fetched once per organisation from that
            organisation's own domain — never per mail, and never when a message is
            opened, so it cannot tell a sender their mail was read.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4 shadow-chip">
        <div className="flex min-w-0 flex-col">
          <span className="text-[13px] font-medium text-foreground">
            Load a sender's icon
          </span>
          <span className="text-[11px] text-text-faint">
            {enabled
              ? "On — the mail list asks each new domain once"
              : "Off — no request ever leaves for a sender's domain"}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Sender icons"
          data-testid="sender-icon-toggle"
          disabled={busy}
          onClick={() => void toggle()}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            busy && "opacity-60",
            enabled ? "bg-primary" : "bg-element",
          )}
        >
          <span
            className={cn(
              "inline-block size-5 transform rounded-full bg-white shadow-sm transition-transform",
              enabled ? "translate-x-[22px]" : "translate-x-0.5",
            )}
          />
        </button>
      </div>

      {error && (
        <span data-testid="sender-icon-error" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </section>
  );
}

/**
 * Always available — keep the user's own Teams status green, DURING THE HOURS THEY SET.
 *
 * The one setting here that other people can see. Inside the hours the backend registers
 * this machine as a Teams endpoint reporting Available and refreshes it every two minutes,
 * so the status stays green while the app's backend runs — including with every window
 * closed. Outside them, and with the switch off, the registration is removed and Teams
 * computes the status again, exactly as before.
 *
 * The hours are what make the green dot a claim a person could plausibly make: the switch
 * alone published Available at 03:00 as eagerly as at 11:00. They are OPTIONAL, and both
 * fields empty means all day — which is what this setting did before it grew them.
 *
 * Off by default, and the copy says plainly who sees it: a status the user did not ask
 * for is a claim about where they are that they never made.
 */
function AlwaysAvailableSettings() {
  const controller = useController();
  const settings = useAppState((s) => s.settings);
  const enabled = settings.always_available;
  const [from, setFrom] = useState(settings.available_from ?? "");
  const [to, setTo] = useState(settings.available_to ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Follow the backend: the settings arrive shortly after connect, and the hours turning
  // arrives as an event while this pane is open (see `settings_changed`).
  useEffect(() => setFrom(settings.available_from ?? ""), [settings.available_from]);
  useEffect(() => setTo(settings.available_to ?? ""), [settings.available_to]);

  const publish = async (
    nextEnabled: boolean,
    hours: AvailableHours | null,
    zone: string | null = settings.available_zone,
  ) => {
    setBusy(true);
    setError(null);
    try {
      await controller.setAlwaysAvailable(nextEnabled, { hours, zone });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const draft = hoursDraft(from, to);
  // The window the BACKEND holds, which is what every write that is not itself about the
  // hours has to carry: the switch and the zone both send the whole schedule, so a call that
  // sent none would clear the user's window every time they touched either.
  const storedHours =
    settings.available_from && settings.available_to
      ? { from: settings.available_from, to: settings.available_to }
      : null;
  // A window only one end of is not something the backend can store — so the switch and the
  // zone keep the hours it last HAD while the sentence below asks for the other end, and only
  // an emptied pair (all day) really clears them.
  const hoursForSwitch =
    draft.kind === "hours" ? draft.hours : draft.kind === "all-day" ? null : storedHours;

  // Typing an hour is the write — the pane holds no Save button, like the model picker.
  // Both ends stores the window, both empty is all day, and one end stores nothing.
  const editHours = (nextFrom: string, nextTo: string) => {
    setFrom(nextFrom);
    setTo(nextTo);
    const next = hoursDraft(nextFrom, nextTo);
    if (next.kind === "hours") void publish(enabled, next.hours);
    else if (next.kind === "all-day") void publish(enabled, null);
  };

  // The slider stands for the window the two fields hold, and for a DEFAULT span when they
  // hold none — so the control the reader drags is never at a position that means nothing.
  const slider = hoursSlider(hoursForSwitch) ?? { values: DEFAULT_SPAN, wrapped: false };
  const sliderValues = [slider.values[0], slider.values[1]];

  // A drag moves the fields and posts nothing (see the slider below); the commit is the
  // write. Both keep the window's MODE, so dragging a night shift keeps it one.
  const dragHours = (next: number[]) => {
    const hours = hoursFromSlider(next, slider.wrapped);
    setFrom(hours.from);
    setTo(hours.to);
  };
  const commitHours = (next: number[]) => {
    const hours = hoursFromSlider(next, slider.wrapped);
    setFrom(hours.from);
    setTo(hours.to);
    void publish(enabled, hours);
  };

  // The zones this browser can name, and the one the reader is in right now — which is the
  // whole reason the zone is a setting: the person travels, the backend's machine does not.
  const browserZone = browserTimeZone();
  const zones = zoneOptions(settings.available_zone, browserZone);
  const suggestion = suggestedZone(settings.available_zone, browserZone);

  const timeField =
    "rounded-lg bg-element px-2 py-1 text-[13px] text-foreground tabular-nums " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <section className="flex flex-col gap-4" data-testid="always-available-settings">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary shadow-chip">
          <HugeiconsIcon icon={CircleDotIcon} className="size-5" strokeWidth={1.5} />
        </div>
        <div className="flex flex-col">
          <h3 className="text-[15px] font-medium text-foreground">Always available</h3>
          <p className="text-[13px] text-text-faint">
            Keep your own Teams status green. Everyone who can see you reads it, on
            every Teams client, until you turn it off.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-4 rounded-xl bg-card p-4 shadow-chip">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden
              data-testid="always-available-dot"
              className={cn(
                "size-2.5 shrink-0 rounded-full transition-colors",
                settings.available_now ? "bg-emerald-500" : "bg-element",
              )}
            />
            <div className="flex min-w-0 flex-col">
              <span className="text-[13px] font-medium text-foreground">
                Show me as Available
              </span>
              <span data-testid="always-available-state" className="text-[11px] text-text-faint">
                {availabilityLine(settings)}
              </span>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Always available"
            data-testid="always-available-toggle"
            disabled={busy}
            onClick={() => void publish(!enabled, hoursForSwitch)}
            className={cn(
              "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              busy && "opacity-60",
              enabled ? "bg-primary" : "bg-element",
            )}
          >
            <span
              className={cn(
                "inline-block size-5 transform rounded-full bg-white shadow-sm transition-transform",
                enabled ? "translate-x-[22px]" : "translate-x-0.5",
              )}
            />
          </button>
        </div>

        {/* The hours. A two-thumb SLIDER is the control — a window is a span, and dragging
            its two ends is how somebody says "my day looks like this" — with the exact hours
            beside it as fields, because typing 08:30 beats aiming at it and because a window
            that CROSSES MIDNIGHT cannot be dragged into being (the thumbs cannot pass each
            other). One value, two ways in: the slider is coarse and direct, the fields are
            exact. */}
        <div className="flex flex-col gap-2 border-t border-border-subtle pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] text-foreground">Green between</span>
            {/* Never DISABLED while a write is in flight, unlike the switch: a native time
                field edited from its hour segment fires as soon as those two digits land, and
                disabling it there blurs it — on a phone over a tailnet that is 300 ms in which
                the minutes the reader is typing go nowhere. */}
            <input
              type="time"
              aria-label="Available from"
              data-testid="available-from"
              value={from}
              onChange={(e) => editHours(e.target.value, to)}
              className={timeField}
            />
            <span className="text-[13px] text-text-faint">and</span>
            <input
              type="time"
              aria-label="Available until"
              data-testid="available-to"
              value={to}
              onChange={(e) => editHours(from, e.target.value)}
              className={timeField}
            />
            {draft.kind === "hours" && (
              <button
                type="button"
                data-testid="available-all-day"
                disabled={busy}
                onClick={() => editHours("", "")}
                className="rounded-lg px-2 py-1 text-[11px] text-text-dim transition-colors hover:bg-accent hover:text-foreground"
              >
                All day
              </button>
            )}
          </div>

          <Slider
            data-testid="available-slider"
            min={0}
            max={MINUTES_PER_DAY}
            step={HOURS_STEP_MINUTES}
            // One step between the thumbs, which is also the backend's own rule: two equal
            // hours read both as "never" and as "all day", so it refuses them.
            minStepsBetweenThumbs={1}
            value={sliderValues}
            // The drag moves the readout on every frame and posts NOTHING: a publish per
            // frame would be dozens of outward calls for one gesture. The commit — pointer up,
            // or key up — is the write.
            onValueChange={(next) => dragHours(next)}
            onValueCommit={(next) => commitHours(next)}
            // A window crossing midnight is green on the OUTSIDE of the two thumbs, and this
            // primitive's own range is one element — so the caller draws both segments.
            renderRange={!slider?.wrapped}
          >
            {slider?.wrapped && (
              <>
                <span
                  aria-hidden
                  className="absolute inset-y-0 left-0 bg-primary"
                  style={{ width: `${(slider.values[0] / MINUTES_PER_DAY) * 100}%` }}
                />
                <span
                  aria-hidden
                  className="absolute inset-y-0 right-0 bg-primary"
                  style={{
                    width: `${((MINUTES_PER_DAY - slider.values[1]) / MINUTES_PER_DAY) * 100}%`,
                  }}
                />
              </>
            )}
          </Slider>
          {/* The scale, so the two thumbs sit on something a reader can place them against. */}
          <div
            aria-hidden
            className="flex justify-between px-0.5 text-[10px] tabular-nums text-text-faint"
          >
            {["00:00", "06:00", "12:00", "18:00", "24:00"].map((mark) => (
              <span key={mark}>{mark}</span>
            ))}
          </div>

          {/* The ZONE those hours are kept in. It is the user's own and not the machine's,
              because the person travels while the always-on service stays in one flat. The
              list is the browser's own IANA names, so it costs the wire nothing. */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <label
              htmlFor="available-zone"
              className="text-[13px] text-foreground"
            >
              in
            </label>
            <select
              id="available-zone"
              data-testid="available-zone"
              value={settings.available_zone ?? ""}
              disabled={busy}
              onChange={(e) => void publish(enabled, hoursForSwitch, e.target.value || null)}
              className={cn(timeField, "max-w-[15rem]")}
            >
              <option value="">{MACHINE_ZONE_LABEL}</option>
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
            {suggestion && (
              <button
                type="button"
                data-testid="available-zone-here"
                disabled={busy}
                onClick={() => void publish(enabled, hoursForSwitch, suggestion)}
                className="rounded-lg px-2 py-1 text-[11px] text-text-dim transition-colors hover:bg-accent hover:text-foreground"
              >
                Use {suggestion}
              </button>
            )}
          </div>
        </div>
        <span data-testid="available-hours-hint" className="text-[11px] text-text-faint">
          {draft.kind === "incomplete"
            ? "Set both times — one on its own says nothing, and clearing both means all day."
            : draft.kind === "all-day"
              ? "Empty means all day. Drag a span — 08:00 to 19:00 — and the green dot keeps working hours."
              : `Green ${hoursLabel(draft.hours)} in ${settings.available_zone ?? MACHINE_ZONE_LABEL.toLowerCase()}; outside those hours Teams decides your status. An end before its start crosses midnight.`}
        </span>
      </div>

      {error && (
        <span data-testid="always-available-error" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </section>
  );
}

/**
 * Push notifications for THIS device — the only path that reaches a phone whose app
 * is closed (see lib/push.ts and src/push.rs).
 *
 * The switch is a real button and nothing subscribes on load: iOS refuses a
 * permission prompt that does not come from a user gesture. When the device cannot
 * subscribe at all, the section says why instead of offering a switch that would do
 * nothing — on iPhone that reason is almost always "add it to the Home Screen
 * first", which is advice, not a failure.
 */
function NotificationSettings() {
  const controller = useController();
  const push = useAppState((s) => s.push);
  const [testResult, setTestResult] = useState<string | null>(null);

  const enabled = push.endpoint !== null;
  const blocked = push.blocker !== null;
  const blockerMessage = pushBlockerMessage(push.blocker, push.error ?? undefined);
  const blockerRemedy = pushBlockerRemedy(push.blocker);
  const otherDevices = push.devices.filter((device) => device.endpoint !== push.endpoint);

  const toggle = async () => {
    setTestResult(null);
    try {
      if (enabled) await controller.disablePush();
      else await controller.enablePush();
    } catch {
      // The controller already put the reason in state; the pane shows it below.
    }
  };

  const test = async () => {
    setTestResult(null);
    try {
      const report = await controller.testPush();
      setTestResult(
        report.delivered > 0
          ? `Sent to ${report.delivered} device${report.delivered === 1 ? "" : "s"}.`
          : "No device accepted the notification.",
      );
    } catch {
      // Same: `push.error` carries it.
    }
  };

  return (
    <section className="flex flex-col gap-4" data-testid="notification-settings">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary shadow-chip">
          <HugeiconsIcon icon={BellIcon} className="size-5" strokeWidth={1.5} />
        </div>
        <div className="flex flex-col">
          <h3 className="text-[15px] font-medium text-foreground">Notifications</h3>
          <p className="text-[13px] text-text-faint">
            Get a notification on this device when someone writes to you — even when
            teams-lite is closed.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-4 rounded-xl bg-card p-4 shadow-chip">
        {blocked ? (
          <div className="flex flex-col gap-2">
            <p data-testid="push-blocked" className="text-[13px] text-text-dim">
              {blockerMessage}
            </p>
            {/* What to DO about it, for the blocker whose answer does not fit a line. This
                pane is where it belongs: the sidebar row states the same problem in
                eleven-pixel text, and somebody reading this has already come here to mend
                something (see `pushBlockerRemedy`). */}
            {blockerRemedy && (
              <p data-testid="push-remedy" className="text-[12px] leading-snug text-text-faint">
                {blockerRemedy}
              </p>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 flex-col">
              <span className="text-[13px] font-medium text-foreground">This device</span>
              <span className="text-[11px] text-text-faint">
                {push.busy ? "Working…" : enabled ? "On" : "Off"}
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label="Push notifications on this device"
              data-testid="push-toggle"
              disabled={push.busy}
              onClick={() => void toggle()}
              className={cn(
                "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                push.busy && "opacity-60",
                enabled ? "bg-primary" : "bg-element",
              )}
            >
              <span
                className={cn(
                  "inline-block size-5 transform rounded-full bg-white shadow-sm transition-transform",
                  enabled ? "translate-x-[22px]" : "translate-x-0.5",
                )}
              />
            </button>
          </div>
        )}

        {enabled && (
          <div className="flex items-center gap-3">
            <Button size="sm" variant="ghost" data-testid="push-test" disabled={push.busy} onClick={() => void test()}>
              Send a test notification
            </Button>
            {testResult && (
              <span data-testid="push-test-result" className="text-xs text-text-dim">
                {testResult}
              </span>
            )}
          </div>
        )}

        {push.error && !blocked && (
          <span data-testid="push-error" className="text-xs text-destructive">
            {push.error}
          </span>
        )}

        {otherDevices.length > 0 && (
          <div className="flex flex-col gap-1 border-t border-border-subtle pt-3">
            <span className="text-[11px] font-medium uppercase tracking-wide text-text-faint">
              Other devices
            </span>
            {otherDevices.map((device) => (
              <span key={device.endpoint} className="text-[12px] text-text-dim">
                {device.label || "Unnamed device"}
                {device.last_error ? " — not reachable" : ""}
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** Appearance preference (Light / Dark / System) — the same choice as the Cmd/Ctrl+P
 *  picker, surfaced here so Settings is a single home. */
function AppearanceSettings() {
  const controller = useController();
  const appearance = useAppState((s) => s.appearance);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col">
        <h3 className="text-[15px] font-medium text-foreground">Appearance</h3>
        <p className="text-[13px] text-text-faint">Choose how teams-lite looks.</p>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {APPEARANCES.map((pref) => {
          const icon = APPEARANCE_ICONS[pref];
          const active = appearance === pref;
          return (
            <button
              key={pref}
              type="button"
              data-testid="appearance-option"
              data-value={pref}
              data-cuelume-press=""
              aria-pressed={active}
              onClick={() => controller.setAppearance(pref)}
              className={cn(
                "relative flex flex-col items-center gap-2 rounded-xl bg-card px-3 py-4 text-center transition-all",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "text-foreground shadow-card ring-1 ring-primary/40"
                  : "text-muted-foreground shadow-chip hover:text-foreground hover:shadow-card",
              )}
            >
              {active && (
                <span className="absolute right-2 top-2 text-primary">
                  <HugeiconsIcon icon={CheckIcon} className="size-3.5" strokeWidth={2} />
                </span>
              )}
              <HugeiconsIcon
                icon={icon}
                className={cn("size-5", active ? "text-primary" : "text-current")}
                strokeWidth={1.4}
              />
              <span className="text-[13px] font-medium">{appearanceLabel(pref)}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** Interaction sounds on/off (cuelume). A per-device preference, persisted client
 *  side; the switch flips the engine's global flag so the message cues, the outcome
 *  cues and the `data-cuelume-*` button feedback go quiet together. */
function SoundsSettings() {
  const controller = useController();
  const enabled = useAppState((s) => s.soundsEnabled);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col">
        <h3 className="text-[15px] font-medium text-foreground">Sounds</h3>
        <p className="text-[13px] text-text-faint">
          Play subtle interaction sounds — an incoming message, a button press, and
          whether an action succeeded or failed.
        </p>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4 shadow-chip">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary shadow-chip">
            {enabled ? (
              <HugeiconsIcon icon={VolumeHighIcon} className="size-5" strokeWidth={1.5} />
            ) : (
              <HugeiconsIcon icon={VolumeOffIcon} className="size-5" strokeWidth={1.5} />
            )}
          </div>
          <div className="flex min-w-0 flex-col">
            <span className="text-[13px] font-medium text-foreground">Interaction sounds</span>
            <span className="text-[11px] text-text-faint">{enabled ? "On" : "Off"}</span>
          </div>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Interaction sounds"
          data-testid="sounds-toggle"
          onClick={() => controller.setSoundsEnabled(!enabled)}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            enabled ? "bg-primary" : "bg-element",
          )}
        >
          <span
            className={cn(
              "inline-block size-5 transform rounded-full bg-white shadow-sm transition-transform",
              enabled ? "translate-x-[22px]" : "translate-x-0.5",
            )}
          />
        </button>
      </div>
    </section>
  );
}

/** Whether THIS WINDOW draws the conversations' companions. A per-device preference, persisted
 *  client side beside the sounds and the appearance (lib/pet-visibility.ts holds the whole of
 *  it), because whether a reader wants to look at a creature is not a fact about the
 *  conversation — so there is nothing to publish and no backend row behind this switch.
 *
 *  **HIDING IS NOT DESPAWNING, and the words say so rather than leaving it to be worked out** —
 *  in the SUBTITLE, which is on screen at the moment the reader is deciding, and again in the
 *  row once the switch is off. It used to be in the off state alone, so the one fact somebody
 *  needs BEFORE the press arrived only after it: reversible in the same second, and still the
 *  wrong order. Off stops this window drawing them; the reader's own pet stays in the thread,
 *  their friends still see it, and it goes on ageing. Putting a pet down for everybody is its
 *  own menu's Remove, which asks twice — and a reader who could not tell the two apart would
 *  turn this off believing they had done that. That menu is deliberately NOT named on screen
 *  until it exists: a control the reader cannot find reads as one this app has lost.
 *
 *  **It is drawn whether or not a pet exists anywhere**, with no empty state: Settings is where
 *  somebody goes to turn a thing off before they have ever met it. */
function CompanionsSettings() {
  const controller = useController();
  const shown = useAppState((s) => s.petsShown);

  return (
    <section className="flex flex-col gap-4" data-testid="companions-settings">
      <div className="flex flex-col">
        <h3 className="text-[15px] font-medium text-foreground">Companions</h3>
        <p className="text-[13px] text-text-faint">
          Draw the little creature a conversation keeps — yours and your colleagues'. This
          decides what this browser SHOWS: it never takes a pet away from the thread.
        </p>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4 shadow-chip">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary shadow-chip">
            <HugeiconsIcon
              icon={shown ? ViewIcon : ViewOffIcon}
              className="size-5"
              strokeWidth={1.5}
            />
          </div>
          <div className="flex min-w-0 flex-col">
            <span className="text-[13px] font-medium text-foreground">Show companions</span>
            {/* The cost of OFF, where the reader is deciding: this hides them in this window
                only. A pet is taken away for everybody from its own menu. */}
            <span className="text-[11px] text-text-faint">
              {shown
                ? "On — in this browser"
                : "Off — hidden in this browser only. Your pet is still in the thread and your colleagues still see it."}
            </span>
          </div>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={shown}
          aria-label="Show companions"
          data-testid="companions-toggle"
          onClick={() => controller.setPetsShown(!shown)}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            shown ? "bg-primary" : "bg-element",
          )}
        >
          <span
            className={cn(
              "inline-block size-5 transform rounded-full bg-white shadow-sm transition-transform",
              shown ? "translate-x-[22px]" : "translate-x-0.5",
            )}
          />
        </button>
      </div>
    </section>
  );
}
