/**
 * Signing the agent CLIs in, in Settings › AI providers — with no terminal anywhere
 * (src/agent_auth.rs is the backend's half, lib/agent-auth.ts the pure one).
 *
 * Three pieces, each drawn where it is decided:
 *
 * - **Claude Code's way in** sits in its own row: a Claude account, an Anthropic API key, a cloud
 *   account, or the machine's own setup. The Claude account is Claude Code's OWN `claude auth
 *   login`, run behind the scenes: the page shows the claude.com link it printed, the reader signs
 *   in there in their own browser, and pastes back the code claude.com shows. The page never sees a
 *   password, and the code is worthless to anything but the waiting CLI (PKCE). A method that needs
 *   something set up first opens the form that collects it, and choosing it is the form's Save.
 * - **opencode's provider keys** sit in its row: written into opencode's own credentials file, so
 *   opencode treats them as keys it stored itself. Its OAuth logins stay its own.
 * - **Cloud accounts** — Amazon Bedrock, Google Vertex AI, Microsoft Foundry — sit under the list,
 *   because they belong to the machine rather than to one CLI: Claude Code runs on one when it is
 *   chosen above, and opencode reaches Bedrock and Vertex models through them.
 *
 * Every secret field is write-only: the backend says whether a key is held and never sends one, so
 * a form left empty keeps the stored key, and says so in its placeholder.
 */

import { useEffect, useState, type ReactNode } from "react";
import type { AgentAuth, AgentAuthPatch, AgentBackend, BedrockKind, ClaudeMethod } from "~/lib/agent";
import {
  BEDROCK_KINDS,
  CLAUDE_METHODS,
  CLOUD_LABELS,
  OPENCODE_KEY_PROVIDERS,
  agentAccountKind,
  claudeAccountApplies,
  claudeAccountLine,
  claudeMethodNeeds,
  claudeMachineOutranksAccount,
  claudeMethodOption,
  claudeSignedInWithAccount,
  cloudInUse,
  cloudSummary,
  isOpencodeProviderId,
  opencodeBedrockKeyWins,
  opencodeCloudLabels,
  opencodeCredentialKind,
  opencodeProviderLabel,
  type CloudKind,
} from "~/lib/agent-auth";
import { cn } from "~/lib/utils";
import { useAppState, useController } from "./controller-context";
import { FadeArc } from "./loading-ui/fade-arc";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const SELECT_CLASS = cn(
  "h-9 w-full cursor-pointer rounded-lg bg-card px-2.5 text-sm text-foreground shadow-chip outline-none",
  "focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
);

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** One labelled field. */
function Field(props: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-text-faint">{props.label}</span>
      {props.children}
      {props.hint && <span className="text-[11px] text-text-faint">{props.hint}</span>}
    </label>
  );
}

function ErrorLine(props: { error: string | null; testid?: string }) {
  if (!props.error) return null;
  return (
    <span data-testid={props.testid ?? "agent-account-error"} className="text-xs text-destructive">
      {props.error}
    </span>
  );
}

/** How one provider signs in — drawn in its own row, once the CLI is on the machine. */
export function AgentAccountSection(props: { backend: AgentBackend }) {
  const auth = useAppState((s) => s.agent?.auth);
  const kind = agentAccountKind(props.backend);
  if (kind === "claude" && auth) return <ClaudeAccountSection backend={props.backend} auth={auth} />;
  if (kind === "opencode") return <OpencodeAccountSection backend={props.backend} auth={auth} />;
  return null;
}

// ---- Claude Code --------------------------------------------------------------------------------

