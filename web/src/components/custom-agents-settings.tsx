import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, ImageUpload01Icon, PlusSignIcon, RobotIcon } from "@hugeicons/core-free-icons";
import { agentBackendLabel, availableBackends, usableBackends } from "~/lib/agent";
import {
  MAX_PERSONAS,
  MAX_PERSONA_LABEL_CHARS,
  MAX_PERSONA_PREPROMPT_CHARS,
  agentPersonas,
  personaNameFrom,
  personaNameProblem,
  type AgentPersona,
  type AgentPersonaPatch,
} from "~/lib/agent-persona";
import { agentDisplayName } from "~/lib/agent-message";
import { loadComposerImage } from "~/lib/composer-image";
import { cn } from "~/lib/utils";
import { AgentMark } from "./agent-persona-mark";
import { useAppState, useController } from "./controller-context";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";

/**
 * Settings › Custom agents: the user's own agents, and the one place to make, change or
 * forget one.
 *
 * A custom agent is a NAME for an AI provider this machine already runs — a face, a label, a
 * model and a standing instruction — so a thread can hold a review bot and a boomer aunt
 * beside the ordinary assistant, each addressed by who it is (see lib/agent-persona.ts).
 *
 * It lives in Settings rather than in the thread menu beside the agent switch, and the split
 * is the one § Renamed people already makes: the CONSENT to answer in a conversation belongs
 * in that conversation's own header, where the user can see who reads it; the LIST of what
 * they have made belongs somewhere a thing made months ago can still be found and undone
 * without hunting through chats for a name nobody remembers.
 *
 * Three things about the pane itself:
 *
 * - **It draws nothing this machine could not run.** A provider with no CLI here is offered
 *   as a base and SAID to be missing, rather than silently — the user may be setting up an
 *   agent for the machine they are about to install it on, and a picker that hides the row
 *   reads as a bug.
 * - **The PREPROMPT is shown in full while it is edited and never anywhere else.** It is the
 *   whole point of the feature and it must not reach a message body; the list shows one dim
 *   line of it so a row is recognisable, and nothing else in the app draws it at all.
 * - **A deletion asks twice.** Nothing upstream brings a persona back, and its preprompt is
 *   prose the user wrote — the pattern the emoji list and a message's own Delete use, for
 *   the sharper version of the same reason.
 */
