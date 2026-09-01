import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import {
  agentBackendLabel,
  agentModelDetail,
  agentModelLimits,
  agentModelNamed,
  type AgentBackend,
  type AgentModel,
} from "~/lib/agent";
import { cn } from "~/lib/utils";
import { AgentLogo, modelMark } from "./agent-logo";
import { FadeArc } from "./loading-ui/fade-arc";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

/**
 * Which model one AI provider runs — the picker in Settings › AI providers.
 *
 * It is a select over the models the BACKEND offers, because that list is the
 * machine's own: `agent_models::choices` reads opencode's catalogue and keeps the
 * providers this machine authenticated, so a hundred-odd entries here are a hundred
 * models this machine can really run. Each one reads as a model — its vendor's mark,
 * the vendor's name for it, and what it holds — instead of the `provider/model` id the
 * CLI wants.
 *
 * Three rules hold it together:
 *
 * - **A choice saves itself.** Picking a model IS the write; there is no Save button to
 *   press and no "Saved" line to read, because the list closes on the choice the
 *   backend then confirms. What the trigger shows is always the stored model — a
 *   refused write leaves the old one on screen rather than a hopeful local guess.
 * - **The list never becomes the limit.** The search field doubles as the free-form
 *   entry the RPC has always accepted (`agent_policy::is_valid_model`): whatever is
 *   typed is offered as its own entry, so a model too new for this machine's catalogue
 *   is still reachable. A fixed dropdown would be wrong on the next machine.
 * - **The default is an entry, not an empty state.** "Default" is the first row and
 *   says what it means — the CLI's own configured model — so going back to it is one
 *   click rather than clearing a field.
 */