function ClaudeAccountSection(props: { backend: AgentBackend; auth: AgentAuth }) {
  const controller = useController();
  const { backend, auth } = props;
  const account = backend.account ?? null;
  const signin = account?.signin ?? null;
  const signedIn = claudeSignedInWithAccount(account?.account);

  // A method that needs setting up first is held here while its form is open; choosing it IS
  // that form's Save, so the stored method never names something the backend would refuse.
  const [pending, setPending] = useState<ClaudeMethod | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [replacingKey, setReplacingKey] = useState(false);

  // A pending method whose piece now exists — set up in Cloud accounts meanwhile, or by another
  // page — has nothing left to collect: the stored method is what is shown again, and the choice
  // is the reader's to make once more, in one press now.
  const needs = pending ? claudeMethodNeeds(pending, auth) : null;
  const pendingOpen = pending !== null && needs !== null;
  const shown = pendingOpen ? pending : auth.claude_method;
  useEffect(() => {
    if (pending !== null && needs === null) setPending(null);
  }, [pending, needs]);
  // A code belongs to ONE sign-in: a new one, a cancelled one or a refused one starts empty.
  const signinKey = signin?.started_ms ?? null;
  useEffect(() => {
    setCode("");
  }, [signinKey]);

  const run = async (what: string, call: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      await call();
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const save = async (patch: AgentAuthPatch) => {
    const ok = await run("save", () => controller.setAgentAuth(patch));
    if (ok) {
      setPending(null);
      setReplacingKey(false);
    }
    return ok;
  };

  const choose = (method: ClaudeMethod) => {
    setError(null);
    if (method === auth.claude_method) {
      setPending(null);
      return;
    }
    if (claudeMethodNeeds(method, auth)) {
      setPending(method);
      return;
    }
    void save({ claude_method: method });
  };

  const startSignin = (console: boolean) =>
    void run(console ? "console" : "start", () =>
      controller.startAgentSignin(backend.name, console ? "console" : "claude_ai"),
    );

  const finishSignin = async () => {
    await run("finish", () => controller.finishAgentSignin(backend.name, code));
    setCode("");
  };

  return (
    <div
      data-testid="agent-account"
      data-provider={backend.name}
      data-method={auth.claude_method}
      className="flex flex-col gap-2"
    >
      <Field label="Signs in with" hint={claudeMethodOption(shown).detail}>
        <select
          data-testid="claude-method"
          className={SELECT_CLASS}
          value={shown}
          disabled={busy !== null}
          onChange={(event) => choose(event.target.value as ClaudeMethod)}
        >
          {CLAUDE_METHODS.map((option) => (
            <option key={option.method} value={option.method}>
              {option.label}
              {claudeMethodNeeds(option.method, auth) ? " — set up first" : ""}
            </option>
          ))}
        </select>
      </Field>

      {!pendingOpen && (
        <p data-testid="claude-account-line" className="text-[12px] text-text-dim">
          {claudeAccountLine(account)}
        </p>
      )}

      {/* The form a pending method needs. Its Save stores the piece AND the method together. */}
      {needs === "key" && (
        <ApiKeyForm
          busy={busy === "save"}
          onCancel={() => setPending(null)}
          onSave={(key) => save({ anthropic_key: key, claude_method: "api_key" })}
        />
      )}
      {needs && needs !== "key" && (
        <CloudForm
          kind={needs}
          auth={auth}
          busy={busy === "save"}
          submitLabel={`Save and use ${CLOUD_LABELS[needs]}`}
          onCancel={() => setPending(null)}
          onSave={(patch) => save({ ...patch, claude_method: needs })}
        />
      )}

      {!pendingOpen && auth.claude_method === "api_key" && (
        replacingKey ? (
          <ApiKeyForm
            busy={busy === "save"}
            onCancel={() => setReplacingKey(false)}
            onSave={(key) => save({ anthropic_key: key })}
          />
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-text-faint">An API key is saved.</span>
            <Button
              data-testid="claude-api-key-replace"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => setReplacingKey(true)}
            >
              Replace it
            </Button>
          </div>
        )
      )}

      {/* The Claude account: Claude Code's own sign-in, presented as two steps on this page. */}
      {/* Under the machine's own setup, a way in that ranks above the account says so rather than
          offering a sign-in that would never take effect. */}
      {!pendingOpen && auth.claude_method === "machine" && claudeMachineOutranksAccount(account?.account) && (
        <p data-testid="claude-account-outranked" className="text-[11px] text-text-faint">
          A Claude account would not be used here: this machine&apos;s own setup signs Claude Code in
          another way. Choose &ldquo;Claude account&rdquo; above to sign one in instead.
        </p>
      )}

      {!pendingOpen && claudeAccountApplies(auth.claude_method, account?.account) && (
        signin ? (
          <div
            data-testid="claude-signin"
            data-finishing={signin.finishing}
            className="flex flex-col gap-2.5 rounded-lg bg-element/60 p-3"
          >
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-foreground">
                1. Sign in on claude.com
              </span>
              <a
                data-testid="claude-signin-link"
                href={signin.url}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "inline-flex h-8 w-fit items-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground shadow-chip",
                  "hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                Open claude.com
              </a>
              <span className="text-[11px] text-text-faint">
                {signin.console
                  ? "Sign in to your Anthropic Console account there. "
                  : "Sign in with your Claude account there. "}
                It opens in your own browser — this app never sees your password.
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-foreground">
                2. Paste the code claude.com shows you
              </span>
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void finishSignin();
                }}
              >
                <Input
                  data-testid="claude-signin-code"
                  // 16px under a thumb, so iOS does not zoom the page in when the field takes focus.
                  className="min-w-0 flex-1 font-mono text-base sm:text-[13px]"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="Code"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={signin.finishing || busy !== null}
                />
                <Button
                  data-testid="claude-signin-finish"
                  type="submit"
                  size="sm"
                  disabled={!code.trim() || signin.finishing || busy !== null}
                >
                  {busy === "finish" || signin.finishing ? <FadeArc className="size-4" /> : "Finish signing in"}
                </Button>
              </form>
            </div>
            <Button
              data-testid="claude-signin-cancel"
              variant="ghost"
              size="sm"
              className="h-7 w-fit px-2 text-[11px]"
              disabled={signin.finishing || busy !== null}
              onClick={() => void run("cancel", () => controller.cancelAgentSignin(backend.name))}
            >
              Cancel
            </Button>
          </div>
        ) : signedIn ? (
          <Button
            data-testid="claude-signout"
            variant="ghost"
            size="sm"
            className="h-7 w-fit px-2 text-[11px]"
            disabled={busy !== null}
            onClick={() => void run("signout", () => controller.signOutAgent(backend.name))}
          >
            {busy === "signout" ? <FadeArc className="size-3.5" /> : "Sign out"}
          </Button>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              data-testid="claude-signin-start"
              size="sm"
              disabled={busy !== null}
              onClick={() => startSignin(false)}
            >
              {busy === "start" ? <FadeArc className="size-4" /> : "Sign in with Claude"}
            </Button>
            <Button
              data-testid="claude-signin-console"
              variant="ghost"
              size="sm"
              className="text-[12px]"
              disabled={busy !== null}
              onClick={() => startSignin(true)}
            >
              {busy === "console" ? <FadeArc className="size-4" /> : "Use an Anthropic Console account"}
            </Button>
          </div>
        )
      )}

      <ErrorLine error={error} />
    </div>
  );
}

