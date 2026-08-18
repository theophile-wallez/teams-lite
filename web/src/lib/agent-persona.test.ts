// The page's half of a CUSTOM AGENT: which names it accepts, what it repairs as they are
// typed, and why a name may be refused.
//
// Every rule here is a PORT of one in src/agent_persona.rs, and the two must agree: the name
// becomes part of a `@…` word the backend has to find in a sentence, so a name this side
// accepts and that side refuses is a row the user can type and never save — and one this side
// refuses and that side would take is a feature they cannot reach. The Rust tests pin the
// same cases (`a_name_is_one_lowercase_word`, `a_persona_may_not_take_a_providers_name`).

import { describe, expect, it } from "vitest";
import type { AgentStatus } from "./agent";
import {
  agentPersonaNamed,
  agentPersonas,
  isValidPersonaName,
  personaBackend,
  personaNameFrom,
  personaNameProblem,
  type AgentPersona,
} from "./agent-persona";

function persona(overrides: Partial<AgentPersona> = {}): AgentPersona {
  return {
    name: "bebou",
    label: "Bebou",
    prefix: "@bebou",
    backend: "claude",
    model: null,
    preprompt: "/bebou",
    has_avatar: false,
    added_ms: 1,
    updated_ms: 1,
    ...overrides,
  };
}

function status(personas: AgentPersona[] = []): AgentStatus {
  return {
    backends: [
      { name: "claude", prefix: "@claude", available: true, enabled: true, model: null, models: [] },
      {
        name: "opencode",
        prefix: "@opencode",
        available: false,
        enabled: true,
        model: null,
        models: [],
      },
    ],
    personas,
    conversations: [],
    tools: [],
    workspace: "/home/me/code",
    enabled: true,
    sandbox_conversation: "19:sandbox@thread.v2",
  };
}

describe("isValidPersonaName", () => {
  it("takes one lowercase word", () => {
    for (const good of ["bebou", "natacha", "review-bot", "r2_d2", "b"]) {
      expect(isValidPersonaName(good), good).toBe(true);
    }
    expect(isValidPersonaName("a".repeat(24))).toBe(true);
  });

  it("refuses anything that could not be an address", () => {
    // Each of these breaks a rule the backend reads a `@…` with: a capital is a second
    // spelling of one name, a space is two words, and a `.` collides with a sentence ending
    // on an address (`@bebou.` against `agent_policy::ends_address`).
    for (const bad of ["", "Bebou", "review bot", "bebou.", "bebou!", "@bebou", "-bebou", "é", "a".repeat(25)]) {
      expect(isValidPersonaName(bad), bad).toBe(false);
    }
  });
});

describe("personaNameFrom", () => {
  it("repairs what a reader naturally types", () => {
    // A courtesy, not a check: refusing a capital teaches the charset one keystroke at a
    // time, and "@Review Bot" plainly means `review-bot`.
    expect(personaNameFrom("Bebou")).toBe("bebou");
    expect(personaNameFrom("@bebou")).toBe("bebou");
    expect(personaNameFrom("  Review Bot ")).toBe("review-bot");
  });

  it("leaves what it cannot repair to be refused", () => {
    // An accent survives, so `isValidPersonaName` says so rather than this silently
    // inventing a name the user did not type.
    expect(personaNameFrom("Béboû")).toBe("béboû");
    expect(isValidPersonaName(personaNameFrom("Béboû"))).toBe(false);
  });
});

describe("personaNameProblem", () => {
  it("refuses the name of an AI provider", () => {
    // The one rule here that is about correctness rather than tidiness: `@claude` resolves to
    // the provider before any persona, so an agent called `claude` could never be summoned —
    // and its author would believe its instructions led every `@claude` run.
    expect(personaNameProblem(status(), "claude")).toContain("@claude");
    expect(personaNameProblem(status(), "opencode")).toContain("@opencode");
  });

  it("refuses a name already taken, and never the one being edited", () => {
    const held = status([persona()]);
    expect(personaNameProblem(held, "bebou")).toContain("@bebou");
    // Editing `bebou` must not be refused because `bebou` exists.
    expect(personaNameProblem(held, "bebou", "bebou")).toBeNull();
    expect(personaNameProblem(held, "natacha")).toBeNull();
  });

  it("says what is wrong with a name that could not be an address", () => {
    expect(personaNameProblem(status(), "")).toContain("name");
    expect(personaNameProblem(status(), "review bot")).toContain("Lowercase");
  });
});

describe("agentPersonas", () => {
  it("is empty on a backend too old to publish any", () => {
    const older = status();
    delete older.personas;
    expect(agentPersonas(older)).toEqual([]);
    expect(agentPersonas(null)).toEqual([]);
  });

  it("finds one by address, without case", () => {
    const held = status([persona()]);
    expect(agentPersonaNamed(held, "BEBOU")?.label).toBe("Bebou");
    expect(agentPersonaNamed(held, "nobody")).toBeNull();
    expect(agentPersonaNamed(held, null)).toBeNull();
  });
});

describe("personaBackend", () => {
  it("names the provider a persona runs, when this machine knows it", () => {
    expect(personaBackend(status(), persona())?.name).toBe("claude");
    // A provider this backend never listed is null rather than a guess — the caller then
    // draws nothing that claims to work.
    expect(personaBackend(status(), persona({ backend: "gemini" }))).toBeNull();
  });
});