export function AgentModelSelect(props: {
  backend: AgentBackend;
  /** True while a write is in flight, so the control cannot start a second one. */
  busy: boolean;
  /** A model id, or "" for the CLI's own default. */
  onChoose: (model: string) => void;
}) {
  const { backend, busy } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const label = agentBackendLabel(backend.name);
  const stored = backend.model ?? "";
  const chosen = agentModelNamed(backend, backend.model);
  const typed = query.trim();
  // An exact id is already in the list, so offering to "use" it again would be a
  // second row for the same model.
  const offerTyped = typed.length > 0 && !backend.models.some((model) => model.id === typed);

  const choose = (model: string) => {
    setOpen(false);
    setQuery("");
    if (model !== stored) props.onChoose(model);
  };

  /** Group by vendor, in the order the backend listed them — it sorted by vendor
   *  already, so this keeps that order rather than inventing another. */
  const vendors: { label: string; models: AgentModel[] }[] = [];
  for (const model of backend.models) {
    const last = vendors[vendors.length - 1];
    if (last && last.label === model.vendor_label) last.models.push(model);
    else vendors.push({ label: model.vendor_label, models: [model] });
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={`Model for ${label}`}
          data-testid="ai-provider-model-select"
          data-value={stored}
          disabled={busy}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-lg bg-element px-2.5 py-2 text-left transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            busy ? "cursor-wait opacity-60" : "cursor-pointer hover:bg-accent",
          )}
        >
          {chosen ? (
            <AgentLogo backend={modelMark(backend.name, chosen)} className="size-4 shrink-0" />
          ) : (
            <AgentLogo backend={backend.name} className="size-4 shrink-0" />
          )}
          <span className="flex min-w-0 flex-col">
            <span
              className={cn(
                "truncate text-[13px] font-medium text-foreground",
                !chosen && stored !== "" && "font-mono text-[12px]",
              )}
            >
              {chosen ? chosen.label : stored === "" ? "Default" : stored}
            </span>
            <span className="truncate text-[11px] text-text-faint">
              {chosen
                ? agentModelDetail(chosen)
                : stored === ""
                  ? `Whatever ${label} is configured for`
                  : "Not in this machine's list"}
            </span>
          </span>
          {busy ? (
            <FadeArc className="ml-auto size-4 shrink-0 text-text-faint" />
          ) : (
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              className="ml-auto size-4 shrink-0 text-text-faint"
              strokeWidth={1.8}
            />
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-72 p-0"
      >
        <Command
          loop
          className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-text-faint"
        >
          <CommandInput
            data-testid="ai-provider-model-search"
            value={query}
            onValueChange={setQuery}
            placeholder="Search models, or type a model id"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <CommandList>
            {/* Only when there is nothing else to offer: the typed entry below is
                force-mounted, so cmdk counts no match while a row is on screen. */}
            {!offerTyped && <CommandEmpty>No model of this machine's goes by that.</CommandEmpty>}

            <CommandGroup>
              <Row
                testid="ai-provider-model-default"
                value="default"
                keywords={["default"]}
                mark={<AgentLogo backend={backend.name} className="size-4 shrink-0" />}
                label="Default"
                detail={`Whatever ${label} is configured for`}
                selected={stored === ""}
                onSelect={() => choose("")}
              />
            </CommandGroup>

            {/* Its own group, force-mounted: cmdk hides a group whose items do not
                match the search, and this row exists precisely because nothing
                matched. */}
            {offerTyped && (
              <CommandGroup forceMount>
                <Row
                  testid="ai-provider-model-custom"
                  value={typed}
                  forceMount
                  mark={<AgentLogo backend={backend.name} className="size-4 shrink-0" />}
                  label={`Use “${typed}”`}
                  detail="A model this machine does not list"
                  mono
                  selected={stored === typed}
                  onSelect={() => choose(typed)}
                />
              </CommandGroup>
            )}

            {vendors.map((vendor) => (
              <CommandGroup key={vendor.label} heading={vendor.label}>
                {vendor.models.map((model) => (
                  <Row
                    key={model.id}
                    testid="ai-provider-model-option"
                    value={model.id}
                    // Searchable by the name a person reads and by the vendor, not
                    // only by the id cmdk matches on.
                    keywords={[model.label, model.vendor_label]}
                    mark={
                      <AgentLogo
                        backend={modelMark(backend.name, model)}
                        className="size-4 shrink-0"
                      />
                    }
                    label={model.label}
                    // The vendor already heads the group, so the row states only
                    // what the reader cannot see above it.
                    detail={agentModelLimits(model)}
                    modelId={model.id}
                    selected={stored === model.id}
                    onSelect={() => choose(model.id)}
                  />
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** One row of the list: the mark, the name, one line of what it is, and a tick when it
 *  is the stored choice. */
function Row(props: {
  testid: string;
  value: string;
  keywords?: string[];
  forceMount?: boolean;
  mark: React.ReactNode;
  label: string;
  detail: string;
  /** The model's own id — the string the CLI is given — shown under the name when it
   *  is not the name itself. It is what a user comparing this pane with their own
   *  `opencode` config reads. */
  modelId?: string;
  mono?: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      data-testid={props.testid}
      data-value={props.value}
      data-chosen={props.selected ? "true" : undefined}
      value={props.value}
      keywords={props.keywords}
      forceMount={props.forceMount}
      onSelect={props.onSelect}
      className="items-start gap-2.5 py-1.5"
    >
      <span className="mt-0.5">{props.mark}</span>
      <span className="flex min-w-0 flex-col">
        <span
          className={cn(
            "truncate text-[13px] text-foreground",
            props.mono && "font-mono text-[12px]",
          )}
        >
          {props.label}
        </span>
        {props.detail && (
          <span className="truncate text-[11px] text-text-faint">{props.detail}</span>
        )}
        {props.modelId && props.modelId !== props.label && (
          <span className="truncate font-mono text-[10px] text-text-faint/80">
            {props.modelId}
          </span>
        )}
      </span>
      {props.selected && (
        <HugeiconsIcon
          icon={CheckmarkCircle02Icon}
          className="ml-auto mt-0.5 size-4 shrink-0 text-primary"
          strokeWidth={1.8}
        />
      )}
    </CommandItem>
  );
}