function ApiKeyForm(props: { busy: boolean; onSave: (key: string) => void; onCancel: () => void }) {
  const [key, setKey] = useState("");
  return (
    <form
      data-testid="claude-api-key-form"
      className="flex flex-col gap-2 rounded-lg bg-element/60 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSave(key);
      }}
    >
      <Field label="Anthropic API key" hint="From platform.claude.com › API keys. It is kept on this machine.">
        <Input
          data-testid="claude-api-key"
          type="password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder="sk-ant-…"
          autoComplete="off"
        />
      </Field>
      <FormButtons busy={props.busy} disabled={!key.trim()} label="Save key" onCancel={props.onCancel} />
    </form>
  );
}

function FormButtons(props: { busy: boolean; disabled: boolean; label: string; onCancel: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <Button data-testid="agent-account-save" type="submit" size="sm" disabled={props.busy || props.disabled}>
        {props.busy ? <FadeArc className="size-4" /> : props.label}
      </Button>
      <Button type="button" variant="ghost" size="sm" disabled={props.busy} onClick={props.onCancel}>
        Cancel
      </Button>
    </div>
  );
}

// ---- opencode -----------------------------------------------------------------------------------

function OpencodeAccountSection(props: { backend: AgentBackend; auth: AgentAuth | undefined }) {
  const controller = useController();
  const credentials = props.backend.account?.credentials ?? [];
  const clouds = opencodeCloudLabels(props.auth);
  const bedrockKeyWins = opencodeBedrockKeyWins(props.auth, credentials);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (what: string, call: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      await call();
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-testid="agent-account" data-provider={props.backend.name} className="flex flex-col gap-2">
      <span className="text-[11px] font-medium text-text-faint">Provider keys</span>
      {credentials.length === 0 ? (
        <p data-testid="opencode-credentials-empty" className="text-[12px] text-text-dim">
          opencode holds no provider key yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {credentials.map((credential) => (
            <li
              key={credential.provider}
              data-testid="opencode-credential"
              data-provider={credential.provider}
              data-kind={credential.kind}
              className="flex items-center justify-between gap-2 text-[12px]"
            >
              <span className="min-w-0 truncate text-foreground">
                {opencodeProviderLabel(credential.provider)}
                <span className="ml-2 text-[11px] text-text-faint">{opencodeCredentialKind(credential)}</span>
              </span>
              <Button
                data-testid="opencode-credential-remove"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                disabled={busy !== null}
                onClick={() =>
                  void run(`remove:${credential.provider}`, () =>
                    controller.removeOpencodeKey(credential.provider),
                  )
                }
              >
                {busy === `remove:${credential.provider}` ? <FadeArc className="size-3.5" /> : "Remove"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {clouds.length > 0 && (
        <p data-testid="opencode-cloud-line" className="text-[11px] text-text-faint">
          Its {clouds.join(" and ")} models use the cloud {clouds.length > 1 ? "accounts" : "account"} set
          up below
          {bedrockKeyWins
            ? " — except Amazon Bedrock: its own Bedrock API key above comes first, so that key is what its Bedrock models use."
            : "."}
        </p>
      )}
      {adding ? (
        <OpencodeKeyForm
          busy={busy === "add"}
          onCancel={() => setAdding(false)}
          onSave={async (providerId, key) => {
            const ok = await run("add", () => controller.setOpencodeKey(providerId, key));
            if (ok) setAdding(false);
          }}
        />
      ) : (
        <Button
          data-testid="opencode-key-add"
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={busy !== null}
          onClick={() => setAdding(true)}
        >
          Add an API key
        </Button>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

function OpencodeKeyForm(props: {
  busy: boolean;
  onSave: (providerId: string, key: string) => void;
  onCancel: () => void;
}) {
  const [provider, setProvider] = useState(OPENCODE_KEY_PROVIDERS[0]!.id);
  const [other, setOther] = useState("");
  const [key, setKey] = useState("");
  const id = provider === "other" ? other.trim() : provider;
  const idOk = isOpencodeProviderId(id);
  return (
    <form
      data-testid="opencode-key-form"
      className="flex flex-col gap-2 rounded-lg bg-element/60 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSave(id, key);
      }}
    >
      <Field label="Provider">
        <select
          data-testid="opencode-key-provider"
          className={SELECT_CLASS}
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
        >
          {OPENCODE_KEY_PROVIDERS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
          <option value="other">Another provider…</option>
        </select>
      </Field>
      {provider === "other" && (
        <Field label="Provider id" hint="As opencode and models.dev spell it, like together or fireworks-ai.">
          <Input
            data-testid="opencode-key-id"
            value={other}
            onChange={(event) => setOther(event.target.value)}
            placeholder="provider-id"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      )}
      <Field label="API key">
        <Input
          data-testid="opencode-key-value"
          type="password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          autoComplete="off"
        />
      </Field>
      <FormButtons busy={props.busy} disabled={!idOk || !key.trim()} label="Save key" onCancel={props.onCancel} />
    </form>
  );
}

// ---- cloud accounts -----------------------------------------------------------------------------

const CLOUD_KINDS: readonly CloudKind[] = ["bedrock", "vertex", "foundry"];

/** The machine's cloud accounts, under the provider list. */
export function CloudAccounts() {
  const auth = useAppState((s) => s.agent?.auth);
  if (!auth) return null;
  return (
    <div data-testid="cloud-accounts" className="flex flex-col rounded-xl bg-card shadow-chip">
      <div className="flex flex-col gap-0.5 p-4 pb-2">
        <span className="text-[13px] font-medium text-foreground">Cloud accounts</span>
        <span className="text-[11px] text-text-faint">
          Set one up once. Claude Code runs on it when you choose it above, and opencode reaches
          Amazon Bedrock and Google Vertex AI models through them.
        </span>
      </div>
      {CLOUD_KINDS.map((kind) => (
        <CloudAccountRow key={kind} kind={kind} auth={auth} />
      ))}
    </div>
  );
}

function CloudAccountRow(props: { kind: CloudKind; auth: AgentAuth }) {
  const controller = useController();
  const { kind, auth } = props;
  const summary = cloudSummary(kind, auth);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (patch: AgentAuthPatch) => {
    setBusy(true);
    setError(null);
    try {
      await controller.setAgentAuth(patch);
      setEditing(false);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="cloud-account"
      data-kind={kind}
      data-configured={summary !== null}
      className="flex flex-col gap-2 border-t border-border-subtle p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="text-[13px] text-foreground">{CLOUD_LABELS[kind]}</span>
          <span data-testid="cloud-account-summary" className="truncate text-[11px] text-text-faint">
            {summary ?? "Not set up"}
            {cloudInUse(kind, auth) ? " · Claude Code runs on it" : ""}
          </span>
        </div>
        {!editing && (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              data-testid="cloud-account-edit"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setEditing(true)}
            >
              {summary ? "Edit" : "Set up"}
            </Button>
            {summary && (
              <Button
                data-testid="cloud-account-remove"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void save({ [kind]: null })}
              >
                Remove
              </Button>
            )}
          </div>
        )}
      </div>
      {editing && (
        <CloudForm
          kind={kind}
          auth={auth}
          busy={busy}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSave={save}
        />
      )}
      <ErrorLine error={error} />
    </div>
  );
}

/** The form one cloud account is set up with. A secret left empty keeps the stored one. */
function CloudForm(props: {
  kind: CloudKind;
  auth: AgentAuth;
  busy: boolean;
  submitLabel: string;
  onSave: (patch: AgentAuthPatch) => void;
  onCancel: () => void;
}) {
  if (props.kind === "bedrock") return <BedrockForm {...props} />;
  if (props.kind === "vertex") return <VertexForm {...props} />;
  return <FoundryForm {...props} />;
}

type FormProps = {
  auth: AgentAuth;
  busy: boolean;
  submitLabel: string;
  onSave: (patch: AgentAuthPatch) => void;
  onCancel: () => void;
};

const KEEP = "Leave empty to keep the saved one";

function BedrockForm(props: FormProps) {
  const current = props.auth.bedrock;
  const [region, setRegion] = useState(current?.region ?? "");
  const [kind, setKind] = useState<BedrockKind>(current?.kind ?? "api_key");
  const [apiKey, setApiKey] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [dropToken, setDropToken] = useState(false);
  const [profile, setProfile] = useState(current?.profile ?? "");
  const sameKind = current?.kind === kind;
  // A NEW access key ID needs its own secret: the stored one belongs to the stored ID.
  const newId = accessKeyId.trim() !== "";

  const ready =
    region.trim() !== "" &&
    (kind === "api_key"
      ? apiKey.trim() !== "" || sameKind
      : kind === "profile"
        ? profile.trim() !== ""
        : sameKind
          ? !newId || secret.trim() !== ""
          : newId && secret.trim() !== "");

  const submit = () => {
    const patch: NonNullable<AgentAuthPatch["bedrock"]> = { region: region.trim(), kind };
    if (kind === "api_key" && apiKey.trim()) patch.api_key = apiKey.trim();
    if (kind === "profile") patch.profile = profile.trim();
    if (kind === "access_key") {
      // Left empty on an edit, the stored ID and its secret are kept.
      if (newId) patch.access_key_id = accessKeyId.trim();
      if (secret.trim()) patch.secret_access_key = secret.trim();
      if (sessionToken.trim()) patch.session_token = sessionToken.trim();
      else if (dropToken) patch.session_token = null;
    }
    props.onSave({ bedrock: patch });
  };

  return (
    <form
      data-testid="cloud-form"
      data-kind="bedrock"
      className="flex flex-col gap-2 rounded-lg bg-element/60 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Field label="AWS region" hint="Where Bedrock runs Claude for you, like us-east-1 or eu-west-3.">
        <Input
          data-testid="bedrock-region"
          value={region}
          onChange={(event) => setRegion(event.target.value)}
          placeholder="us-east-1"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <Field label="Authenticate with">
        <select
          data-testid="bedrock-kind"
          className={SELECT_CLASS}
          value={kind}
          onChange={(event) => setKind(event.target.value as BedrockKind)}
        >
          {BEDROCK_KINDS.map((option) => (
            <option key={option.kind} value={option.kind}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>
      {kind === "api_key" && (
        <Field label="Bedrock API key" hint="Created in the Amazon Bedrock console, under API keys.">
          <Input
            data-testid="bedrock-api-key"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={sameKind ? KEEP : ""}
            autoComplete="off"
          />
        </Field>
      )}
      {kind === "access_key" && (
        <>
          <Field label="Access key ID">
            <Input
              data-testid="bedrock-access-key-id"
              value={accessKeyId}
              onChange={(event) => setAccessKeyId(event.target.value)}
              placeholder={
                sameKind && current?.access_key_id_tail
                  ? `…${current.access_key_id_tail} — leave empty to keep it`
                  : "AKIA…"
              }
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Secret access key">
            <Input
              data-testid="bedrock-secret"
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder={sameKind ? KEEP : ""}
              autoComplete="off"
            />
          </Field>
          <Field label="Session token (temporary credentials only)">
            <Input
              data-testid="bedrock-session-token"
              type="password"
              value={sessionToken}
              onChange={(event) => setSessionToken(event.target.value)}
              autoComplete="off"
            />
          </Field>
          {sameKind && current?.session_token && !sessionToken.trim() && (
            <label className="flex items-center gap-2 text-[11px] text-text-dim">
              <input
                data-testid="bedrock-drop-session-token"
                type="checkbox"
                checked={dropToken}
                onChange={(event) => setDropToken(event.target.checked)}
              />
              Remove the saved session token
            </label>
          )}
        </>
      )}
      {kind === "profile" && (
        <Field label="Profile name" hint="A profile in the AWS files of the CLI's home on this machine.">
          <Input
            data-testid="bedrock-profile"
            value={profile}
            onChange={(event) => setProfile(event.target.value)}
            placeholder="default"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      )}
      <FormButtons busy={props.busy} disabled={!ready} label={props.submitLabel} onCancel={props.onCancel} />
    </form>
  );
}

function VertexForm(props: FormProps) {
  const current = props.auth.vertex;
  const [project, setProject] = useState(current?.project ?? "");
  const [region, setRegion] = useState(current?.region ?? "global");
  const [useKeyFile, setUseKeyFile] = useState(current ? current.service_account !== null : true);
  const [keyFile, setKeyFile] = useState<{ name: string; text: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const hasSavedKey = Boolean(current?.service_account);

  const ready = project.trim() !== "" && region.trim() !== "" && (!useKeyFile || keyFile !== null || hasSavedKey);

  const submit = () => {
    const patch: NonNullable<AgentAuthPatch["vertex"]> = { project: project.trim(), region: region.trim() };
    if (!useKeyFile) patch.service_account = null;
    else if (keyFile) patch.service_account = keyFile.text;
    props.onSave({ vertex: patch });
  };

  return (
    <form
      data-testid="cloud-form"
      data-kind="vertex"
      className="flex flex-col gap-2 rounded-lg bg-element/60 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Field label="Google Cloud project ID">
        <Input
          data-testid="vertex-project"
          value={project}
          onChange={(event) => setProject(event.target.value)}
          placeholder="my-project"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <Field label="Location" hint="global, a multi-region (us, eu) or a region like us-east5.">
        <Input
          data-testid="vertex-region"
          value={region}
          onChange={(event) => setRegion(event.target.value)}
          placeholder="global"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <Field label="Credentials">
        <select
          data-testid="vertex-credentials"
          className={SELECT_CLASS}
          value={useKeyFile ? "key" : "adc"}
          onChange={(event) => setUseKeyFile(event.target.value === "key")}
        >
          <option value="key">A service-account key file</option>
          <option value="adc">Application Default Credentials of the CLI&apos;s home</option>
        </select>
      </Field>
      {useKeyFile && (
        <Field
          label="Service-account key (JSON)"
          hint={
            keyFile
              ? `Chosen: ${keyFile.name}`
              : hasSavedKey
                ? `The key for ${current?.service_account} is saved — choose a file to replace it.`
                : "From Google Cloud › IAM › Service accounts › Keys. It is kept on this machine."
          }
        >
          <input
            data-testid="vertex-key-file"
            type="file"
            accept="application/json,.json"
            className="text-[12px] text-text-dim file:mr-2 file:cursor-pointer file:rounded-md file:border-0 file:bg-card file:px-2 file:py-1 file:text-[12px] file:text-foreground file:shadow-chip"
            onChange={(event) => {
              setFileError(null);
              const file = event.target.files?.[0];
              if (!file) return;
              if (file.size > 64 * 1024) {
                setFileError("That file is far larger than a service-account key.");
                return;
              }
              void file.text().then(
                (text) => setKeyFile({ name: file.name, text }),
                (e: unknown) => setFileError(message(e)),
              );
            }}
          />
        </Field>
      )}
      <ErrorLine error={fileError} testid="vertex-key-file-error" />
      <FormButtons busy={props.busy} disabled={!ready} label={props.submitLabel} onCancel={props.onCancel} />
    </form>
  );
}

function FoundryForm(props: FormProps) {
  const current = props.auth.foundry;
  const [resource, setResource] = useState(current?.resource ?? "");
  const [apiKey, setApiKey] = useState("");
  const ready = resource.trim() !== "" && (apiKey.trim() !== "" || Boolean(current));
  return (
    <form
      data-testid="cloud-form"
      data-kind="foundry"
      className="flex flex-col gap-2 rounded-lg bg-element/60 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        const patch: NonNullable<AgentAuthPatch["foundry"]> = { resource: resource.trim() };
        if (apiKey.trim()) patch.api_key = apiKey.trim();
        props.onSave({ foundry: patch });
      }}
    >
      <Field label="Resource name" hint="The name alone, as in https://<name>.services.ai.azure.com.">
        <Input
          data-testid="foundry-resource"
          value={resource}
          onChange={(event) => setResource(event.target.value)}
          placeholder="my-resource"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <Field label="API key" hint="From the resource's Endpoints and keys.">
        <Input
          data-testid="foundry-api-key"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={current ? KEEP : ""}
          autoComplete="off"
        />
      </Field>
      <FormButtons busy={props.busy} disabled={!ready} label={props.submitLabel} onCancel={props.onCancel} />
    </form>
  );
}
