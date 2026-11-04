// Decision tests for the Helm chart: what it renders, and what it refuses to render.
//
//     cd packaging/helm && bun test
//
// The chart is the Kubernetes spelling of packaging/docker/compose.yaml (the self-contained,
// EMBEDDED mode, which is the default) and of compose.host-broker.yaml (the host modes), and every
// rule those files hold for a reason holds here for the same one: the embedded pod runs its own
// Intune container on a volume of its own and reaches nothing on the node; a host-mode pod reaches
// the node's broker through the node's /proc as the node's user; it is ONE pod on one store; and
// whatever reaches its web port is handed the write token. So both halves are pinned — the shape
// that works, and the combinations that would deploy and quietly not work, or quietly publish the
// account.
//
// It renders through the real `helm`, because what is under test is the templates, and a second
// renderer would be a second opinion about them. CI installs helm; a machine without it fails
// here rather than skipping, since a test that skips is a test that never runs. The files of the
// image the chart describes are read where a test needs them, never at load, so a file another
// change has not written yet fails the tests about it and only those.

import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHART = join(import.meta.dir, "teams-lite");
const ROOT = join(import.meta.dir, "..", "..");
const STATE = "/home/u/.local/share/intune-container";
// Where the image keeps the Intune container's state, and where an enrollment backup is imported
// from — the paths the image's own files name (asserted against them below).
const INTUNE = "/home/teams/.local/share/intune-container";
const IMPORT = "/run/teams-lite/intune-import/enrollment-backup.tar.gz";
const HOST = { "broker.mode": "intuneContainer", "broker.intuneContainer.stateDir": STATE };
const BUS = { "broker.mode": "sessionBus", "broker.sessionBus.socket": "/run/user/1000/bus" };

type Doc = Record<string, any>;
type Options = { release?: string; kubeVersion?: string; chart?: string; showOnly?: string; valuesFile?: string };