export function CustomAgentsSettings() {
  const agent = useAppState((s) => s.agent);
  const personas = agentPersonas(agent);
  const [editing, setEditing] = useState<AgentPersona | "new" | null>(null);
  // Which row is armed. The trash arms, the named button calls.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useController();

  const remove = async (name: string) => {
    setError(null);
    try {
      await controller.removeAgentPersona(name);
      setConfirming(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // A machine with no provider it could run cannot answer as anybody, so there is nothing
  // here to make — and a form that saved a row which could never be summoned would be worse
  // than the sentence. The pane still draws whatever the user already made, because it is
  // also the only place to remove one.
  const usable = usableBackends(agent);

  return (
    <section className="flex flex-col gap-4" data-testid="custom-agents-settings">
      <div className="flex flex-col gap-1">
        <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <HugeiconsIcon icon={RobotIcon} className="size-4 text-text-dim" strokeWidth={1.6} />
          Custom agents
        </h3>
        <p className="text-[13px] leading-snug text-text-dim">
          Your own agents, each running one of the AI providers above. Write{" "}
          <code className="rounded bg-element px-1 py-0.5 text-[12px]">@name</code> in a
          conversation that has agent replies switched on, and that agent answers — under its own
          name and face, with its own instructions leading every prompt. They stay on this
          machine: a colleague never receives one.
        </p>
      </div>

      {personas.length === 0 ? (
        <p data-testid="custom-agents-empty" className="text-[13px] text-text-faint">
          You have no custom agents yet.
        </p>
      ) : (
        <ul data-testid="custom-agents-list" className="flex flex-col gap-2">
          {personas.map((persona) => (
            <li
              key={persona.name}
              data-testid="custom-agent-row"
              data-persona={persona.name}
              className="flex items-center gap-3 rounded-xl bg-card p-3 shadow-chip"
            >
              <AgentMark
                backend={persona.backend}
                persona={persona.name}
                className="size-8 rounded-lg"
              />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] font-medium text-foreground">
                  {persona.label}
                </span>
                <span className="truncate text-[11px] text-text-faint">
                  {persona.prefix} · {agentDisplayName(persona.backend)}
                  {persona.model ? ` · ${persona.model}` : ""}
                </span>
                {/* One dim line of the instruction, so a row is recognisable at a glance.
                    Never more: the whole of it is a document, and it belongs in the editor. */}
                {persona.preprompt ? (
                  <span
                    data-testid="custom-agent-preprompt"
                    className="truncate text-[11px] text-text-faint/80"
                  >
                    {persona.preprompt}
                  </span>
                ) : null}
              </div>
              <Button
                size="sm"
                variant="ghost"
                data-testid="custom-agent-edit"
                onClick={() => setEditing(persona)}
              >
                Edit
              </Button>
              {confirming === persona.name ? (
                <Button
                  size="sm"
                  variant="destructive"
                  data-testid="custom-agent-delete-confirm"
                  onClick={() => void remove(persona.name)}
                >
                  Delete {persona.prefix}
                </Button>
              ) : (
                <button
                  type="button"
                  aria-label={`Delete ${persona.label}`}
                  data-testid="custom-agent-delete"
                  onClick={() => setConfirming(persona.name)}
                  className="grid size-8 shrink-0 place-items-center rounded-lg text-text-faint transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  <HugeiconsIcon icon={Delete02Icon} className="size-4" strokeWidth={1.6} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {error ? (
        <span data-testid="custom-agents-error" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}

      {usable.length === 0 ? (
        <p data-testid="custom-agents-blocked" className="text-[13px] text-text-faint">
          No AI provider is available on this machine, so there is nothing for a custom agent to
          run. Install one, or switch one on above.
        </p>
      ) : personas.length >= MAX_PERSONAS ? (
        <p data-testid="custom-agents-full" className="text-[13px] text-text-faint">
          You have {MAX_PERSONAS} custom agents, which is as many as the “@” list can offer
          beside the people of a thread. Remove one to add another.
        </p>
      ) : (
        <div>
          <Button
            size="sm"
            variant="outline"
            data-testid="add-custom-agent"
            onClick={() => setEditing("new")}
          >
            <HugeiconsIcon icon={PlusSignIcon} className="size-4" strokeWidth={1.8} />
            Add custom agent
          </Button>
        </div>
      )}

      <CustomAgentDialog
        editing={editing}
        onClose={() => setEditing(null)}
      />
    </section>
  );
}

/**
 * The one form that makes a custom agent and the one that changes it — deliberately the same
 * component, because they collect the same five things and two forms would drift.
 *
 * The NAME is the one field an edit cannot move: it is the address the agent answers to and
 * the key the row is stored under, so renaming it would silently leave every `@bebou` already
 * written pointing at nothing while a second row appeared. The user removes and remakes
 * instead, which is what they mean by it.
 */
function CustomAgentDialog(props: { editing: AgentPersona | "new" | null; onClose: () => void }) {
  const controller = useController();
  const agent = useAppState((s) => s.agent);
  const open = props.editing !== null;
  const existing = props.editing === "new" ? null : props.editing;

  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [backend, setBackend] = useState("");
  const [model, setModel] = useState("");
  const [preprompt, setPreprompt] = useState("");
  /** The picture picked in this session: base64 to send, and a URL to preview. Absent means
   *  "say nothing about the face", which is what leaves an existing one alone. */
  const [picked, setPicked] = useState<{ dataBase64: string; previewUrl: string } | null>(null);
  /** Whether the user asked for the existing face to GO. Apart from `picked`, because
   *  clearing and replacing are two different things to send. */
  const [cleared, setCleared] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const nameField = useRef<HTMLInputElement>(null);

  const providers = availableBackends(agent);
  const offered = providers.length > 0 ? providers : (agent?.backends ?? []);

  // Fill the form from whatever is being edited, every time it opens. A stale field is
  // worse here than anywhere else in Settings: the preprompt is prose, and a form that
  // opened on the previous agent's would be saved over this one's.
  useEffect(() => {
    if (!open) return;
    setName(existing?.name ?? "");
    setLabel(existing?.label ?? "");
    setBackend(existing?.backend ?? offered[0]?.name ?? "");
    setModel(existing?.model ?? "");
    setPreprompt(existing?.preprompt ?? "");
    setPicked(null);
    setCleared(false);
    setError(null);
    // `offered` is read for its first entry only, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing?.name]);

  const nameProblem = open ? personaNameProblem(agent, name, existing?.name ?? null) : null;
  const chosen = offered.find((provider) => provider.name === backend) ?? null;
  const canSave = !!name && !nameProblem && !!backend && !saving;

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      // The composer's own loader: it checks the TYPES and the 10 MB ceiling in its own
      // sentences, so nothing here type-checks a file twice to say the same thing. The
      // backend measures the bytes it really receives (`agent_persona::measure_avatar`),
      // which is the check that holds.
      const image = await loadComposerImage(file);
      setPicked({ dataBase64: image.dataBase64, previewUrl: image.previewUrl });
      setCleared(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that image.");
    }
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const patch: AgentPersonaPatch = {
      name,
      backend,
      label: label.trim(),
      model: model.trim(),
      preprompt,
    };
    // THREE answers, and only two of them are sent: a picked picture replaces, an explicit
    // clear empties, and saying nothing leaves the face alone.
    if (picked) patch.avatar_base64 = picked.dataBase64;
    else if (cleared) patch.avatar_base64 = "";
    try {
      await controller.saveAgentPersona(patch);
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const facePreview = picked?.previewUrl ?? null;
  const hasFace = !!picked || (!cleared && existing?.has_avatar === true);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && props.onClose()}>
      <DialogContent
        data-testid="custom-agent-dialog"
        className="max-w-md"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          nameField.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{existing ? `Edit ${existing.label}` : "Add custom agent"}</DialogTitle>
          <DialogDescription>
            An agent of your own, running one of this machine's AI providers.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3">
            {/* The face, and the mark it falls back to — which is the provider's, so the
                dialog shows exactly what a message will show before anything is saved. */}
            <button
              type="button"
              data-testid="custom-agent-face"
              onClick={() => fileInput.current?.click()}
              className={cn(
                "grid size-16 shrink-0 place-items-center overflow-hidden rounded-xl border border-dashed border-border transition-colors hover:border-text-dim",
                hasFace && "border-solid",
              )}
            >
              {facePreview ? (
                <img src={facePreview} alt="" className="size-full object-cover" />
              ) : hasFace && existing ? (
                <AgentMark
                  backend={backend || existing.backend}
                  persona={existing.name}
                  className="size-full"
                />
              ) : backend ? (
                <AgentMark backend={backend} className="size-8" />
              ) : (
                <HugeiconsIcon
                  icon={ImageUpload01Icon}
                  className="size-6 text-text-faint"
                  strokeWidth={1.5}
                />
              )}
            </button>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="text-[13px] text-text-dim">Picture</span>
              <span className="text-[11px] leading-snug text-text-faint">
                Optional — without one it wears the mark of the provider it runs.
              </span>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()}>
                  Choose…
                </Button>
                {hasFace ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="custom-agent-face-clear"
                    onClick={() => {
                      setPicked(null);
                      setCleared(true);
                    }}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              hidden
              onChange={(e) => void pickFile(e.target.files?.[0])}
            />
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] text-text-dim">Name</span>
            <Input
              ref={nameField}
              value={name}
              // The address is repaired as it is typed — "@Review Bot" is `review-bot` —
              // because refusing a capital teaches the charset one keystroke at a time.
              onChange={(e) => setName(personaNameFrom(e.target.value))}
              // The name IS the address, so an edit cannot move it: every `@bebou` already
              // written would point at nothing while a second row appeared.
              disabled={!!existing}
              placeholder="bebou"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              data-testid="custom-agent-name"
            />
            <span className="text-[11px] text-text-faint">
              {existing
                ? `Written ${existing.prefix} in a conversation. A name cannot be changed — remove the agent and make another.`
                : name
                  ? `Written @${name} in a conversation.`
                  : "What you type after the @."}
            </span>
            {nameProblem && name ? (
              <span data-testid="custom-agent-name-error" className="text-[11px] text-destructive">
                {nameProblem}
              </span>
            ) : null}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] text-text-dim">Display name</span>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value.slice(0, MAX_PERSONA_LABEL_CHARS))}
              placeholder={name || "Bebou"}
              data-testid="custom-agent-label"
            />
            <span className="text-[11px] text-text-faint">
              Optional — how it is named above its answers. Blank uses the name itself.
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] text-text-dim">Runs on</span>
            <select
              value={backend}
              onChange={(e) => {
                setBackend(e.target.value);
                // A model belongs to ONE provider — `opus` means nothing to opencode, whose
                // models are `provider/model` — so changing the base drops it rather than
                // carrying over a name the new CLI would refuse.
                setModel("");
              }}
              data-testid="custom-agent-backend"
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {offered.map((provider) => (
                <option key={provider.name} value={provider.name}>
                  {agentBackendLabel(provider.name)}
                  {provider.available ? "" : " — not installed here"}
                </option>
              ))}
            </select>
            {chosen && !chosen.available ? (
              <span data-testid="custom-agent-backend-missing" className="text-[11px] text-text-faint">
                That provider has no CLI on this machine, so this agent will not answer until it
                does.
              </span>
            ) : null}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] text-text-dim">Model</span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              data-testid="custom-agent-model"
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {/* Inheriting is the DEFAULT and the first row: a persona is usually only a
                  character, and one that restated the model would go stale the day the user
                  changes it in AI providers above. */}
              <option value="">Whatever {agentBackendLabel(backend)} is set to</option>
              {(chosen?.models ?? []).map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
              {/* A model this machine's catalogue no longer lists is still what is stored, so
                  the picker keeps it rather than silently showing "inherit". */}
              {model && !(chosen?.models ?? []).some((choice) => choice.id === model) ? (
                <option value={model}>{model}</option>
              ) : null}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] text-text-dim">Instructions</span>
            <textarea
              value={preprompt}
              onChange={(e) => setPreprompt(e.target.value.slice(0, MAX_PERSONA_PREPROMPT_CHARS))}
              rows={5}
              placeholder="/bebou"
              data-testid="custom-agent-preprompt"
              className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-[13px] leading-snug text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <span className="text-[11px] leading-snug text-text-faint">
              Put in front of every request this agent answers, and shown in no message. A skill
              or command works here — <code className="text-[11px]">/bebou</code> — and so does
              plain prose.
            </span>
          </label>

          {error ? (
            <span data-testid="custom-agent-dialog-error" className="text-xs text-destructive">
              {error}
            </span>
          ) : null}

          <div className="flex items-center gap-2">
            <Button size="sm" disabled={!canSave} onClick={() => void save()} data-testid="custom-agent-save">
              {existing ? "Save" : "Add agent"}
            </Button>
            <Button size="sm" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
