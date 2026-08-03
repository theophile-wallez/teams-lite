import { useEffect, useState } from "react";
import {
  Bell,
  Check,
  ChevronLeft,
  ExternalLink,
  Ghost,
  GitPullRequestArrow,
  Loader2,
  Monitor,
  MoonStar,
  Settings as SettingsIcon,
  Sun,
  Volume2,
  VolumeX,
  type LucideIcon,
} from "lucide-react";
import { APPEARANCES, appearanceLabel, type Appearance } from "~/lib/appearance";
import type { SettingsPatch } from "~/lib/protocol";
import { pushBlockerMessage } from "~/lib/push";
import { cn } from "~/lib/utils";
import { useAppState, useController } from "./controller-context";
import { LinearLogo } from "./linear-logo";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const APPEARANCE_ICONS: Record<Appearance, LucideIcon> = {
  system: Monitor,
  light: Sun,
  dark: MoonStar,
};

type SaveState = { kind: "idle" | "saving" | "saved" } | { kind: "error"; message: string };

/**
 * The Settings surface, rendered in the right pane in place of a conversation
 * (see components/app.tsx). It hosts integration configuration — the GitLab host
 * and the access tokens that power rich link previews — and the appearance
 * preference. All values persist through the backend (a token is write-only: the
 * UI only ever learns whether one is stored, never its value).
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
            <ChevronLeft className="size-5" strokeWidth={1.6} />
          </button>
        )}
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary shadow-chip">
          <SettingsIcon className="size-5" strokeWidth={1.5} />
        </div>
        <div className="flex min-w-0 flex-col">
          <h2 className="truncate text-sm font-medium text-foreground">Settings</h2>
          <p className="truncate text-[11px] text-text-faint">
            Integrations, privacy, appearance, and sounds
          </p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6 md:px-5">
        <div className="mx-auto flex max-w-xl flex-col gap-8 pb-[env(safe-area-inset-bottom)]">
          <GitLabSettings />
          <LinearSettings />
          <GhostModeSettings />
          <NotificationSettings />
          <AppearanceSettings />
          <SoundsSettings />
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
          <GitPullRequestArrow className="size-5" strokeWidth={1.5} />
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
                <Check className="size-3" strokeWidth={2.5} /> Saved
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
              Create one <ExternalLink className="size-3" strokeWidth={1.6} />
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
                <Loader2 className="size-4 animate-spin" strokeWidth={1.8} /> Saving…
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
              <Check className="size-3.5" strokeWidth={2} /> Saved
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
                <Check className="size-3" strokeWidth={2.5} /> Saved
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
              Create one <ExternalLink className="size-3" strokeWidth={1.6} />
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
                <Loader2 className="size-4 animate-spin" strokeWidth={1.8} /> Saving…
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
              <Check className="size-3.5" strokeWidth={2} /> Saved
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
          <Ghost className="size-5" strokeWidth={1.5} />
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
          <Bell className="size-5" strokeWidth={1.5} />
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
          <p data-testid="push-blocked" className="text-[13px] text-text-dim">
            {blockerMessage}
          </p>
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
          const Icon = APPEARANCE_ICONS[pref];
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
                  <Check className="size-3.5" strokeWidth={2} />
                </span>
              )}
              <Icon
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
              <Volume2 className="size-5" strokeWidth={1.5} />
            ) : (
              <VolumeX className="size-5" strokeWidth={1.5} />
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