function helm(args: string[]): { ok: boolean; out: string; err: string } {
  let proc;
  try {
    proc = Bun.spawnSync(["helm", ...args], { stdout: "pipe", stderr: "pipe" });
  } catch {
    throw new Error("these tests render the chart with `helm`, and it is not on PATH");
  }
  return { ok: proc.exitCode === 0, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

function templateArgs(set: Record<string, string>, options: Options): string[] {
  const args = ["template", options.release ?? "teams-lite", options.chart ?? CHART, "--namespace", "teams"];
  if (options.kubeVersion) args.push("--kube-version", options.kubeVersion);
  if (options.showOnly) args.push("--show-only", options.showOnly);
  if (options.valuesFile) args.push("-f", options.valuesFile);
  for (const [key, value] of Object.entries(set)) args.push("--set", `${key}=${value}`);
  return args;
}

/** The rendered manifests for `--set` pairs. */
function render(set: Record<string, string> = {}, options: Options = {}): Doc[] {
  const { ok, out, err } = helm(templateArgs(set, options));
  if (!ok) throw new Error(err.trim());
  const parsed = Bun.YAML.parse(out) as Doc | Doc[];
  return (Array.isArray(parsed) ? parsed : [parsed]).filter((doc): doc is Doc => !!doc);
}

/** The error `helm template` stops with, for values it must refuse. */
function refusal(set: Record<string, string>, options: Options = {}): string {
  const { ok, err } = helm(templateArgs(set, options));
  expect(ok).toBe(false);
  return err;
}

/**
 * NOTES.txt as `helm install` would print it, for `--set` pairs — without an install: `helm
 * template` never renders NOTES, so a throwaway copy of the chart renders the very same file
 * through `tpl` into a ConfigMap of its own, with every helper the real NOTES reaches.
 */
function notes(set: Record<string, string> = {}): string {
  const copy = mkdtempSync(join(tmpdir(), "teams-lite-notes-"));
  try {
    cpSync(CHART, copy, { recursive: true });
    cpSync(join(CHART, "templates", "NOTES.txt"), join(copy, "notes-probe.txt"));
    writeFileSync(
      join(copy, "templates", "zz-notes-probe.yaml"),
      [
        "apiVersion: v1",
        "kind: ConfigMap",
        "metadata:",
        "  name: notes-probe",
        "data:",
        '  notes: {{ tpl (.Files.Get "notes-probe.txt") . | quote }}',
        "",
      ].join("\n"),
    );
    const [probe] = render(set, { chart: copy, showOnly: "templates/zz-notes-probe.yaml" });
    return probe.data.notes;
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

const of = (docs: Doc[], kind: string) => docs.filter((doc) => doc.kind === kind);
const statefulSet = (docs: Doc[]) => {
  const all = of(docs, "StatefulSet");
  expect(all).toHaveLength(1);
  return all[0];
};
const pod = (docs: Doc[]) => statefulSet(docs).spec.template.spec;
const container = (docs: Doc[]) => pod(docs).containers[0];
const env = (docs: Doc[]) =>
  Object.fromEntries((container(docs).env ?? []).map((e: Doc) => [e.name, e.value]));
const mount = (docs: Doc[], name: string) =>
  container(docs).volumeMounts.find((m: Doc) => m.name === name);
const volume = (docs: Doc[], name: string) => pod(docs).volumes.find((v: Doc) => v.name === name);
const claims = (docs: Doc[]) => (statefulSet(docs).spec.volumeClaimTemplates ?? []) as Doc[];
const claim = (docs: Doc[], name: string) => claims(docs).find((c) => c.metadata.name === name);

// The image's own files, read where a test needs them.
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const entrypoint = () => read("packaging/docker/entrypoint.sh");

/**
 * Run `body` in `sh` with the image's entrypoint sourced as a LIBRARY — its functions, none of its
 * `main` — which is how the image's own self-test reads it. `args` are the body's `$1`…; what it
 * prints on stdout comes back a line at a time. Nothing here is root, so every act that would need
 * it is stubbed by the body.
 */
function entrypointLibrary(body: string, env: Record<string, string> = {}, args: string[] = []): string[] {
  const { code, out, err } = sourced(join(ROOT, "packaging/docker/entrypoint.sh"), body, env, args);
  if (code !== 0) throw new Error(`sh exited ${code}: ${err.trim()}`);
  return out.split("\n").filter(Boolean);
}

/** `body` run in `sh` after sourcing `file` (as `$0`), with `TEAMS_LITE_CONTAINER_LIBRARY=1`. */
function sourced(file: string, body: string, env: Record<string, string>, args: string[] = []) {
  const script = `TEAMS_LITE_CONTAINER_LIBRARY=1\n. "$0"\n${body}`;
  const proc = Bun.spawnSync(["sh", "-c", script, file, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

/**
 * `body` run after sourcing the image's SELF-TEST for its functions: the script itself ends by
 * calling its own main and sources the entrypoint from where the image installs it, so a copy is
 * sourced with that one call dropped and that one path pointed at the repository's entrypoint —
 * both found exactly once, so the copy cannot quietly differ from the file in any other way.
 */
function selftestLibrary(body: string, env: Record<string, string>) {
  const text = read("packaging/docker/teams-lite-intune-selftest");
  const call = '\nselftest_main "$@"\n';
  const source = "\n. /usr/local/bin/teams-lite-container\n";
  expect(text.endsWith(call)).toBe(true);
  expect(text.split(source)).toHaveLength(2);
  const copy = mkdtempSync(join(tmpdir(), "teams-lite-selftest-"));
  try {
    const file = join(copy, "selftest.sh");
    const library = text
      .slice(0, -call.length + 1)
      .replace(source, `\n. ${JSON.stringify(join(ROOT, "packaging/docker/entrypoint.sh"))}\n`);
    writeFileSync(file, library);
    return sourced(file, body, env);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

/** What `root_stage` does in an environment, every act it can take logged rather than taken. */
const rootStageActs = (env: Record<string, string>) =>
  entrypointLibrary(
    [
      "id() { echo 1000; }",
      'getent() { echo "teams:x:1000:1000::/home/teams:/usr/sbin/nologin"; }',
      'own_dir() { echo "own_dir $1"; }',
      "embedded_preflight() { echo embedded_preflight; }",
      "delegate_cgroup() { echo delegate_cgroup; }",
      "check_id_mapping() { echo check_id_mapping; }",
      "say() { :; }",
      "resolve_mode",
      "root_stage",
    ].join("\n"),
    env,
  );

/**
 * What `own_dir` does to a real directory whose OWNER is stubbed (`denied`: root cannot reach it),
 * its `chown` and its warning logged rather than made.
 */
const ownDirActs = (dir: string, owner: string) =>
  entrypointLibrary(
    [
      "stat() {",
      '  for _a; do :; done',
      '  if [ "$OWNER" = denied ]; then echo "stat: cannot statx $_a: Permission denied" >&2; return 1; fi',
      '  [ -e "$_a" ] || { echo "stat: cannot statx $_a: No such file or directory" >&2; return 1; }',
      '  echo "$OWNER"',
      "}",
      'chown() { echo "chown $*"; }',
      "warn() { echo warn; }",
      "say() { :; }",
      'own_dir "$1" 1000 1000',
    ].join("\n"),
    { OWNER: owner },
    [dir],
  );
const dockerfile = () => read("packaging/docker/Dockerfile");
const webPortOfTheImage = () => Number(/TEAMS_WEB_PORT:-(\d+)/.exec(entrypoint())?.[1]);
// The UPSTREAM repository, as install.sh names it — the one place the project says where it lives.
const UPSTREAM = /^REPO="([^"]+)"/m.exec(read("install.sh"))?.[1] ?? "";

/** Every directory the Dockerfile creates — `mkdir -p` or `install -d [-o|-g|-m …]` — across its RUN lines. */
const dockerfileMkdirs = () =>
  [...dockerfile().matchAll(/(?:mkdir -p|install -d(?: -[ogm] \S+)*) ((?:[^\s&;\\]+[ \t]*)+)/g)].flatMap((m) =>
    m[1].trim().split(/\s+/),
  );

type ComposeMount = { type?: string; source?: string; target: string; readOnly: boolean; createHostPath?: boolean };
/** The teams-lite service's mounts in a compose file, in either of compose's two spellings. */
function composeMounts(path: string): ComposeMount[] {
  const compose = Bun.YAML.parse(read(path)) as Doc;
  return ((compose.services["teams-lite"].volumes ?? []) as (string | Doc)[]).map((entry) => {
    if (typeof entry === "string") {
      const [source, target, mode] = entry.split(":");
      return { source, target, readOnly: (mode ?? "").split(",").includes("ro") };
    }
    return {
      type: entry.type,
      source: entry.source,
      target: entry.target,
      readOnly: entry.read_only === true,
      createHostPath: entry.bind?.create_host_path,
    };
  });
}
const composeMount = (path: string, target: string) => composeMounts(path).find((m) => m.target === target);

/** A `pub const NAME: &str = "…"` of the backend's, so the chart cannot drift from it. */
function rustConst(path: string, name: string): string | undefined {
  return new RegExp(`pub const ${name}: &str = "([^"]+)"`).exec(read(path))?.[1];
}

const chartFile = (name: string) => readFileSync(join(CHART, name), "utf8");
// Prose is compared with its line breaks folded, the way a reader meets it.
const prose = (text: string) => text.replace(/\s+/g, " ");

/**
 * Every command the chart's README hands a reader to type: each `helm install` / `helm upgrade` line
 * of its bash blocks (continuations joined), and each inline span of `--set` flags — with the shell
 * expansions a reader's own shell would make. A span holding a placeholder (`=…`) is prose ABOUT a
 * command rather than one, and is left out.
 */
function readmeCommands(): { text: string; set: Record<string, string> }[] {
  const readme = chartFile("README.md");
  const texts: string[] = [];
  for (const [, block] of readme.matchAll(/```bash\n([\s\S]*?)```/g)) {
    for (const line of block.replace(/\\\n\s*/g, " ").split("\n")) {
      if (/^\s*helm (install|upgrade)\b/.test(line)) texts.push(line.trim());
    }
  }
  for (const [, span] of readme.matchAll(/`([^`\n]*--set [^`\n]*)`/g)) texts.push(span);
  // Expanded BEFORE the flags are split on whitespace, as the reader's shell would: `$(id -u)` holds
  // a space of its own.
  const shell: [string, string][] = [["$(id -u)", "1000"], ["$(id -g)", "1000"], ["$HOME", "/home/u"], ['""', ""]];
  return texts
    .filter((text) => !text.includes("=…"))
    .map((text) => {
      const expanded = shell.reduce((line, [from, to]) => line.split(from).join(to), text);
      const set: Record<string, string> = {};
      for (const [, key, value] of expanded.matchAll(/--set ([^\s=]+)=(\S*)/g)) set[key] = value;
      return { text, set };
    });
}

// The capabilities the `baseline` Pod Security Standard lets a container ADD (Kubernetes' "Pod
// Security Standards", Baseline › Capabilities). A read-only embedded release adds only these, so
// a `baseline` namespace admits it.
const BASELINE_CAPABILITIES = [
  "AUDIT_WRITE", "CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "MKNOD",
  "NET_BIND_SERVICE", "SETFCAP", "SETGID", "SETPCAP", "SETUID", "SYS_CHROOT",
];

describe("the repository it names", () => {
  test("is upstream's, in the chart, its image and the Dockerfile alike", () => {
    expect(UPSTREAM).toBe("theophile-wallez/teams-lite");
    const values = Bun.YAML.parse(readFileSync(join(CHART, "values.yaml"), "utf8")) as Doc;
    expect(values.image.repository).toBe(`ghcr.io/${UPSTREAM}`);
    const chart = Bun.YAML.parse(readFileSync(join(CHART, "Chart.yaml"), "utf8")) as Doc;
    expect(chart.home).toBe(`https://github.com/${UPSTREAM}`);
    expect(chart.sources).toEqual([`https://github.com/${UPSTREAM}`]);
    expect(dockerfile()).toContain(`org.opencontainers.image.source="https://github.com/${UPSTREAM}"`);
  });

  test("is the publisher's in a published package, so a fork's chart runs the fork's image", () => {
    const out = mkdtempSync(join(tmpdir(), "teams-lite-package-"));
    try {
      const packaged = Bun.spawnSync(
        [join(import.meta.dir, "package.sh"), "SomeFork/teams-lite", "0.1.7", "build-0123abc", out],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(packaged.stderr.toString()).not.toContain("no longer names");
      expect(packaged.exitCode).toBe(0);
      const tgz = join(out, "teams-lite-0.1.7.tgz");
      const docs = render({}, { chart: tgz });
      // GHCR wants the path lowercased; the GitHub URLs keep the owner's own spelling.
      expect(container(docs).image).toBe("ghcr.io/somefork/teams-lite:build-0123abc");
      const chart = Bun.YAML.parse(helm(["show", "chart", tgz]).out) as Doc;
      expect(chart.version).toBe("0.1.7");
      expect(chart.sources).toEqual(["https://github.com/SomeFork/teams-lite"]);
      expect(chart.home).toBe("https://github.com/SomeFork/teams-lite");
      // …and the tree it was packaged from is untouched.
      const values = Bun.YAML.parse(readFileSync(join(CHART, "values.yaml"), "utf8")) as Doc;
      expect(values.image.repository).toBe(`ghcr.io/${UPSTREAM}`);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("the default render: the embedded (self-contained) mode", () => {
  const docs = render();

  test("is one pod, and the count is not a value", () => {
    expect(statefulSet(docs).spec.replicas).toBe(1);
    expect(refusal({ replicas: "2" }).length).toBeGreaterThan(0);
  });

  test("replaces a pod that never became Ready when an upgrade mends it", () => {
    // OrderedReady stops at a pod that is not Running and Ready before it reaches the update, so a
    // release installed with a mistyped Secret would never be mended by the upgrade fixing it.
    expect(statefulSet(docs).spec.podManagementPolicy).toBe("Parallel");
    expect(statefulSet(docs).spec.updateStrategy).toEqual({ type: "RollingUpdate" });
  });

  test("keeps Kubernetes' service links out of the backend's own variable", () => {
    // A Service named teams-lite would otherwise put TEAMS_LITE_PORT=tcp://<ip>:19443 in the pod.
    expect(pod(docs).enableServiceLinks).toBe(false);
  });

  test("holds no Kubernetes credential", () => {
    expect(pod(docs).automountServiceAccountToken).toBe(false);
    expect(of(docs, "ServiceAccount")[0].automountServiceAccountToken).toBe(false);
  });

  test("boots its own Intune container, and reaches nothing of the node's", () => {
    expect(env(docs).TEAMS_LITE_INTUNE_MODE).toBe("embedded");
    expect(pod(docs).hostPID).toBeUndefined();
    expect(pod(docs).hostNetwork).toBeUndefined();
    expect(pod(docs).hostUsers).toBeUndefined();
    expect(pod(docs).volumes.filter((v: Doc) => v.hostPath)).toEqual([]);
    // Not pinned to an enrolled node: its own claim is what pins it, once scheduled.
    expect(pod(docs).nodeSelector).toBeUndefined();
    expect(pod(docs).affinity).toBeUndefined();
    // Nothing to import unless a Secret is named.
    expect(env(docs).TEAMS_LITE_INTUNE_IMPORT).toBeUndefined();
    expect(volume(docs, "intune-import")).toBeUndefined();
  });

  test("names the mode and the import the way the backend spells them", () => {
    expect(rustConst("src/intune_embedded.rs", "MODE_ENV")).toBe("TEAMS_LITE_INTUNE_MODE");
    expect(rustConst("src/intune_embedded.rs", "IMPORT_ENV")).toBe("TEAMS_LITE_INTUNE_IMPORT");
  });

  test("…and the image's own default is embedded, which is why a host mode must say `host`", () => {
    expect(dockerfile()).toMatch(/TEAMS_LITE_INTUNE_MODE=embedded\b/);
  });

  test("keeps the Intune state on a claim of its own, read-write, where the image keeps it", () => {
    expect(claims(docs).map((c) => c.metadata.name)).toEqual(["data", "intune"]);
    const intune = claim(docs, "intune")!;
    expect(intune.spec.accessModes).toEqual(["ReadWriteOnce"]);
    expect(intune.spec.resources.requests.storage).toBe("8Gi");
    expect(intune.spec.storageClassName).toBeUndefined();
    expect(intune.metadata.labels).toEqual(statefulSet(docs).spec.selector.matchLabels);
    expect(mount(docs, "intune")).toEqual({ name: "intune", mountPath: INTUNE });
  });

  test("mounts that state where the compose file's own volume is, and where the image creates it", () => {
    // Read-write there too, and created by the image, so a fresh volume starts out as the image's
    // user's rather than root's.
    const composed = composeMount("packaging/docker/compose.yaml", INTUNE);
    expect(composed).toBeDefined();
    expect(composed!.source).toBe("intune");
    expect(composed!.readOnly).toBe(false);
    expect(dockerfileMkdirs()).toContain(INTUNE);
  });

  test("keeps the store where the image keeps it, on a claim of its own", () => {
    const store = mount(docs, "data").mountPath;
    expect(composeMount("packaging/docker/compose.yaml", store)).toBeDefined();
    expect(dockerfileMkdirs()).toContain(store);
    expect(claim(docs, "data")!.spec.accessModes).toEqual(["ReadWriteOnce"]);
  });

  test("starts as root, with no fsGroup to chown the subordinate-id rootfs", () => {
    // The entrypoint delegates its cgroup as root, then drops to `teams`: no runAsUser, no
    // runAsNonRoot — and no fsGroup, whose RECURSIVE chown would break the Intune rootfs.
    expect(pod(docs).securityContext).toEqual({ seccompProfile: { type: "Unconfined" } });
  });

  test("is privileged, on a read-only root filesystem, with the file capabilities intact", () => {
    // No allowPrivilegeEscalation: false (no_new_privs defeats newuidmap's file capabilities, and
    // Kubernetes rejects it beside `privileged`), and no capability dropped.
    expect(container(docs).securityContext).toEqual({ privileged: true, readOnlyRootFilesystem: true });
    // The launcher unpacks the backend into ~/.cache and runs it, so it must be an emptyDir (exec).
    expect(mount(docs, "cache").mountPath).toBe("/home/teams/.cache");
    expect(volume(docs, "cache").emptyDir).toBeDefined();
    expect(mount(docs, "tmp").mountPath).toBe("/tmp");
  });

  test("has the time to power its Intune container off", () => {
    // The entrypoint stops the launcher, then runs the graceful poweroff (up to ~45 s): Kubernetes'
    // default 30 s would SIGKILL the inner systemd and keyring mid-write.
    expect(pod(docs).terminationGracePeriodSeconds).toBe(90);
    expect(pod(render({ terminationGracePeriodSeconds: "120" })).terminationGracePeriodSeconds).toBe(120);
  });

  test("…and the 90 s close over the stop's own bounds, with the host mode's whole budget left", () => {
    // The stop helper waits STOP_LOCK_WAIT for the lifecycle lock (a boot mid-pull holds it), and
    // the crate's `backend::stop` up to 20 s for the poweroff — after the launcher, which a host
    // mode gives its whole 30 s. Move the helper's wait past what 90 s can hold and this fails.
    const lockWait = Number(
      /pub const STOP_LOCK_WAIT: Duration = Duration::from_secs\((\d+)\)/.exec(read("src/intune_embedded.rs"))?.[1],
    );
    expect(lockWait).toBeGreaterThan(0);
    const poweroff = 20;
    const launcher = pod(render(HOST)).terminationGracePeriodSeconds;
    expect(pod(docs).terminationGracePeriodSeconds).toBeGreaterThanOrEqual(launcher + lockWait + poweroff);
  });

  test("…because the entrypoint really traps the TERM and powers the container off", () => {
    expect(entrypoint()).toContain("trap");
    expect(entrypoint()).toContain("__teams-lite-intune-stop");
  });

  test("serves the web front on the image's own port, to no other pod", () => {
    expect(webPortOfTheImage()).toBe(19443);
    expect(container(docs).ports).toEqual([{ name: "web", containerPort: webPortOfTheImage(), protocol: "TCP" }]);
    expect(env(docs).TEAMS_WEB_HOST).toBe("0.0.0.0");
    const web = of(docs, "Service").find((s) => s.spec.clusterIP !== "None");
    expect(web?.spec.type).toBe("ClusterIP");
    expect(of(docs, "Ingress")).toHaveLength(0);
    // ON by default: without it every pod in the cluster could collect the write token.
    const [policy] = of(docs, "NetworkPolicy");
    expect(policy.spec.podSelector.matchLabels).toEqual(statefulSet(docs).spec.selector.matchLabels);
    expect(policy.spec.policyTypes).toEqual(["Ingress"]);
    expect(policy.spec.ingress).toEqual([]);
  });

  test("leaves the ports to the entrypoint, which keeps a read-only run on its own", () => {
    // The image's entrypoint picks 19423 (or the read-only 19430); a port written here would drag
    // a read-only backend off 19430, exactly as bin/teams-dev-server.sh warns.
    expect(Object.keys(env(docs)).filter((name) => /^TEAMS_(LITE|WEB)_PORT$/.test(name))).toEqual([]);
    expect(env(docs).TEAMS_LITE_READ_ONLY).toBeUndefined();
  });

  test("runs the image built from the chart's own commit", () => {
    const chart = Bun.YAML.parse(readFileSync(join(CHART, "Chart.yaml"), "utf8")) as Doc;
    expect(container(docs).image).toBe(`ghcr.io/${UPSTREAM}:${chart.appVersion}`);
    // `latest` moves, so it is re-read on every start.
    expect(container(docs).imagePullPolicy).toBe("Always");
  });

  test("probes with a TCP connect, never a page", () => {
    for (const probe of ["startupProbe", "readinessProbe", "livenessProbe"]) {
      expect(container(docs)[probe].tcpSocket).toEqual({ port: "web" });
    }
  });

  test("says what the first start costs, and how the device is enrolled", () => {
    const said = notes();
    expect(said).toContain("1.7 GB");
    expect(said).toContain("intune-teams-lite-0");
    expect(said).toContain("Enroll this device");
    // …and the one node setting it cannot boot without on Ubuntu, in the crate's own words.
    expect(said).toContain("kernel.apparmor_restrict_unprivileged_userns=0");
    expect(said).toContain("AppArmor restricts unprivileged user namespaces");
    expect(said).toContain("pod-security.kubernetes.io/enforce=privileged");
    expect(said).toContain("KUBERNETES IS UNVERIFIED");
    // The diagnostic runs as the image's user, whom the Intune container's bus answers.
    expect(said).toContain("setpriv --reuid=teams --regid=teams --init-groups -- teams-lite-intune-status");
  });
});

describe("the embedded variants", () => {
  test("an enrollment backup is a Secret, mounted read-only where the backend is told it is", () => {
    const docs = render({ "broker.embedded.import.secretName": "teams-lite-enrollment" });
    expect(env(docs).TEAMS_LITE_INTUNE_IMPORT).toBe(IMPORT);
    expect(mount(docs, "intune-import")).toEqual({
      name: "intune-import",
      mountPath: IMPORT.slice(0, IMPORT.lastIndexOf("/")),
      readOnly: true,
    });
    // NOT optional — a mistyped name or key is a pod that does not start, never a device enrolled
    // anew — and readable by the image's user, since there is no fsGroup to hand it to.
    expect(volume(docs, "intune-import").secret).toEqual({
      secretName: "teams-lite-enrollment",
      defaultMode: 0o444,
      items: [{ key: "enrollment-backup.tar.gz", path: "enrollment-backup.tar.gz" }],
    });
    // The Secret's key is whatever the user called it; the file the backend reads keeps its name.
    const renamed = render({
      "broker.embedded.import.secretName": "enroll",
      "broker.embedded.import.key": "backup.tgz",
    });
    expect(volume(renamed, "intune-import").secret.items).toEqual([{ key: "backup.tgz", path: "enrollment-backup.tar.gz" }]);
    expect(env(renamed).TEAMS_LITE_INTUNE_IMPORT).toBe(IMPORT);
  });

  test("imports from the path the compose file names for its own (commented) bind", () => {
    expect(read("packaging/docker/compose.yaml")).toContain(IMPORT);
  });

  test("says an import is a MOVE, and names the Secret to drop afterwards", () => {
    const said = notes({ "broker.embedded.import.secretName": "teams-lite-enrollment" });
    expect(said).toContain("Secret teams-lite-enrollment");
    expect(said).toContain("MOVE");
    expect(said).not.toContain("Enroll this device");
  });

  test("user namespaces are an opt-in that swaps privileged for what it buys, and says it is unverified", () => {
    const docs = render({ "broker.embedded.userNamespaces": "true" });
    expect(pod(docs).hostUsers).toBe(false);
    expect(pod(docs).securityContext).toEqual({ seccompProfile: { type: "Unconfined" } });
    expect(container(docs).securityContext).toEqual({
      privileged: false,
      readOnlyRootFilesystem: true,
      procMount: "Unmasked",
      capabilities: { add: ["SYS_ADMIN", "SETUID", "SETGID"] },
      appArmorProfile: { type: "Unconfined" },
    });
    expect(env(docs).TEAMS_LITE_INTUNE_MODE).toBe("embedded");
    // UNVERIFIED in all three places a reader meets it, with what it needs.
    const said = notes({ "broker.embedded.userNamespaces": "true" });
    expect(said).toContain("UNVERIFIED");
    expect(said).toContain("196608");
    const values = readFileSync(join(CHART, "values.yaml"), "utf8");
    expect(values).toMatch(/OPT-IN, AND UNVERIFIED[\s\S]*userNamespaces: false/);
    expect(values).toContain("containerd 2.1");
    expect(readFileSync(join(CHART, "README.md"), "utf8")).toMatch(/User namespaces instead of privileged \(opt-in, UNVERIFIED\)/);
    // The default is privileged, and says nothing of the opt-in's requirements.
    expect(notes()).not.toContain("196608");
  });

  test("the Intune claim takes its own class and size", () => {
    const sized = claim(
      render({ "broker.embedded.persistence.storageClassName": "local-path", "broker.embedded.persistence.size": "20Gi" }),
      "intune",
    )!;
    expect(sized.spec.storageClassName).toBe("local-path");
    expect(sized.spec.resources.requests.storage).toBe("20Gi");
    expect(claim(render({ "broker.embedded.persistence.storageClassName": "-" }), "intune")!.spec.storageClassName).toBe("");
    // …and the store's class is the store's alone.
    const store = claim(render({ "persistence.storageClassName": "fast" }), "data")!;
    expect(store.spec.storageClassName).toBe("fast");
    expect(claim(render({ "persistence.storageClassName": "fast" }), "intune")!.spec.storageClassName).toBeUndefined();
  });

  test("the Intune claim stays whatever the store's persistence is: losing it is losing the enrollment", () => {
    const ephemeral = render({ "persistence.enabled": "false" });
    expect(claims(ephemeral).map((c) => c.metadata.name)).toEqual(["intune"]);
    expect(volume(ephemeral, "data").emptyDir).toEqual({});
    const existing = render({ "persistence.existingClaim": "my-store" });
    expect(claims(existing).map((c) => c.metadata.name)).toEqual(["intune"]);
    expect(volume(existing, "data").persistentVolumeClaim).toEqual({ claimName: "my-store" });
  });

  test("a read-only release tells the backend so, and has the last word on it", () => {
    expect(env(render({ readOnly: "true" })).TEAMS_LITE_READ_ONLY).toBe("1");
    // `extraEnv` must not be able to undo it: Helm 3 keeps the later entry, Helm 4 refuses the pair.
    const docs = render({
      readOnly: "true",
      "extraEnv[0].name": "TEAMS_LITE_READ_ONLY",
      "extraEnv[0].value": "0",
    });
    const entries = container(docs).env.filter((e: Doc) => e.name === "TEAMS_LITE_READ_ONLY");
    expect(entries.at(-1).value).toBe("1");
    // And it says that an embedded read-only pod boots nothing.
    expect(notes({ readOnly: "true" })).toContain("never boots its Intune container");
  });

  test("a read-only release is rendered without what booting costs", () => {
    // Asked for with every opt-in a boot would use, so each one is seen NOT to be rendered.
    const docs = render({
      readOnly: "true",
      "broker.embedded.userNamespaces": "true",
      "broker.embedded.import.secretName": "teams-lite-enrollment",
    });
    // Not privileged, and not the user-namespace opt-in's capabilities either: the five its
    // entrypoint uses as root, every one of them inside `baseline`, and no privilege escalation.
    expect(container(docs).securityContext).toEqual({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"], add: ["CHOWN", "DAC_OVERRIDE", "KILL", "SETGID", "SETUID"] },
    });
    for (const capability of container(docs).securityContext.capabilities.add) {
      expect(BASELINE_CAPABILITIES).toContain(capability);
    }
    expect(pod(docs).hostUsers).toBeUndefined();
    // It unshares nothing, so the runtime's default profile — and still no runAsUser or fsGroup.
    expect(pod(docs).securityContext).toEqual({ seccompProfile: { type: "RuntimeDefault" } });
    // The device's own keys are not handed to a release that imports nothing.
    expect(volume(docs, "intune-import")).toBeUndefined();
    expect(mount(docs, "intune-import")).toBeUndefined();
    expect(env(docs).TEAMS_LITE_INTUNE_IMPORT).toBeUndefined();
    // It READS the Intune state, and the kernel holds it to that.
    expect(mount(docs, "intune")).toEqual({ name: "intune", mountPath: INTUNE, readOnly: true });
    // Its entrypoint powers nothing off, so a host mode's grace period.
    expect(pod(docs).terminationGracePeriodSeconds).toBe(30);
    expect(env(docs).TEAMS_LITE_INTUNE_MODE).toBe("embedded");
  });

  test("…and KEEPS its claims, so turning readOnly off is an upgrade rather than a refusal", () => {
    // Volume claim templates cannot change in place: a claim that came and went with readOnly
    // would make the upgrade that switches it off fail.
    expect(claims(render({ readOnly: "true" }))).toEqual(claims(render()));
    expect(claims(render({ readOnly: "true" })).map((c) => c.metadata.name)).toEqual(["data", "intune"]);
  });

  test("…and those five capabilities are all the entrypoint uses as root in a read-only run", () => {
    // Give the root stage's read-only path something more to do as root and this fails, so the list
    // is read again rather than trusted. Bounded at the function's own closing brace and at the
    // read-only branch's own `fi`, and both ends of each are checked.
    const script = entrypoint();
    const start = script.indexOf("root_stage() {");
    const end = script.indexOf("\n}\n", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const root = script.slice(start, end);
    expect(root).not.toContain("drop_to_runtime_user() {");
    const branch = root.indexOf("  if is_read_only; then\n");
    const close = root.indexOf("\n  fi\n", branch);
    expect(branch).toBeGreaterThan(0);
    expect(close).toBeGreaterThan(branch);
    // The read-only path, up to and including its own return: ONE directory taken over — the
    // store's root, which its backend creates its database in whatever the mode (CHOWN, plus
    // DAC_OVERRIDE to cross the 0700 home above it) — and nothing else that takes a capability: not
    // the cache, not the Intune state (the enrollment, which a read-only run never writes), no
    // cgroup, no namespace, no mount.
    const readOnlyPath = root.slice(0, close);
    expect(readOnlyPath).toMatch(
      /if is_read_only; then\n\s*own_dir "\$_data\/teams-lite" "\$_uid" "\$_gid"\n\s*say "[^"\n]*"\n\s*return 0$/,
    );
    expect(readOnlyPath.match(/own_dir /g)).toHaveLength(1);
    for (const act of ["chown", "delegate_cgroup", "check_id_mapping", "embedded_preflight", "unshare", "mount -t", ".cache", "intune-container"]) {
      expect(readOnlyPath).not.toContain(act);
    }
    // …which is where a boot's own work starts instead.
    expect(root.slice(close)).toContain("delegate_cgroup");
    // The one chown own_dir makes is of that directory alone, never recursive.
    expect(script).not.toContain("chown -R");
    // Before the root stage, as root: the instance lock, in /tmp — the chart's emptyDir, root's own.
    expect(script).toMatch(/^INSTANCE_LOCK=\/tmp\//m);
    expect(mount(render({ readOnly: "true" }), "tmp").mountPath).toBe("/tmp");
    // The drop is setpriv (SETUID, SETGID); PID 1 is tini, root for the pod's whole life, which
    // forwards the stop signal to a process that is no longer root's (KILL). No USER: it starts as
    // root, which is also why runAsNonRoot is refused.
    expect(script).toMatch(/exec setpriv --reuid="\$RUNTIME_USER" --regid="\$RUNTIME_USER" --init-groups/);
    expect(dockerfile()).toMatch(/^ENTRYPOINT \["\/usr\/bin\/tini"/m);
    expect(dockerfile()).not.toMatch(/^USER /m);
    // DAC_OVERRIDE is needed because the runtime user's home is the one useradd makes, 0700, and the
    // store's claim is mounted under it.
    expect(dockerfile()).toMatch(/useradd [^\n]*-m -d \/home\/teams /);
    expect(mount(render({ readOnly: "true" }), "data").mountPath).toStartWith("/home/teams/");
  });

  test("…and the root stage RUNS that way: a read-only run takes over the store root and nothing else", () => {
    // The text above says what the branch holds; this runs it — the entrypoint sourced as a library,
    // every act stubbed to a line — so a branch that reads right and decides wrong fails too.
    const store = "/home/teams/.local/share/teams-lite";
    expect(rootStageActs({ TEAMS_LITE_INTUNE_MODE: "embedded", TEAMS_LITE_READ_ONLY: "1" })).toEqual([`own_dir ${store}`]);
    expect(rootStageActs({ TEAMS_LITE_INTUNE_MODE: "embedded" })).toEqual([
      "embedded_preflight",
      `own_dir ${store}`,
      "own_dir /home/teams/.cache",
      "own_dir /home/teams/.local/share/intune-container",
      "delegate_cgroup",
      "check_id_mapping",
    ]);
    expect(rootStageActs({ TEAMS_LITE_INTUNE_MODE: "host" })).toEqual([]);
    expect(rootStageActs({ TEAMS_LITE_INTUNE_MODE: "host", TEAMS_LITE_READ_ONLY: "1" })).toEqual([]);
  });

  test("…and what it takes over is only a FRESH root: root-owned and empty, never anybody's directory", () => {
    // The rule the read-only branch rests on ("nobody's data is touched"): own_dir with the owner
    // stubbed and `chown` logged, over real directories.
    const scratch = mkdtempSync(join(tmpdir(), "teams-lite-own-dir-"));
    try {
      const empty = join(scratch, "empty");
      const holding = join(scratch, "holding");
      mkdirSync(empty);
      mkdirSync(holding);
      writeFileSync(join(holding, "teams-lite.sqlite"), "");
      expect(ownDirActs(empty, "0:0")).toEqual([`chown 1000:1000 ${empty}`]);
      expect(ownDirActs(holding, "0:0")).toEqual(["warn"]);
      expect(ownDirActs(empty, "2000:2000")).toEqual(["warn"]);
      expect(ownDirActs(empty, "1000:1000")).toEqual([]);
      expect(ownDirActs(join(scratch, "absent"), "0:0")).toEqual([]);
      // A directory root cannot reach (a container without DAC_OVERRIDE) is SAID, never skipped.
      expect(ownDirActs(empty, "denied")).toEqual(["warn"]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("a read-only release's notes say only what it can do, and why it is shaped as it is", () => {
    const said = notes({ readOnly: "true" });
    // Nothing a release that boots nothing could ever do.
    expect(said).not.toContain("1.7 GB");
    expect(said).not.toContain("Enroll this device");
    expect(said).not.toContain("repaired by the pod itself");
    expect(said).not.toContain("It runs PRIVILEGED");
    expect(said).not.toContain("apparmor_restrict_unprivileged_userns");
    expect(said).not.toContain("enforce=privileged");
    // What it is instead.
    expect(said).toContain("intune-teams-lite-0 all the same, mounted read-only");
    expect(said).toContain("UNPRIVILEGED");
    expect(said).toContain("`baseline`");
    expect(said).toContain("KUBERNETES IS UNVERIFIED");
    // An opt-in a boot would use is said not to apply, never silently dropped.
    const opted = notes({
      readOnly: "true",
      "broker.embedded.userNamespaces": "true",
      "broker.embedded.import.secretName": "teams-lite-enrollment",
    });
    expect(opted).toContain("broker.embedded.userNamespaces is an alternative to privilege");
    expect(opted).toContain("Secret teams-lite-enrollment is not mounted");
    expect(opted).not.toContain("UNVERIFIED — pod user namespaces");
    expect(opted).not.toContain("MOVE");
  });

  test("an archive too large for a Secret can come in through the user's own volume", () => {
    const docs = render({ "extraEnv[0].name": "TEAMS_LITE_INTUNE_IMPORT", "extraEnv[0].value": "/import/big.tar.gz" });
    expect(env(docs).TEAMS_LITE_INTUNE_IMPORT).toBe("/import/big.tar.gz");
  });
});

describe("the embedded image refuses the HOST's namespaces", () => {
  // The kernel's own fixed numbers for the namespaces it boots with, as <linux/nsfs.h> publishes
  // them (`enum init_ns_ino`): a container reads one of these iff it is in the KERNEL's initial
  // namespace of that kind — the host's wherever it shares the host's kernel. Measured on this
  // machine's 7.3 kernel under Docker: `--network host` reads the first and `--ipc host` the second.
  test("the numbers are the kernel's NET_NS_INIT_INO and IPC_NS_INIT_INO", () => {
    const script = entrypoint();
    expect(Number(/^INITIAL_NET_NAMESPACE=(\d+)/m.exec(script)?.[1])).toBe(0xeffffff9);
    expect(Number(/^INITIAL_IPC_NAMESPACE=(\d+)/m.exec(script)?.[1])).toBe(0xefffffff);
    // Read off the namespace itself, never off the link's text — and it really answers: a number
    // is this shell's own namespace or it is not.
    expect(script).toContain('stat -L -c %i "/proc/self/ns/$1"');
    const answers = entrypointLibrary(
      [
        'for kind in net ipc; do',
        '  own=$(stat -L -c %i "/proc/$$/ns/$kind")',
        '  if namespace_is_the_kernels_initial "$kind" "$own"; then echo "$kind same"; fi',
        '  if ! namespace_is_the_kernels_initial "$kind" 1; then echo "$kind other"; fi',
        'done',
      ].join("\n"),
    );
    expect(answers).toEqual(["net same", "net other", "ipc same", "ipc other"]);
  });

  // The entrypoint's embedded preflight, with the namespace answers stubbed: each host namespace
  // ends the start with a sentence that names it, before the :99 check that can only see a moment.
  const preflight = (net: boolean, ipc: boolean) =>
    sourced(
      join(ROOT, "packaging/docker/entrypoint.sh"),
      [
        `network_is_the_hosts() { ${net ? "return 0" : "return 1"}; }`,
        `ipc_is_the_hosts() { ${ipc ? "return 0" : "return 1"}; }`,
        "display_99_is_held() { return 1; }",
        "check_user_namespaces() { :; }",
        "embedded_preflight",
        "echo started",
      ].join("\n"),
      {},
    );

  test("the entrypoint refuses the host's network namespace — whenever the host's :99 comes up", () => {
    const run = preflight(true, false);
    expect(run.code).toBe(2);
    expect(run.err).toContain("runs in the kernel's INITIAL network namespace — the HOST's (--network host");
    expect(run.out).not.toContain("started");
    // Before the display check: a :99 that is not bound YET must not make the start look safe.
    const body = entrypoint();
    const fn = body.slice(body.indexOf("embedded_preflight() {"));
    expect(fn.indexOf("refuse_the_hosts_namespaces")).toBeGreaterThan(-1);
    expect(fn.indexOf("refuse_the_hosts_namespaces")).toBeLessThan(fn.indexOf("refuse_a_shared_display"));
  });

  test("the entrypoint refuses the host's IPC namespace, whose /dev/shm holds the user's broker's locks", () => {
    const run = preflight(false, true);
    expect(run.code).toBe(2);
    expect(run.err).toContain("runs in the HOST's IPC namespace (--ipc host)");
    expect(preflight(false, false)).toMatchObject({ code: 0, out: "started\n" });
  });

  // The self-test's own refusals, with the namespace answers stubbed and /dev/shm a directory of the
  // test's own: the HOST's network and IPC namespaces, and a /dev/shm that is anybody else's.
  test("the self-test refuses the host's network and IPC namespaces, and a /dev/shm that is not its own", () => {
    const scratch = mkdtempSync(join(tmpdir(), "teams-lite-shm-"));
    try {
      const shm = join(scratch, "shm");
      mkdirSync(shm);
      const refusals = (net: boolean, ipc: boolean) =>
        selftestLibrary(
          [
            `SHM_DIR=${JSON.stringify(shm)}`,
            `network_is_the_hosts() { ${net ? "return 0" : "return 1"}; }`,
            `ipc_is_the_hosts() { ${ipc ? "return 0" : "return 1"}; }`,
            "display_99_is_held() { return 1; }",
            "refuse_what_it_must_not_do",
            "echo cleared",
          ].join("\n"),
          { TEAMS_LITE_INTUNE_MODE: "embedded", HOME: join(scratch, "home") },
        );
      expect(refusals(false, false)).toMatchObject({ code: 0, out: "cleared\n" });
      const net = refusals(true, false);
      expect(net.code).toBe(2);
      expect(net.err).toContain("runs in the kernel's INITIAL network namespace — the HOST's (--network host)");
      const ipc = refusals(false, true);
      expect(ipc.code).toBe(2);
      expect(ipc.err).toContain("runs in the HOST's IPC namespace (--ipc host)");
      // `--ipc container:<it>` cannot be told by number, but its /dev/shm holds that broker's locks.
      writeFileSync(join(shm, "sem.OneAuth_FS_probe"), "");
      const shared = refusals(false, false);
      expect(shared.code).toBe(2);
      expect(shared.err).toContain("already holds files");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("a microVM runtime is DECLARED, never detected", () => {
  // Under Kata Containers or Firecracker the pod runs on a GUEST kernel, and Kata hands every
  // container of the sandbox that guest's initial network namespace: it reads NET_NS_INIT_INO on
  // no host network at all. Nothing in the container can tell that from `--network host`, so the
  // runtime is declared (TEAMS_LITE_NETNS_IS_OWN=1) — and only that one proof is relaxed. These run
  // the entrypoint's REAL decision, with nothing stubbed but the namespace's number and the two
  // checks a case does not ask about.
  const NETNS = "TEAMS_LITE_NETNS_IS_OWN";
  const start = (initial: boolean, env: Record<string, string> = {}, stubs: string[] = []) =>
    sourced(
      join(ROOT, "packaging/docker/entrypoint.sh"),
      [
        `network_is_the_kernels_initial() { ${initial ? "return 0" : "return 1"}; }`,
        "ipc_is_the_hosts() { return 1; }",
        "display_99_is_held() { return 1; }",
        "check_user_namespaces() { :; }",
        ...stubs,
        "embedded_preflight",
        "echo started",
      ].join("\n"),
      env,
    );

  test("the kernel's initial network namespace, undeclared, is refused — and the sentence names the way out", () => {
    for (const env of [{}, { [NETNS]: "" }, { [NETNS]: "0" }]) {
      const run = start(true, env);
      expect(run.code).toBe(2);
      expect(run.out).not.toContain("started");
      expect(run.err).toContain("kernel's INITIAL network namespace — the HOST's (--network host");
      // Both spellings of the one declaration, so a reader under Kata is not sent to drop a
      // `--network host` they never set.
      expect(run.err).toContain("TEAMS_LITE_NETNS_IS_OWN=1 (the chart's broker.embedded.vmIsolated=true)");
      expect(run.err).toContain("ONLY if — it runs under a microVM runtime");
    }
  });

  test("declared, it is let through on that word alone, and the log says what the word costs", () => {
    const run = start(true, { [NETNS]: "1" });
    expect(run).toMatchObject({ code: 0, out: "started\n" });
    expect(run.err).toContain("is let through on that declaration alone");
    expect(run.err).toContain("unset the declaration there");
    // Declared where it changes nothing, it says so rather than nothing.
    const moot = start(false, { [NETNS]: "1" });
    expect(moot).toMatchObject({ code: 0, out: "started\n" });
    expect(moot.err).toContain("changes nothing here");
  });

  test("it relaxes the network-namespace proof and nothing else", () => {
    // The host's IPC namespace is still refused (Kata makes a fresh one per sandbox, so it never
    // reads the initial number there), and so is a :99 somebody else already holds.
    const ipc = start(true, { [NETNS]: "1" }, ["ipc_is_the_hosts() { return 0; }"]);
    expect(ipc.code).toBe(2);
    expect(ipc.err).toContain("runs in the HOST's IPC namespace (--ipc host)");
    const display = start(true, { [NETNS]: "1" }, ["display_99_is_held() { return 0; }"]);
    expect(display.code).toBe(2);
    expect(display.err).toContain("already holds display :99");
    // …and the IPC refusal does not read the declaration at all: it is a decision of its own.
    const fn = entrypoint().split("\n").find((line) => line.startsWith("ipc_is_the_hosts()"));
    expect(fn).toBeDefined();
    expect(fn).not.toContain("netns_is_declared_own");
  });

  test("a value that is not 0 or 1 is refused loudly, whichever namespace it is in", () => {
    for (const initial of [true, false]) {
      for (const value of ["true", "yes", "2"]) {
        const run = start(initial, { [NETNS]: value });
        expect(run.code).toBe(2);
        expect(run.out).not.toContain("started");
        expect(run.err).toContain(`TEAMS_LITE_NETNS_IS_OWN=${value} is not a value teams-lite knows`);
      }
    }
  });

  test("the self-test reads the same declaration, the same way", () => {
    const scratch = mkdtempSync(join(tmpdir(), "teams-lite-netns-"));
    try {
      const shm = join(scratch, "shm");
      mkdirSync(shm);
      const selftest = (env: Record<string, string>) =>
        selftestLibrary(
          [
            `SHM_DIR=${JSON.stringify(shm)}`,
            "network_is_the_kernels_initial() { return 0; }",
            "ipc_is_the_hosts() { return 1; }",
            "display_99_is_held() { return 1; }",
            "refuse_what_it_must_not_do",
            "echo cleared",
          ].join("\n"),
          { TEAMS_LITE_INTUNE_MODE: "embedded", HOME: join(scratch, "home"), ...env },
        );
      const undeclared = selftest({});
      expect(undeclared.code).toBe(2);
      expect(undeclared.err).toContain("kernel's INITIAL network namespace — the HOST's (--network host)");
      expect(undeclared.err).toContain("declare that with TEAMS_LITE_NETNS_IS_OWN=1");
      expect(selftest({ [NETNS]: "1" })).toMatchObject({ code: 0, out: "cleared\n" });
      expect(selftest({ [NETNS]: "true" }).code).toBe(2);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("the chart's broker.embedded.vmIsolated writes the very declaration the entrypoint reads", () => {
    const docs = render({ "broker.embedded.vmIsolated": "true" });
    expect(env(docs)[NETNS]).toBe("1");
    // The pairing, end to end: the rendered variable is what lets the entrypoint through.
    expect(start(true, { [NETNS]: env(docs)[NETNS] })).toMatchObject({ code: 0, out: "started\n" });
    expect(env(render())[NETNS]).toBeUndefined();
    expect(start(true, {}).code).toBe(2);
    // The chart's own words say what it costs, where a reader meets it.
    const said = prose(notes({ "broker.embedded.vmIsolated": "true" }));
    expect(said).toContain("DECLARED — a microVM runtime (broker.embedded.vmIsolated)");
    expect(said).toContain("hostNetwork by another name");
    expect(prose(notes())).not.toContain("microVM");
  });

  test("only where the pod boots: a read-only release checks no namespace, and a host mode refuses it", () => {
    const readOnly = render({ readOnly: "true", "broker.embedded.vmIsolated": "true" });
    expect(env(readOnly)[NETNS]).toBeUndefined();
    expect(prose(notes({ readOnly: "true", "broker.embedded.vmIsolated": "true" }))).toContain(
      "broker.embedded.vmIsolated relaxes a network-namespace check only a boot makes",
    );
    for (const host of [HOST, BUS]) {
      expect(refusal({ ...host, "broker.embedded.vmIsolated": "true" })).toContain(
        "broker.embedded.vmIsolated applies to broker.mode=embedded only",
      );
    }
  });

  test("extraEnv cannot write it behind the chart's back, and a value that is not a boolean is refused", () => {
    expect(refusal({ "extraEnv[0].name": NETNS, "extraEnv[0].value": "1" })).toContain(
      "extraEnv must not set TEAMS_LITE_NETNS_IS_OWN",
    );
    expect(refusal({ "broker.embedded.vmIsolated": "yes" }).length).toBeGreaterThan(0);
  });

  test("it is not REQUIRED, so a values tree from a chart that predates it still validates", () => {
    // `--reuse-values` hands a newer chart the OLD chart's whole tree; a new required key would be
    // refused there. Its absence renders as false.
    const schema = JSON.parse(chartFile("values.schema.json")) as Doc;
    expect(schema.properties.broker.properties.embedded.required).not.toContain("vmIsolated");
    expect(schema.properties.broker.properties.embedded.properties.vmIsolated.type).toBe("boolean");
    expect(env(render({ "broker.embedded.vmIsolated": "null" }))[NETNS]).toBeUndefined();
    expect(Bun.YAML.parse(chartFile("values.yaml")).broker.embedded.vmIsolated).toBe(false);
  });
});

describe("the host modes", () => {
  test("intuneContainer reaches the broker through the node's process table, as the node's user", () => {
    const docs = render(HOST);
    expect(env(docs).TEAMS_LITE_INTUNE_MODE).toBe("host");
    expect(pod(docs).hostPID).toBe(true);
    const security = pod(docs).securityContext;
    expect(security.runAsUser).toBe(1000);
    expect(security.runAsGroup).toBe(1000);
    expect(security.runAsNonRoot).toBe(true);
    expect(security.seccompProfile).toEqual({ type: "RuntimeDefault" });
    // The state is a READ-ONLY DIRECTORY that must already exist, mounted where the image keeps it.
    expect(volume(docs, "intune-state").hostPath).toEqual({ path: STATE, type: "Directory" });
    expect(mount(docs, "intune-state")).toEqual({ name: "intune-state", mountPath: INTUNE, readOnly: true });
    // None of the embedded mode's own: no Intune claim, no privilege, the old grace period.
    expect(claims(docs).map((c) => c.metadata.name)).toEqual(["data"]);
    expect(mount(docs, "intune")).toBeUndefined();
    expect(container(docs).securityContext).toEqual({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
    expect(pod(docs).terminationGracePeriodSeconds).toBe(30);
  });

  test("mounts the node's state where the host-broker compose file binds it, read-only and never created", () => {
    const composed = composeMount("packaging/docker/compose.host-broker.yaml", INTUNE);
    expect(composed).toMatchObject({ type: "bind", readOnly: true, createHostPath: false });
  });

  test("the host-broker compose file says host too, since the image's default is embedded", () => {
    const compose = Bun.YAML.parse(read("packaging/docker/compose.host-broker.yaml")) as Doc;
    const service = compose.services["teams-lite"];
    expect(service.pid).toBe("host");
    expect(service.network_mode).toBe("host");
    expect(JSON.stringify(service.environment)).toContain("TEAMS_LITE_INTUNE_MODE");
    expect(JSON.stringify(service.environment)).toContain("host");
  });

  test("the uid it runs as is the one the user names", () => {
    expect(pod(render({ ...HOST, "hostUser.uid": "1001", "hostUser.gid": "1002" })).securityContext).toMatchObject({
      runAsUser: 1001,
      runAsGroup: 1002,
      fsGroup: 1002,
    });
  });

  test("hostNetwork keeps the web front on the node's loopback and draws nothing that cannot apply", () => {
    const docs = render({ ...HOST, hostNetwork: "true" });
    expect(pod(docs).hostNetwork).toBe(true);
    expect(pod(docs).dnsPolicy).toBe("ClusterFirstWithHostNet");
    expect(env(docs).TEAMS_WEB_HOST).toBe("127.0.0.1");
    for (const probe of ["startupProbe", "readinessProbe", "livenessProbe"]) {
      expect(container(docs)[probe].tcpSocket).toEqual({ port: 19443, host: "127.0.0.1" });
    }
    expect(of(docs, "Service").map((s) => s.metadata.name)).toEqual(["teams-lite-headless"]);
    // No NetworkPolicy applies to a host-network pod, so none is drawn to promise otherwise.
    expect(of(docs, "NetworkPolicy")).toHaveLength(0);
  });

  test("a classic Intune host is handed the bus of the session running NOW", () => {
    const docs = render(BUS);
    expect(env(docs).TEAMS_LITE_INTUNE_MODE).toBe("host");
    expect(pod(docs).hostPID).toBeUndefined();
    // /run/user, never the socket: /run/user/<uid> is a tmpfs re-made at every login, and a bind of
    // the socket or of that directory keeps showing a bus that died.
    expect(volume(docs, "session-bus").hostPath).toEqual({ path: "/run/user", type: "Directory" });
    expect(mount(docs, "session-bus")).toMatchObject({ mountPath: "/run/user", readOnly: true, mountPropagation: "HostToContainer" });
    expect(env(docs).TEAMS_LITE_BROKER_BUS).toBe("unix:path=/run/user/1000/bus");
    expect(volume(docs, "intune-state")).toBeUndefined();
    expect(claims(docs).map((c) => c.metadata.name)).toEqual(["data"]);
  });

  test("say what the embedded mode would not: the node's broker, and no window without hostNetwork", () => {
    const said = notes(HOST);
    expect(said).toContain(STATE);
    expect(said).toContain("cannot be served into the app without hostNetwork");
    expect(said).not.toContain("1.7 GB");
  });
});

describe("the variants", () => {
  test("the Tailscale operator gets the default backend it expects, and is let through", () => {
    const docs = render({
      "ingress.enabled": "true",
      "ingress.className": "tailscale",
      "ingress.tls[0].hosts[0]": "teams-lite",
      "networkPolicy.allowNamespaces[0]": "tailscale",
    });
    const [ingress] = of(docs, "Ingress");
    expect(ingress.spec.ingressClassName).toBe("tailscale");
    expect(ingress.spec.defaultBackend.service).toEqual({ name: "teams-lite", port: { name: "web" } });
    expect(ingress.spec.tls).toEqual([{ hosts: ["teams-lite"] }]);
    expect(of(docs, "NetworkPolicy")[0].spec.ingress).toEqual([
      {
        from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "tailscale" } } }],
        ports: [{ port: "web", protocol: "TCP" }],
      },
    ]);
  });

  test("an Ingress with hosts routes each one to the web port, and the app answers to them", () => {
    const docs = render({
      "ingress.enabled": "true",
      "ingress.className": "nginx",
      "ingress.hosts[0].host": "teams.example.internal",
      "networkPolicy.allowNamespaces[0]": "ingress-nginx",
      "auth.external": "true",
    });
    const [rule] = of(docs, "Ingress")[0].spec.rules;
    expect(rule.host).toBe("teams.example.internal");
    expect(rule.http.paths[0]).toMatchObject({ path: "/", pathType: "Prefix", backend: { service: { name: "teams-lite", port: { name: "web" } } } });
    // A Host the app does not answer to is refused as a DNS-rebinding page (web/request-origin.ts).
    expect(env(docs).TEAMS_LITE_ALLOWED_HOSTS).toBe("teams.example.internal");
  });

  test("a NetworkPolicy's own peers are kept beside the named namespaces", () => {
    const [policy] = of(
      render({ "networkPolicy.allowNamespaces[0]": "tailscale", "networkPolicy.from[0].podSelector.matchLabels.app": "proxy" }),
      "NetworkPolicy",
    );
    expect(policy.spec.ingress[0].from).toEqual([
      { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "tailscale" } } },
      { podSelector: { matchLabels: { app: "proxy" } } },
    ]);
  });

  test("a parent chart's `condition: teams-lite.enabled` is not refused", () => {
    expect(statefulSet(render({ enabled: "true" })).spec.replicas).toBe(1);
  });

  test("an existing claim replaces the store's template, and no persistence says so with an emptyDir", () => {
    const claimed = render({ ...HOST, "persistence.existingClaim": "my-store" });
    expect(statefulSet(claimed).spec.volumeClaimTemplates).toBeUndefined();
    expect(volume(claimed, "data").persistentVolumeClaim).toEqual({ claimName: "my-store" });
    const ephemeral = render({ ...HOST, "persistence.enabled": "false" });
    expect(statefulSet(ephemeral).spec.volumeClaimTemplates).toBeUndefined();
    expect(volume(ephemeral, "data").emptyDir).toEqual({});
  });

  test("a digest wins over the tag, and a build's own tag is never re-pulled", () => {
    const pinned = render({ "image.digest": `sha256:${"a".repeat(64)}` });
    expect(container(pinned).image).toBe(`ghcr.io/${UPSTREAM}@sha256:${"a".repeat(64)}`);
    expect(container(pinned).imagePullPolicy).toBe("IfNotPresent");
    const built = render({ "image.tag": "build-0123abc" });
    expect(container(built).image).toBe(`ghcr.io/${UPSTREAM}:build-0123abc`);
    expect(container(built).imagePullPolicy).toBe("IfNotPresent");
  });

  test("a release named otherwise keeps the chart's name in its resources", () => {
    expect(statefulSet(render({}, { release: "me" })).metadata.name).toBe("me-teams-lite");
  });
});

// The sign-in the chart runs in front of the app, the minimum it needs.
const SIGN_IN = {
  "auth.oauth2Proxy.enabled": "true",
  "auth.oauth2Proxy.issuerUrl": "https://accounts.google.com",
  "auth.oauth2Proxy.clientId": "client",
  "auth.oauth2Proxy.existingSecret": "teams-lite-oauth2-proxy",
  "auth.oauth2Proxy.emails[0]": "You@Example.com",
};
// A Gateway API route, the minimum it needs.
const ROUTE = {
  "httpRoute.enabled": "true",
  "httpRoute.parentRefs[0].name": "public",
  "httpRoute.parentRefs[0].namespace": "gateway-system",
  "httpRoute.hostnames[0]": "teams.example.com",
  "networkPolicy.allowNamespaces[0]": "envoy-gateway-system",
};
const sidecar = (docs: Doc[]) => pod(docs).containers.find((c: Doc) => c.name === "oauth2-proxy");
const args = (docs: Doc[]) => sidecar(docs).args as string[];
/** The pattern oauth2-proxy is handed for `--skip-auth-route=GET=<pattern>`, as a JS RegExp (the
 *  patterns are plain RE2 anchors, classes and escapes, which read the same in both). */
const skipRoutes = (docs: Doc[]) =>
  args(docs)
    .filter((a) => a.startsWith("--skip-auth-route="))
    .map((a) => new RegExp(a.replace(/^--skip-auth-route=GET=/, "")));

describe("publishing it beyond the tailnet", () => {
  test("is refused with no sign-in in front — whatever reaches the web port can send as the user", () => {
    for (const set of [
      ROUTE,
      { "ingress.enabled": "true", "ingress.className": "nginx", "networkPolicy.allowNamespaces[0]": "ingress-nginx" },
      {
        "ingress.enabled": "true",
        "ingress.className": "tailscale",
        "ingress.annotations.tailscale\\.com/funnel": "true",
        "networkPolicy.allowNamespaces[0]": "tailscale",
      },
    ]) {
      const why = refusal(set);
      expect(why).toContain("no sign-in in front of it");
      expect(why).toContain("auth.oauth2Proxy");
      expect(why).toContain("auth.external=true");
    }
  });

  test("so is a NodePort or LoadBalancer Service: it publishes the port to whatever reaches it", () => {
    for (const type of ["NodePort", "LoadBalancer"]) {
      expect(refusal({ "service.type": type })).toContain("no sign-in in front of it");
      expect(() => render({ "service.type": type, "auth.external": "true" })).not.toThrow();
      const [service] = of(render({ ...SIGN_IN, "service.type": type, "auth.oauth2Proxy.redirectUrl": "https://t.example.com/oauth2/callback" }), "Service").filter((d) => d.spec.type === type);
      expect(service.spec.ports[0].targetPort).toBe("auth");
    }
  });

  test("the Tailscale operator's Ingress needs no sign-in: the tailnet is the wall", () => {
    expect(() =>
      render({ "ingress.enabled": "true", "ingress.className": "tailscale", "networkPolicy.allowNamespaces[0]": "tailscale" }),
    ).not.toThrow();
  });

  test("auth.external is the user's word, and the notes say the chart cannot check it", () => {
    const docs = render({ ...ROUTE, "auth.external": "true" });
    expect(of(docs, "HTTPRoute")).toHaveLength(1);
    expect(pod(docs).containers).toHaveLength(1);
    expect(notes({ ...ROUTE, "auth.external": "true" })).toContain("It cannot check that");
  });
});

describe("the Gateway API route", () => {
  test("routes every path of the Service from the Gateway it names, and the app answers to its names", () => {
    const docs = render({ ...SIGN_IN, ...ROUTE });
    const [route] = of(docs, "HTTPRoute");
    expect(route.apiVersion).toBe("gateway.networking.k8s.io/v1");
    expect(route.spec.parentRefs).toEqual([{ name: "public", namespace: "gateway-system" }]);
    expect(route.spec.hostnames).toEqual(["teams.example.com"]);
    expect(route.spec.rules).toEqual([
      {
        matches: [{ path: { type: "PathPrefix", value: "/" } }],
        backendRefs: [{ name: "teams-lite", port: 19443 }],
      },
    ]);
    expect(env(docs).TEAMS_LITE_ALLOWED_HOSTS).toBe("teams.example.com");
  });

  test("takes the rule's filters and timeouts as written in an HTTPRoute", () => {
    const docs = render({
      ...SIGN_IN,
      ...ROUTE,
      "httpRoute.timeouts.request": "0s",
      "httpRoute.filters[0].type": "ResponseHeaderModifier",
      "httpRoute.filters[0].responseHeaderModifier.set[0].name": "Strict-Transport-Security",
      "httpRoute.filters[0].responseHeaderModifier.set[0].value": "max-age=31536000",
    });
    const [rule] = of(docs, "HTTPRoute")[0].spec.rules;
    expect(rule.timeouts).toEqual({ request: "0s" });
    expect(rule.filters[0].type).toBe("ResponseHeaderModifier");
  });

  test("a wildcard hostname is a domain to the app, and never where the callback lives", () => {
    const docs = render({ ...SIGN_IN, ...ROUTE, "httpRoute.hostnames[0]": "*.example.com", "httpRoute.hostnames[1]": "teams.example.com" });
    expect(env(docs).TEAMS_LITE_ALLOWED_HOSTS).toBe(".example.com,teams.example.com");
    expect(args(docs)).toContain("--redirect-url=https://teams.example.com/oauth2/callback");
  });

  test("is refused without a Gateway, on the node's network, or behind a policy nothing passes", () => {
    const { "httpRoute.parentRefs[0].name": _n, "httpRoute.parentRefs[0].namespace": _ns, ...noParent } = ROUTE;
    expect(refusal({ ...SIGN_IN, ...noParent })).toContain("httpRoute.enabled needs httpRoute.parentRefs");
    const { "networkPolicy.allowNamespaces[0]": _p, ...closed } = ROUTE;
    expect(refusal({ ...SIGN_IN, ...closed })).toContain("the Gateway's proxies could not reach the app");
    expect(refusal({ ...HOST, ...ROUTE, "auth.external": "true", "hostNetwork": "true" })).toContain(
      "httpRoute.enabled needs hostNetwork=false",
    );
  });
});

describe("Cilium's own Gateway, whose proxy is in no namespace", () => {
  // The Cilium shape: Cilium's Gateway, so no namespace of proxies to name.
  const { "networkPolicy.allowNamespaces[0]": _p, ...CILIUM_ROUTE } = { ...ROUTE, "networkPolicy.allowCiliumIngress": "true" };
  const cnp = (docs: Doc[]) => of(docs, "CiliumNetworkPolicy");

  test("is admitted by a CiliumNetworkPolicy on the sign-in's one port, and by nothing wider", () => {
    const docs = render({ ...SIGN_IN, ...CILIUM_ROUTE });
    const [policy] = cnp(docs);
    expect(policy.apiVersion).toBe("cilium.io/v2");
    expect(policy.metadata.name).toBe("teams-lite-cilium-ingress");
    // The same pods the NetworkPolicy selects — and the StatefulSet's own selector.
    const [netpol] = of(docs, "NetworkPolicy");
    expect(policy.spec.endpointSelector).toEqual({ matchLabels: netpol.spec.podSelector.matchLabels });
    expect(policy.spec.endpointSelector.matchLabels).toEqual(statefulSet(docs).spec.selector.matchLabels);
    expect(policy.spec.ingress).toEqual([{ fromEntities: ["ingress"], toPorts: [{ ports: [{ port: "auth", protocol: "TCP" }] }] }]);
    expect(policy.spec.egress).toBeUndefined();
    // The NetworkPolicy beside it still admits no other pod.
    expect(netpol.spec.ingress).toEqual([]);
  });

  test("opens the web front's port when there is no sign-in in front (auth.external)", () => {
    const [policy] = cnp(render({ ...CILIUM_ROUTE, "auth.external": "true" }));
    expect(policy.spec.ingress[0].toPorts).toEqual([{ ports: [{ port: "web", protocol: "TCP" }] }]);
  });

  test("is not rendered unless asked for", () => {
    expect(cnp(render())).toEqual([]);
    expect(cnp(render({ ...SIGN_IN, ...ROUTE }))).toEqual([]);
  });

  test("is a way in for a route and for an Ingress, so neither is refused as unreachable", () => {
    expect(of(render({ ...SIGN_IN, ...CILIUM_ROUTE }), "HTTPRoute")).toHaveLength(1);
    const docs = render({
      ...SIGN_IN,
      "ingress.enabled": "true",
      "ingress.className": "cilium",
      "ingress.hosts[0].host": "teams.example.com",
      "networkPolicy.allowCiliumIngress": "true",
    });
    expect(of(docs, "Ingress")).toHaveLength(1);
    expect(cnp(docs)).toHaveLength(1);
  });

  test("names itself in the refusal a closed policy earns", () => {
    const { "networkPolicy.allowCiliumIngress": _c, ...closed } = CILIUM_ROUTE;
    expect(refusal({ ...SIGN_IN, ...closed })).toContain("networkPolicy.allowCiliumIngress=true for Cilium's own Gateway");
  });

  test("is refused where no NetworkPolicy is rendered: alone it would make the pod deny-by-default", () => {
    expect(refusal({ ...SIGN_IN, ...CILIUM_ROUTE, "networkPolicy.enabled": "false" })).toContain(
      "networkPolicy.allowCiliumIngress adds a way in to the NetworkPolicy, and this release renders none",
    );
    expect(refusal({ ...HOST, "hostNetwork": "true", "networkPolicy.allowCiliumIngress": "true" })).toContain(
      "networkPolicy.allowCiliumIngress adds a way in",
    );
    expect(refusal({ "networkPolicy.allowCiliumIngress": "on" })).toContain("allowCiliumIngress");
  });
});

describe("the sign-in in front of the app (oauth2-proxy)", () => {
  test("puts the web front on the pod's loopback, so the sign-in is the only way to it", () => {
    const docs = render({ ...SIGN_IN, ...ROUTE });
    expect(env(docs).TEAMS_WEB_HOST).toBe("127.0.0.1");
    expect(args(docs)).toContain("--upstream=http://127.0.0.1:19443/");
    expect(args(docs)).toContain("--http-address=0.0.0.0:4180");
    expect(sidecar(docs).ports).toEqual([{ name: "auth", containerPort: 4180, protocol: "TCP" }]);
    // The Service, the policy and so every route reach the sign-in, never the front itself.
    const [service] = of(docs, "Service").filter((s) => s.spec.clusterIP !== "None");
    expect(service.spec.ports[0]).toMatchObject({ name: "web", targetPort: "auth" });
    expect(of(docs, "NetworkPolicy")[0].spec.ingress[0].ports).toEqual([{ port: "auth", protocol: "TCP" }]);
  });

  test("probes the front from INSIDE the pod, since the kubelet cannot reach its loopback", () => {
    const app = container(render({ ...SIGN_IN, ...ROUTE }));
    for (const probe of [app.startupProbe, app.readinessProbe, app.livenessProbe]) {
      expect(probe.exec.command).toEqual(["/bin/bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/19443"]);
      expect(probe.tcpSocket).toBeUndefined();
    }
    const proxy = sidecar(render({ ...SIGN_IN, ...ROUTE }));
    expect(proxy.readinessProbe.httpGet).toEqual({ path: "/ready", port: "auth" });
    expect(proxy.livenessProbe.httpGet).toEqual({ path: "/ping", port: "auth" });
  });

  test("…and the image that probe runs in really holds bash: Debian's, which has /dev/tcp", () => {
    const dockerfile = read("packaging/docker/Dockerfile");
    expect(dockerfile).toMatch(/^ARG DEBIAN_RELEASE=trixie$/m);
    expect(dockerfile).toMatch(/^FROM debian:\$\{DEBIAN_RELEASE\}-slim$/m);
  });

  test("its values.yaml spells the Secret's command on lines a shell can paste", () => {
    const values = chartFile("values.yaml");
    expect(values).toContain("create secret generic teams-lite-oauth2-proxy \\\n");
    expect(values).toContain("--from-literal=client-secret='<from your provider>' \\\n");
  });

  test("lets in the listed addresses and nobody else", () => {
    const docs = render({ ...SIGN_IN, ...ROUTE, "auth.oauth2Proxy.emails[1]": "other@example.org" });
    expect(args(docs)).toContain("--authenticated-emails-file=/etc/oauth2-proxy/authenticated-emails");
    expect(args(docs).some((a) => a.startsWith("--email-domain"))).toBe(false);
    const [list] = of(docs, "ConfigMap").filter((c) => c.metadata.name === "teams-lite-oauth2-proxy");
    expect(list.data["authenticated-emails"].trim().split("\n")).toEqual(["you@example.com", "other@example.org"]);
    expect(mount(docs, "oauth2-proxy-emails")).toBeUndefined(); // the APP container does not see it…
    expect(sidecar(docs).volumeMounts).toEqual([{ name: "oauth2-proxy-emails", mountPath: "/etc/oauth2-proxy", readOnly: true }]);
  });

  test("keeps its secrets in the user's Secret, never in a value", () => {
    const proxy = sidecar(render({ ...SIGN_IN, ...ROUTE }));
    expect(proxy.env).toEqual([
      { name: "OAUTH2_PROXY_CLIENT_SECRET", valueFrom: { secretKeyRef: { name: "teams-lite-oauth2-proxy", key: "client-secret" } } },
      { name: "OAUTH2_PROXY_COOKIE_SECRET", valueFrom: { secretKeyRef: { name: "teams-lite-oauth2-proxy", key: "cookie-secret" } } },
    ]);
    expect(proxy.args.some((a: string) => /secret/i.test(a))).toBe(false);
  });

  test("a PUBLIC client gets the empty secret oauth2-proxy insists on, and no key of the Secret for one", () => {
    const proxy = sidecar(render({ ...SIGN_IN, ...ROUTE, "auth.oauth2Proxy.publicClient": "true" }));
    // oauth2-proxy v7.15.5 refuses an OIDC provider with no client secret (providerRequiresClientSecret),
    // and reads an empty file as the empty one: the exchange is then the client id and the verifier.
    expect(proxy.args.filter((a: string) => /secret/i.test(a))).toEqual(["--client-secret-file=/dev/null"]);
    expect(proxy.args).toContain("--code-challenge-method=S256");
    expect(proxy.env).toEqual([
      { name: "OAUTH2_PROXY_COOKIE_SECRET", valueFrom: { secretKeyRef: { name: "teams-lite-oauth2-proxy", key: "cookie-secret" } } },
    ]);
    // The flag sits right after the client id, before anything extraArgs could add.
    expect(proxy.args.indexOf("--client-secret-file=/dev/null")).toBe(proxy.args.indexOf("--client-id=client") + 1);
    expect(refusal({ ...SIGN_IN, ...ROUTE, "auth.oauth2Proxy.publicClient": "yes" })).toContain("publicClient");
  });

  // On a provider shared between organizations, an address is something another organization's
  // admin can give a user — measured: its Zitadel instance serves its public "Organization
  // Registration" form, and Zitadel lets an org owner create a user with any address marked
  // verified. A `sub` is the one value only the provider mints. Given in a values FILE, the way a
  // reader writes them: `--set` would read a Zitadel id (all digits) as a number.
  const withSubjects = <T,>(yaml: string, fn: (file: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), "teams-lite-subjects-"));
    try {
      const file = join(dir, "values.yaml");
      writeFileSync(file, `auth:\n  oauth2Proxy:\n${yaml}`);
      return fn(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("SUBJECTS pin who may sign in by the provider's own user id, as well as by address", () => {
    const a = withSubjects('    subjects: ["312345678901234567", "abc-123"]\n', (file) =>
      args(render({ ...SIGN_IN, ...ROUTE }, { valuesFile: file })),
    );
    // oauth2-proxy v7.15.5 coerces the string `sub` into a list of one (util.toStringSlice), and
    // ANDs Authorize (the groups) with the address check at the callback and on every request.
    const pinned = ["--oidc-groups-claim=sub", "--allowed-group=312345678901234567", "--allowed-group=abc-123"];
    const from = a.indexOf("--oidc-groups-claim=sub");
    expect(a.slice(from, from + 3)).toEqual(pinned);
    // Beside the address check, never instead of it.
    expect(a.indexOf("--authenticated-emails-file=/etc/oauth2-proxy/authenticated-emails")).toBe(from - 1);
    // None of it without subjects: a groups claim with no allowed group would be noise.
    const plain = args(render({ ...SIGN_IN, ...ROUTE }));
    expect(plain.some((x) => x.startsWith("--oidc-groups-claim") || x.startsWith("--allowed-group"))).toBe(false);
  });

  test("…and refuse extraArgs that would undo them", () => {
    // --oidc-groups-claim is a String flag (the last one wins), so a later one replaces `sub`.
    for (const flag of ["--oidc-groups-claim=groups", "--allowed-group=admins"]) {
      const err = withSubjects(`    subjects: ["312345678901234567"]\n    extraArgs: ["${flag}"]\n`, (file) => {
        const { ok, err } = helm(templateArgs({ ...SIGN_IN, ...ROUTE }, { valuesFile: file }));
        expect(ok).toBe(false);
        return err;
      });
      expect(err).toContain(`must not hold ${flag} beside auth.oauth2Proxy.subjects`);
    }
    // Without subjects a groups check of one's own is still extraArgs' to make.
    const groups = args(render({ ...SIGN_IN, ...ROUTE, "auth.oauth2Proxy.extraArgs[0]": "--allowed-group=admins" }));
    expect(groups).toContain("--allowed-group=admins");
  });

  test("…and the schema refuses a subject oauth2-proxy would split or misread — an UNQUOTED id too", () => {
    // --allowed-group is a StringSlice: pflag reads it as CSV, so a comma is two groups. And a
    // Zitadel id written without quotes is a YAML number — refused, never rounded to 3.12e+17.
    for (const bad of ['["a,b"]', '["a b"]', "['a\"b']", '[""]', "[312345678901234567]"]) {
      const { ok, err } = withSubjects(`    subjects: ${bad}\n`, (file) =>
        helm(templateArgs({ ...SIGN_IN, ...ROUTE }, { valuesFile: file })),
      );
      expect(ok).toBe(false);
      expect(err).toContain("/auth/oauth2Proxy/subjects/0");
    }
  });

  test("NOTES says when only the address is checked, and names the subjects when they are", () => {
    expect(notes({ ...SIGN_IN, ...ROUTE })).toContain("ONLY THE ADDRESS IS CHECKED");
    const pinned = notes({ ...SIGN_IN, ...ROUTE, "auth.oauth2Proxy.subjects[0]": "zitadel-312345678901234567" });
    expect(pinned).not.toContain("ONLY THE ADDRESS IS CHECKED");
    expect(pinned).toContain("Each must also be one of 1\nuser id at the provider (zitadel-312345678901234567)");
  });

  test("sets a cookie no sibling name can plant, that the provider's redirect back still carries", () => {
    const a = args(render({ ...SIGN_IN, ...ROUTE }));
    for (const flag of [
      "--cookie-name=__Host-teams-lite",
      "--cookie-secure=true",
      "--cookie-httponly=true",
      "--cookie-samesite=lax",
      "--cookie-expire=168h",
      "--cookie-refresh=0",
      "--skip-provider-button=true",
      "--code-challenge-method=S256",
    ]) {
      expect(a).toContain(flag);
    }
    expect(a.some((f) => /^--cookie-domain/.test(f))).toBe(false); // `__Host-` forbids one
  });

  test("answers the page's sign-in probe with a 401, on the very route the page probes", () => {
    expect(args(render({ ...SIGN_IN, ...ROUTE }))).toContain("--api-route=^/__write-token$");
    expect(read("web/src/lib/store.ts")).toContain('const WRITE_TOKEN_PATH = "/__write-token";');
    expect(read("web/write-token.ts")).toContain('export const WRITE_TOKEN_ROUTE = "/__write-token";');
  });

  test("lets through exactly what installing the app takes, and nothing that names a route", () => {
    const routes = skipRoutes(render({ ...SIGN_IN, ...ROUTE }));
    const open = (path: string) => routes.some((r) => r.test(path));
    const manifest = JSON.parse(read("web/public/manifest.webmanifest")) as { icons: { src: string }[] };
    const files = [
      "/manifest.webmanifest",
      "/favicon.svg",
      "/favicon.ico",
      "/icons/apple-touch-icon-180.png",
      ...manifest.icons.map((icon) => icon.src),
    ];
    for (const path of files) expect(open(path), path).toBe(true);
    for (const path of [
      "/",
      "/__write-token",
      "/__backend",
      "/icons/../__write-token",
      "/icons/x/y.png",
      "/icons/.png",
      "/manifest.webmanifest/x",
      "/x/manifest.webmanifest",
      "/favicon.svg.map",
    ]) {
      expect(open(path), path).toBe(false);
    }
  });

  test("runs as its own non-root user with no privilege, whatever the app beside it needs", () => {
    const proxy = sidecar(render({ ...SIGN_IN, ...ROUTE }));
    expect(proxy.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 65532,
      runAsGroup: 65532,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(container(render({ ...SIGN_IN, ...ROUTE })).securityContext.privileged).toBe(true);
  });

  test("keeps kubectl's logs and exec on the app's container", () => {
    const template = statefulSet(render({ ...SIGN_IN, ...ROUTE })).spec.template;
    expect(template.metadata.annotations["kubectl.kubernetes.io/default-container"]).toBe("teams-lite");
    expect(pod(render({ ...SIGN_IN, ...ROUTE })).containers[0].name).toBe("teams-lite");
  });

  test("derives its callback from the first route hostname, or takes the one it is given", () => {
    expect(args(render({ ...SIGN_IN, ...ROUTE }))).toContain("--redirect-url=https://teams.example.com/oauth2/callback");
    const named = render({ ...SIGN_IN, ...ROUTE, "auth.oauth2Proxy.redirectUrl": "https://login.example.com/oauth2/callback" });
    expect(args(named)).toContain("--redirect-url=https://login.example.com/oauth2/callback");
    expect(env(named).TEAMS_LITE_ALLOWED_HOSTS).toBe("teams.example.com,login.example.com");
    const ingress = render({
      ...SIGN_IN,
      "ingress.enabled": "true",
      "ingress.className": "nginx",
      "ingress.hosts[0].host": "teams.example.internal",
      "networkPolicy.allowNamespaces[0]": "ingress-nginx",
    });
    expect(args(ingress)).toContain("--redirect-url=https://teams.example.internal/oauth2/callback");
  });

  test("works in a host mode too, and pins its own image", () => {
    const docs = render({ ...HOST, ...SIGN_IN, ...ROUTE, "auth.oauth2Proxy.image.digest": `sha256:${"a".repeat(64)}` });
    expect(sidecar(docs).image).toBe(`quay.io/oauth2-proxy/oauth2-proxy@sha256:${"a".repeat(64)}`);
    expect(env(docs).TEAMS_WEB_HOST).toBe("127.0.0.1");
    expect(env(docs).TEAMS_LITE_INTUNE_MODE).toBe("host");
  });

  test("is refused without what it needs, and on the node's network", () => {
    for (const [key, words] of [
      ["auth.oauth2Proxy.issuerUrl", "auth.oauth2Proxy.issuerUrl is required"],
      ["auth.oauth2Proxy.clientId", "auth.oauth2Proxy.clientId is required"],
      ["auth.oauth2Proxy.existingSecret", "auth.oauth2Proxy.existingSecret is required"],
    ] as const) {
      expect(refusal({ ...SIGN_IN, ...ROUTE, [key]: "" })).toContain(words);
    }
    const { "auth.oauth2Proxy.emails[0]": _e, ...nobody } = SIGN_IN;
    expect(refusal({ ...nobody, ...ROUTE })).toContain("auth.oauth2Proxy.emails is required");
    expect(refusal({ ...SIGN_IN, "networkPolicy.allowNamespaces[0]": "x" })).toContain("needs a redirect URL");
    expect(refusal({ ...HOST, ...SIGN_IN, hostNetwork: "true" })).toContain("auth.oauth2Proxy.enabled needs hostNetwork=false");
  });

  test("its schema refuses an issuer over http, an address that is not one, and a flag that is not a flag", () => {
    expect(refusal({ ...SIGN_IN, ...ROUTE, "auth.oauth2Proxy.issuerUrl": "http://idp.example.com" })).toContain("issuerUrl");
    for (const email of ["*", "@example.com", "example.com", "a@*.example.com", "a b@example.com"]) {
      expect(refusal({ ...SIGN_IN, ...ROUTE, "auth.oauth2Proxy.emails[0]": email }), email).toContain("emails");
    }
    expect(refusal({ ...SIGN_IN, ...ROUTE, "auth.oauth2Proxy.extraArgs[0]": "email-domain=*" })).toContain("extraArgs");
    expect(refusal({ ...SIGN_IN, ...ROUTE, "web.allowedHosts[0]": "*" })).toContain("allowedHosts");
  });

  test("extraEnv cannot move the front out from behind it, nor write the names the app answers to", () => {
    expect(refusal({ ...SIGN_IN, ...ROUTE, "extraEnv[0].name": "TEAMS_WEB_HOST", "extraEnv[0].value": "0.0.0.0" })).toContain(
      "extraEnv must not set TEAMS_WEB_HOST",
    );
    expect(refusal({ "extraEnv[0].name": "TEAMS_LITE_ALLOWED_HOSTS", "extraEnv[0].value": "*" })).toContain(
      "extraEnv must not set TEAMS_LITE_ALLOWED_HOSTS",
    );
  });

  test("the notes say who may sign in, where, and the way around it from this machine", () => {
    const said = notes({ ...SIGN_IN, ...ROUTE });
    expect(said).toContain("lets in\n1 address and nobody else (You@Example.com)");
    expect(said).toContain("Register https://teams.example.com/oauth2/callback as the client's redirect URI");
    expect(said).toContain("port-forward pod/teams-lite-0 19443:19443");
  });
});

describe("the app's own address and origin checks, as the chart feeds them", () => {
  test("the names the chart adds are the ones the app reads", () => {
    expect(read("web/request-origin.ts")).toContain('export const ALLOWED_HOSTS_ENV = "TEAMS_LITE_ALLOWED_HOSTS";');
    const docs = render({ ...SIGN_IN, ...ROUTE, "web.allowedHosts[0]": ".corp.example", "web.allowedHosts[1]": "teams.example.com" });
    expect(env(docs).TEAMS_LITE_ALLOWED_HOSTS).toBe("teams.example.com,.corp.example");
  });

  test("a release with no route names nothing: loopback, IPs and tailnet names need no telling", () => {
    expect(env(render()).TEAMS_LITE_ALLOWED_HOSTS).toBeUndefined();
  });

  test("the server pings under the idle limit the docs name for ingress-nginx (60 s)", () => {
    const server = read("web/server.ts");
    const socket = server.slice(server.indexOf("websocket: {"));
    const idle = Number(socket.match(/idleTimeout: (\d+),/)?.[1]);
    // Bun pings a socket quiet for HALF its idleTimeout (measured), and the docs promise 25 s.
    expect(idle / 2).toBe(25);
    expect(chartFile("README.md")).toContain("the app's server pings any socket quiet for 25 s");
    expect(chartFile("values.yaml")).toContain("The app's server pings any\n  # socket quiet for 25 s");
  });
});

describe("annotations", () => {
  test("keep a values FILE's whole numbers whole, where `toString` would write 3.1536e+07", () => {
    const dir = mkdtempSync(join(tmpdir(), "teams-lite-annotations-"));
    try {
      const file = join(dir, "values.yaml");
      writeFileSync(file, "service:\n  annotations:\n    a.example/big: 31536000\n    a.example/frac: 1.5\n");
      const [service] = of(render({}, { valuesFile: file }), "Service").filter((d) => d.metadata.annotations);
      expect(service.metadata.annotations).toEqual({ "a.example/big": "31536000", "a.example/frac": "1.5" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("are rendered as strings, so `--set …=true` or `=3600` is still a manifest the API accepts", () => {
    const docs = render({
      ...SIGN_IN,
      ...ROUTE,
      "ingress.enabled": "true",
      "ingress.className": "nginx",
      "ingress.annotations.nginx\\.ingress\\.kubernetes\\.io/proxy-read-timeout": "3600",
      "httpRoute.annotations.example\\.com/flag": "true",
      "service.annotations.a": "1",
      "podAnnotations.b": "false",
    });
    expect(of(docs, "Ingress")[0].metadata.annotations["nginx.ingress.kubernetes.io/proxy-read-timeout"]).toBe("3600");
    expect(of(docs, "HTTPRoute")[0].metadata.annotations["example.com/flag"]).toBe("true");
    expect(of(docs, "Service").find((d) => d.metadata.annotations)?.metadata.annotations.a).toBe("1");
    expect(statefulSet(docs).spec.template.metadata.annotations.b).toBe("false");
  });
});

describe("the README's own public values file", () => {
  test("renders the sign-in and the route it describes", () => {
    const readme = chartFile("README.md");
    const block = readme.match(/<!-- public-values[^>]*-->\s*```yaml\n([\s\S]*?)```/)?.[1];
    expect(block, "the README's public.yaml block").toBeTruthy();
    const dir = mkdtempSync(join(tmpdir(), "teams-lite-public-"));
    try {
      const file = join(dir, "public.yaml");
      writeFileSync(file, block!.replace(/^ {3}/gm, ""));
      const docs = render({}, { valuesFile: file });
      expect(of(docs, "HTTPRoute")).toHaveLength(1);
      expect(sidecar(docs)).toBeDefined();
      expect(env(docs).TEAMS_WEB_HOST).toBe("127.0.0.1");
      expect(args(docs)).toContain("--redirect-url=https://teams.example.com/oauth2/callback");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the refusals", () => {
  test("a host mode with no broker to reach is no pod", () => {
    expect(refusal({ "broker.mode": "intuneContainer" })).toContain("broker.intuneContainer.stateDir is required");
    expect(refusal({ "broker.mode": "sessionBus" })).toContain("broker.sessionBus.socket is required");
    expect(refusal({ ...HOST, "broker.intuneContainer.stateDir": "relative/path" })).toContain("stateDir");
    expect(refusal({ "broker.mode": "somewhere" })).toContain("mode");
  });

  test("root is refused, since the broker refuses it too", () => {
    expect(refusal({ ...HOST, "hostUser.uid": "0" })).toContain("uid");
  });

  test("neither the store nor the Intune state ever gets a shared volume", () => {
    expect(refusal({ "persistence.accessModes[0]": "ReadWriteMany" })).toContain("accessModes");
    expect(refusal({ "broker.embedded.persistence.accessModes[0]": "ReadWriteMany" })).toContain("accessModes");
  });

  test("the embedded mode refuses the node's network, whose :99 its own Intune container would fight", () => {
    const err = refusal({ hostNetwork: "true" });
    expect(err).toContain("hostNetwork=true is refused with broker.mode=embedded");
    expect(err).toContain("@/tmp/.X11-unix/X99");
  });

  test("a value of the embedded mode is never quietly ignored by a host mode", () => {
    expect(refusal({ ...HOST, "broker.embedded.userNamespaces": "true" })).toContain(
      "broker.embedded.userNamespaces applies to broker.mode=embedded only",
    );
    expect(refusal({ ...BUS, "broker.embedded.import.secretName": "enroll" })).toContain(
      "broker.embedded.import.secretName applies to broker.mode=embedded only",
    );
  });

  test("a host mode's own value with no mode beside it is a host install that forgot to say so", () => {
    // The embedded mode is the DEFAULT, so the README's old host command — stateDir, no mode —
    // rendered a pod that ignored the node's enrollment and offered to enroll a second device.
    // The mode is never inferred; it is named for the reader instead.
    const state = refusal({ "broker.intuneContainer.stateDir": STATE });
    expect(state).toContain("broker.intuneContainer.stateDir is set, but broker.mode is embedded");
    expect(state).toContain("--set broker.mode=intuneContainer");
    const bus = refusal({ "broker.sessionBus.socket": "/run/user/1000/bus" });
    expect(bus).toContain("broker.sessionBus.socket is set, but broker.mode is embedded");
    expect(bus).toContain("--set broker.mode=sessionBus");
    // A read-only release is not an exception: the value still names the wrong install.
    expect(refusal({ readOnly: "true", "broker.intuneContainer.stateDir": STATE })).toContain("--set broker.mode=intuneContainer");
    // …while the same values beside their own mode are exactly what that mode needs.
    expect(env(render(HOST)).TEAMS_LITE_INTUNE_MODE).toBe("host");
    expect(env(render(BUS)).TEAMS_LITE_INTUNE_MODE).toBe("host");
  });

  test("the embedded pod's security context cannot be made to start as anybody but root, nor re-group its claims", () => {
    // fsGroup DAMAGES: a recursive re-group of the subordinate-id rootfs and the 0600 keyring — so
    // any value, 0 included, and in a read-only release too, which still mounts the Intune claim.
    for (const set of [
      { "podSecurityContext.fsGroup": "1000" },
      { "podSecurityContext.fsGroup": "0" },
      { readOnly: "true", "podSecurityContext.fsGroup": "1000" },
    ]) {
      const err = refusal(set);
      expect(err).toContain("podSecurityContext.fsGroup is refused with broker.mode=embedded");
      expect(err).toContain("0600 keyring");
    }
    // runAsUser and runAsNonRoot FAIL: the entrypoint must start as root, at either level.
    for (const level of ["podSecurityContext", "securityContext"]) {
      const user = refusal({ [`${level}.runAsUser`]: "1000" });
      expect(user).toContain(`${level}.runAsUser is refused with broker.mode=embedded`);
      expect(user).toContain("Started as uid 1000");
      expect(refusal({ [`${level}.runAsNonRoot`]: "true" })).toContain(`${level}.runAsNonRoot is refused with broker.mode=embedded`);
      expect(refusal({ readOnly: "true", [`${level}.runAsUser`]: "1000" })).toContain("must START AS ROOT");
    }
    // What says "root" in those fields is root, and not refused; other fields still merge.
    const rooted = render({
      "podSecurityContext.runAsUser": "0",
      "podSecurityContext.runAsNonRoot": "false",
      "podSecurityContext.supplementalGroups[0]": "5",
    });
    expect(pod(rooted).securityContext).toMatchObject({ runAsUser: 0, runAsNonRoot: false, supplementalGroups: [5] });
    // A host mode sets its own uid and fsGroup, and is untouched by the rule.
    expect(pod(render({ ...HOST, "podSecurityContext.fsGroup": "1005" })).securityContext.fsGroup).toBe(1005);
  });

  test("the user-namespace opt-in is refused below Kubernetes 1.30", () => {
    expect(refusal({ "broker.embedded.userNamespaces": "true" }, { kubeVersion: "1.29.9" })).toContain(
      "needs Kubernetes 1.30 or later",
    );
    expect(pod(render({ "broker.embedded.userNamespaces": "true" }, { kubeVersion: "1.30.0" })).hostUsers).toBe(false);
    // The privileged default has no such floor.
    expect(container(render({}, { kubeVersion: "1.25.0" })).securityContext.privileged).toBe(true);
  });

  test("the mode is the chart's to write, and an import has one source", () => {
    expect(refusal({ "extraEnv[0].name": "TEAMS_LITE_INTUNE_MODE", "extraEnv[0].value": "host" })).toContain(
      "extraEnv must not set TEAMS_LITE_INTUNE_MODE",
    );
    expect(
      refusal({
        "broker.embedded.import.secretName": "enroll",
        "extraEnv[0].name": "TEAMS_LITE_INTUNE_IMPORT",
        "extraEnv[0].value": "/elsewhere.tar.gz",
      }),
    ).toContain("two answers to which enrollment to import");
  });

  test("an import Secret is named as Kubernetes names one", () => {
    expect(refusal({ "broker.embedded.import.secretName": "Enroll_Me" })).toContain("secretName");
    expect(refusal({ "broker.embedded.import.secretName": "enroll", "broker.embedded.import.key": "a/b" })).toContain("key");
  });

  test("nothing is drawn that a node's loopback cannot back", () => {
    expect(
      refusal({ ...HOST, hostNetwork: "true", "ingress.enabled": "true", "ingress.className": "tailscale" }),
    ).toContain("ingress.enabled needs hostNetwork=false");
    expect(refusal({ ...HOST, hostNetwork: "true", "service.type": "NodePort" })).toContain("service.type must stay ClusterIP");
  });

  test("a typo is an error at every level the chart defines, never a default", () => {
    // A misspelled uid would deploy as the image's 1000; a misspelled `enabled` would drop the policy.
    expect(refusal({ ...HOST, "hostUser.uidd": "1001" })).toContain("uidd");
    expect(refusal({ "networkPolicy.enable": "false" })).toContain("enable");
    expect(refusal({ "persistence.existingclaim": "mine" })).toContain("existingclaim");
    expect(refusal({ "image.Digest": `sha256:${"a".repeat(64)}` })).toContain("Digest");
    expect(refusal({ "broker.intuneContainer.statedir": "/x" })).toContain("statedir");
    // …and in the embedded mode's own: a misspelled opt-in, Secret or size must not be dropped.
    expect(refusal({ "broker.embedded.userNamespace": "true" })).toContain("userNamespace");
    expect(refusal({ "broker.embedded.import.secretname": "enroll" })).toContain("secretname");
    expect(refusal({ "broker.embedded.persistence.sizee": "20Gi" })).toContain("sizee");
    expect(refusal({ "broker.embedded.persistance.size": "20Gi" })).toContain("persistance");
  });

  test("an Ingress is never handed to a default class, nor drawn where nothing could reach it", () => {
    expect(refusal({ "ingress.enabled": "true", "networkPolicy.allowNamespaces[0]": "x" })).toContain(
      "ingress.enabled needs ingress.className",
    );
    expect(refusal({ "ingress.enabled": "true", "ingress.className": "tailscale" })).toContain(
      "NetworkPolicy that lets nothing in",
    );
  });

  test("the session bus must be the node user's own", () => {
    expect(refusal({ ...BUS, "broker.sessionBus.socket": "/run/user/1001/bus" })).toContain("belongs to uid 1001");
    expect(refusal({ ...BUS, "broker.sessionBus.socket": "/tmp/dbus-x" })).toContain("socket");
  });
});

describe("what the chart's own words claim", () => {
  test("every command the README hands a reader renders, in the mode it names — the default first", () => {
    const commands = readmeCommands();
    const modeOf = (set: Record<string, string>) => set["broker.mode"] ?? "embedded";
    // It LEADS with the self-contained default, with no host value in it…
    expect(commands[0].text).toStartWith("helm install teams-lite oci://");
    expect(Object.keys(commands[0].set)).toEqual([]);
    // …and gives each host mode with its mode spelled out, so none of it can pass vacuously.
    expect(commands.map((c) => modeOf(c.set))).toEqual(expect.arrayContaining(["embedded", "intuneContainer", "sessionBus"]));
    for (const { text, set } of commands) {
      let docs: Doc[];
      try {
        docs = render(set, { kubeVersion: "1.33.0" });
      } catch (error) {
        throw new Error(`the README's \`${text}\` does not render: ${(error as Error).message}`);
      }
      expect({ text, mode: env(docs).TEAMS_LITE_INTUNE_MODE }).toEqual({
        text,
        mode: modeOf(set) === "embedded" ? "embedded" : "host",
      });
    }
  });

  test("the embedded pod's node is said with the kernel it needs, wherever a reader meets it", () => {
    // Ubuntu 23.10+ ships kernel.apparmor_restrict_unprivileged_userns=1, and the crate refuses to
    // boot on that VALUE — so "any node" was false for the distribution Intune supports.
    const sysctl = "kernel.apparmor_restrict_unprivileged_userns=0";
    const values = chartFile("values.yaml");
    const readme = chartFile("README.md");
    expect(values).toContain(sysctl);
    expect(readme).toContain(sysctl);
    expect(notes()).toContain(sysctl);
    // No "any node" is left standing without the condition beside it.
    for (const text of [values, readme]) {
      for (const match of text.matchAll(/any node/gi)) {
        const after = text.slice(match.index, match.index + 80).replace(/[*#\s]+/g, " ").toLowerCase();
        expect(after).toContain("permit");
      }
    }
    // And no profile is offered as a way past a check that reads the sysctl's value.
    expect(readme.replace(/\s+/g, " ")).toContain("neither `privileged` nor an AppArmor profile");
  });

  test("the banner a reader is told to expect during the first download is the one the app draws", () => {
    // The app draws the first sentence while the crate has not finished its setup (the download)
    // and the second on every later boot (web/src/components/broker-banner.tsx).
    const banner = /firstStart \? "([^"]+)" : "([^"]+)"/.exec(read("web/src/components/broker-banner.tsx"));
    expect(banner).not.toBeNull();
    const [, settingUp, starting] = banner!;
    expect(settingUp).toBe("Setting up the Intune container…");
    const readme = prose(chartFile("README.md"));
    expect(readme).toContain(`says "${settingUp}" while that first download runs — "${starting}" on every later boot`);
    expect(prose(notes())).toContain(`the app says "${settingUp}" meanwhile ("${starting}" on a later boot)`);
  });

  test("an enrollment is imported into the INSTALLED release with an upgrade, never a second install", () => {
    // A second `helm install` of the name the quick start used is refused outright. The import is
    // a pod-template change, so an upgrade rolls the pod and the next boot imports — while no
    // registration exists, which the words have to say.
    const importing = readmeCommands().filter((c) => c.set["broker.embedded.import.secretName"]);
    expect(importing.length).toBeGreaterThan(0);
    for (const { text } of importing) {
      expect(text).toStartWith("helm upgrade teams-lite oci://");
      expect(text).toContain("--reuse-values");
      // PINNED to the chart the release runs (below), and stopped rather than run unpinned.
      expect(text).toContain('--version "${version:?');
    }
    const readme = prose(chartFile("README.md"));
    expect(readme).toContain("version=$(helm -n teams-lite get metadata teams-lite -o json | jq -r .version)");
    expect(readme).toContain("only while its own state holds no device registration");
    expect(readme).toContain("So do it BEFORE enrolling from the app");
  });

  test("no upgrade a doc advises reuses values unpinned — it would render the NEWEST chart against the OLD defaults", () => {
    // Helm's --reuse-values REPLACES the new chart's values with the old release's coalesced ones,
    // and with no --version an oci:// reference is the newest chart CI published. Against this
    // chart's strict schema that fails as soon as a key moved, and where it renders it moves the
    // image. So every `helm … upgrade` that reuses values names a version, in every file that
    // tells a reader to type one: commands in code, in inline spans, and in comments alike.
    const files = [
      "README.md",
      "AGENTS.md",
      "packaging/helm/teams-lite/README.md",
      "packaging/helm/teams-lite/values.yaml",
      "packaging/helm/teams-lite/templates/NOTES.txt",
    ];
    const reusing: string[] = [];
    for (const file of files) {
      const text = read(file)
        .replace(/^[ \t]*# ?/gm, "")
        .replace(/\\\n\s*/g, " ");
      for (const [command] of text.matchAll(/helm (?:-n \S+ )?upgrade\b[^\n`]*/g)) {
        if (!command.includes("--reuse-values")) continue;
        reusing.push(command);
        expect({ file, command, pinned: command.includes("--version ") }).toEqual({ file, command, pinned: true });
      }
    }
    // Not vacuous: the import (both READMEs, values.yaml) and the read-only switch (NOTES) are here.
    expect(reusing.length).toBeGreaterThanOrEqual(4);
    // And what replaces it for a move to a NEWER chart is the flag that keeps the new defaults.
    expect(prose(chartFile("README.md"))).toContain("pass `--reset-then-reuse-values` (Helm 3.14 or later)");
  });

  test("a read-only release is said to show only the store it is given — and a new one's is empty", () => {
    // values.yaml's words are its comments, read with their `#` taken off.
    const values = prose(chartFile("values.yaml").replace(/^[ \t]*# ?/gm, ""));
    expect(values).not.toContain("Useful to look at the cluster install");
    expect(values).toContain("A NEW release installed read-only gets a claim of its own, fresh and EMPTY");
    expect(values).toContain("persistence.existingClaim");
    expect(prose(chartFile("README.md"))).toContain("the app then starts and shows nothing at all");
    expect(prose(notes({ readOnly: "true" }))).toContain("fresh store claim that is EMPTY and stays so");
  });

  test("the read-only root filesystem is not claimed measured on the image it is not measured on", () => {
    // The `--read-only` run was of the host-only image before the embedded mode: the current one
    // starts as root and boots an Intune container, and has not been run that way.
    const readme = prose(chartFile("README.md"));
    expect(readme).toContain("measured only on the host-only image that preceded the embedded mode");
    expect(readme).toContain("has NOT been run on a read-only root");
    expect(readme).not.toContain("The root filesystem stays read-only — measured for the app itself");
  });

  test("a stop's cost to the calling registration is said as the launcher really pays it", () => {
    // The launcher SIGKILLs its backend on TERM, so the registration is never handed back and
    // expires on its own. Make the launcher hand it back and this fails, and the words move with it.
    const launcher = read("launcher/src/backend.ts");
    expect(launcher).toMatch(/const stop = \(\) => \{\s*generation \+= 1;\s*try \{\s*proc\.kill\(9\);/);
    expect(launcher).toMatch(/process\.on\(signal, \(\) => \{\s*stop\(\);\s*process\.exit\(0\);/);
    expect(/const CALLING_TTL: u64 = (\d+);/.exec(read("src/trouter.rs"))?.[1]).toBe("3600");
    const values = chartFile("values.yaml");
    const start = values.indexOf("# A CEILING, not a delay");
    const end = values.indexOf("terminationGracePeriodSeconds: null");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const grace = values.slice(start, end);
    expect(grace).toContain("SIGKILLs its backend");
    expect(grace).toContain("its TTL is an hour");
    expect(grace).not.toMatch(/hands its calling registration back and/);
    expect(chartFile("README.md")).toContain("the launcher SIGKILLs its backend");
  });
});

describe("the image CI publishes", () => {
  const workflow = Bun.YAML.parse(read(".github/workflows/build.yml")) as Doc;
  const steps = (job: string): Doc[] => workflow.jobs[job].steps;

  test("is the Dockerfile's, for amd64 and uid 1000, after the gate", () => {
    expect(workflow.jobs.image.needs).toBe("build");
    const push = steps("image").find((s) => s.id === "push")!;
    expect(push.with.file).toBe("packaging/docker/Dockerfile");
    expect(push.with.platforms).toBe("linux/amd64");
    expect(push.with["build-args"]).toContain("UID=1000");
    expect(push.with["build-args"]).toContain("GID=1000");
    // The tag is the release's own name, spelled once in the build job.
    expect(workflow.jobs.build.outputs.tag).toBeDefined();
    expect(JSON.stringify(steps("image"))).toContain("needs.build.outputs.tag");
  });

  test("describes both shapes the image runs in, its own Intune container first", () => {
    const meta = steps("image").find((s) => s.id === "meta")!;
    const description = /org\.opencontainers\.image\.description=(.*)/.exec(meta.with.labels)?.[1] ?? "";
    expect(description).toContain("its own Intune container");
    expect(description).toContain("host's identity broker");
  });

  test("ships a chart stamped for the repository that publishes it", () => {
    expect(workflow.jobs.chart.needs).toEqual(["image", "chart-check"]);
    expect(JSON.stringify(steps("chart"))).toContain("packaging/helm/package.sh");
    expect(JSON.stringify(steps("chart-check"))).toContain("packaging/helm/check.sh");
    // A publish that started is never cancelled by the next push.
    for (const job of ["image", "chart"]) {
      expect(workflow.jobs[job].concurrency["cancel-in-progress"]).toBe(false);
    }
  });
});
