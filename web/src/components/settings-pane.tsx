import { useEffect, useState } from "react";
import {
  Check,
  ChevronLeft,
  ExternalLink,
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
import { cn } from "~/lib/utils";
import { useAppState, useController } from "./controller-context";
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
 * (see components/app.tsx). It hosts integration configuration — currently the
 * GitLab host + access token that power rich link previews — and the appearance
 * preference. All values persist through the backend (the token is write-only:
 * the UI only ever learns whether one is stored, never its value).
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
          <p className="truncate text-[11px] text-text-faint">Integrations, appearance, and sounds</p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6 md:px-5">
        <div className="mx-auto flex max-w-xl flex-col gap-8 pb-[env(safe-area-inset-bottom)]">
          <GitLabSettings />
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

  const persist = async (patch: { gitlabHost?: string; gitlabToken?: string }) => {
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
    const patch: { gitlabHost?: string; gitlabToken?: string } = { gitlabHost: host.trim() };
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

/** Appearance preference (Light / Dark / System) — the same choice as the Ctrl+P
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
 *  side; the switch flips the engine's global flag so both message cues and the
 *  `data-cuelume-*` button feedback go quiet together. */
function SoundsSettings() {
  const controller = useController();
  const enabled = useAppState((s) => s.soundsEnabled);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col">
        <h3 className="text-[15px] font-medium text-foreground">Sounds</h3>
        <p className="text-[13px] text-text-faint">
          Play subtle interaction sounds — sending and receiving messages, and
          button feedback.
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
