//! A CUSTOM AGENT: one of the user's own personas, addressed by a name of its own.
//!
//! `@claude` summons a CLI. `@bebou` summons the same CLI wearing a face, a name and a
//! standing instruction the user wrote — so a thread can hold a review bot, a French
//! boomer aunt and an ordinary assistant, each addressed by who it is rather than by
//! which program runs it.
//!
//! # A persona names an AGENT, never a PROGRAM
//!
//! That is the whole safety story, and it is why this module holds no path and no
//! command. [`crate::agent_policy::BACKENDS`] is a static table for a stated reason —
//! "the program a Teams message can start is not something a message, or a client that
//! found the backend socket, gets to choose" — and a persona is a row that POINTS at one
//! of its entries ([`Persona::backend`], resolved through
//! [`crate::agent_policy::backend_named`] at parse time). What a persona adds is a name
//! to address it by, a picture, a model already inside
//! [`crate::agent_policy::is_valid_model`], and text prepended to the prompt. A stored
//! row naming a backend this build does not hold resolves to NOTHING and is dropped, so
//! the set of programs a message can start is exactly what it was before this file
//! existed.
//!
//! Everything else about the feature is untouched by design, and each omission is a
//! decision:
//!
//! - **The tool allowlist stays machine-wide.** A persona cannot widen what an agent may
//!   do ([`crate::agent::TOOL_GRANTS`] is the one consent surface for that), because a
//!   name and a picture are not a consent gate — a "deploy bot" must not be able to hold
//!   permissions its author granted by naming it.
//! - **A conversation still has to be opted in.** A persona is summoned through the same
//!   [`crate::agent_policy::command_for`] as `@claude`, so `Mode::Off` refuses it and the
//!   `from_me` gate holds. Adding a persona is not adding a place to post.
//! - **A persona is LOCAL, and nothing here travels.** It is the user's own arrangement
//!   of their own machine, like a nickname or a pinned chat: the reply names it in the
//!   line it signs itself with, so this app draws the right face and the loop guard still
//!   recognises an answer — and no other machine is offered the record. The preprompt in
//!   particular is the user's own words about their own agent, and the one thing a
//!   signature could carry is a name.
//!
//! # The preprompt is INVISIBLE, and that is what it is for
//!
//! It leads the prompt (see [`Persona::lead`]) and appears in no message body. A persona
//! whose preprompt is `/review` turns every request into a review; one that spells out a
//! character turns every answer into that character. The reader of the thread sees the
//! answer and the name above it, which is the whole point — the instruction is scaffolding,
//! and printing it would put the user's own prompt engineering in front of their
//! colleagues.

use crate::agent_policy::{self, Backend};

/// How long a persona's name may be. It is an ADDRESS, typed in a message and read back
/// out of one, so it is short for the reason a nickname is short.
pub const MAX_NAME_CHARS: usize = 24;

/// How long the name a reader SEES may be. Longer than the address, because a label is
/// allowed spaces and capitals ("Natacha", "Review bot") — and bounded, because it is
/// drawn in a chip beside a message.
pub const MAX_LABEL_CHARS: usize = 40;

/// How long a preprompt may be. It travels with every single request this persona
/// answers, on top of the thread transcript and the user's own words, so it is a standing
/// instruction rather than a document. `agent_policy::MAX_PROMPT_CHARS` bounds what the
/// USER writes; this bounds what the machine adds to it.
pub const MAX_PREPROMPT_CHARS: usize = 4_000;

/// The picture types a persona's face may be, sniffed from the bytes. The same four
/// `PERSON_AVATAR_TYPES` allows, for the same reason: SVG is a document, not a bitmap.
pub const AVATAR_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/// The most an avatar may weigh. A face is drawn at 20 px in a chip and 36 px on a
/// bubble, so this is generous already — and the bytes live in this machine's SQLite
/// file, which every read of the pack pays for.
pub const MAX_AVATAR_BYTES: usize = 2 * 1024 * 1024;

/// One of the user's custom agents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Persona {
    /// The ADDRESS, without its `@`: `bebou` is written `@bebou`. Lowercase and one word,
    /// because that is what `agent_policy::address_in` can find in a sentence.
    pub name: String,
    /// The name a reader sees, when it differs from the address: "Natacha" for `natacha`.
    /// Empty means the address is the label ([`Persona::label`] resolves it).
    pub label: String,
    /// The agent that really runs. Resolved at parse time, so a persona can never carry a
    /// program this build does not hold — see the module docs.
    pub backend: &'static Backend,
    /// The model this persona runs, overriding the provider's own choice. `None` inherits,
    /// which is what a persona that is only a character wants.
    pub model: Option<String>,
    /// What leads every prompt this persona answers, and appears in no message body.
    pub preprompt: String,
    /// The face, when the user gave it one: the sniffed content type and its pixel shape.
    /// The bytes stay in the store and are served on their own (`agent_persona_avatar`),
    /// because a list of ten personas must not carry ten pictures.
    pub avatar: Option<Avatar>,
    /// When the row was first written, and when it last changed.
    pub added_ms: i64,
    pub updated_ms: i64,
}

/// What is known about a persona's face without reading its bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Avatar {
    pub content_type: String,
    pub width: u32,
    pub height: u32,
}

impl Persona {
    /// The name a reader sees: their own label, else the address itself.
    ///
    /// One function because four surfaces ask — the chip in the composer, the mark on the
    /// bubble, the settings row and the system prompt — and a persona named two ways is
    /// the bug this exists to prevent.
    pub fn label(&self) -> &str {
        if self.label.trim().is_empty() {
            &self.name
        } else {
            self.label.trim()
        }
    }

    /// What summons it in a message: `@bebou`.
    ///
    /// Built here rather than stored, so the address and the row's own key can never
    /// disagree.
    pub fn prefix(&self) -> String {
        format!("@{}", self.name)
    }

    /// How this persona is spelled inside the line a reply signs itself with:
    /// `bebou (claude)`.
    ///
    /// Both halves are load-bearing. The NAME is what makes the mark draw this persona's
    /// own face rather than the vendor's; the BACKEND is what a reader — and
    /// `agentAuthorship` in web/src/lib/agent-message.ts — needs in order to draw the
    /// fallback mark of a persona that has no face, and it is what keeps the loop guard
    /// (`agent_policy::is_agent_answer`) able to recognise the shape without holding
    /// the list of personas that exist right now.
    ///
    /// The ADDRESS is used rather than the label: it is ASCII, one word, and identical to
    /// what the user types, so the round trip through a Teams body cannot lose it. The
    /// label is drawn from the local record, where it belongs.
    pub fn signature_name(&self) -> String {
        format!("{} ({})", self.name, self.backend.name)
    }

    /// The prompt with this persona's preprompt leading it.
    ///
    /// It leads rather than trails, and it sits OUTSIDE the context blocks
    /// ([`agent_policy::prompt_with_context`] builds those), for three reasons:
    ///
    /// - a preprompt is how to answer, and instructions before the material is the shape
    ///   every other prompt in this app takes;
    /// - it is the one place a slash command can work — a `/review` that followed a
    ///   thread transcript would be a word in the middle of a message rather than a
    ///   command, and a skill-backed persona is exactly what the user asked this feature
    ///   for;
    /// - it works identically for both CLIs. Claude Code takes an
    ///   `--append-system-prompt`, opencode has no such flag and reads the instructions at
    ///   the top of the message (`crate::agent::build_command`), so a preprompt carried
    ///   in the system prompt alone would be second-class on one of the two providers.
    ///
    /// An empty preprompt leaves the prompt untouched, so a persona that is only a face
    /// and a name costs the model nothing.
    pub fn lead(&self, prompt: &str) -> String {
        let preprompt = self.preprompt.trim();
        if preprompt.is_empty() {
            return prompt.to_string();
        }
        format!("{preprompt}\n\n{prompt}")
    }
}

/// Whether `name` is an address this module will store.
///
/// The charset is `custom_emoji::is_valid_name`'s, minus `+`, and for its reasons: the
/// name becomes part of a `@…` word that `agent_policy::address_in` has to find in a
/// sentence and that `agent_policy::ends_address` has to see END. So it holds only the
/// characters that carry a word — a `.` would make `@bebou.` ambiguous with a sentence
/// ending on an address, and a space would make the address two words.
///
/// Lowercase, because an address is matched without case and one spelling in the store
/// means one answer to "is this name taken". What the reader SEES is
/// [`Persona::label`]'s job, which is where the capitals live.
pub fn is_valid_name(name: &str) -> bool {
    let count = name.chars().count();
    if count == 0 || count > MAX_NAME_CHARS {
        return false;
    }
    let mut chars = name.chars();
    let first = chars.next().expect("non-empty");
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// Why a name cannot be used, or `Ok(())`.
///
/// A NAME COLLISION IS A REFUSAL, and it is the one rule here that is about safety rather
/// than tidiness. `@claude` is resolved before any persona ([`agent_policy::split_address`]
/// prefers the earliest address and the static table breaks a tie), so a persona allowed
/// to call itself `claude` would be a row the user can see, edit and never summon — and
/// worse, a row whose preprompt they believe is leading every `@claude` run. Refusing it
/// says so at the moment they type it.
pub fn check_name(name: &str, taken: &[String]) -> anyhow::Result<()> {
    anyhow::ensure!(
        is_valid_name(name),
        "a custom agent's name is lowercase letters, digits, - and _, up to {MAX_NAME_CHARS} \
         characters — it is what you type after the @"
    );
    if let Some(backend) = agent_policy::backend_named(name) {
        anyhow::bail!(
            "{} is the name of an AI provider, so {} already summons it — pick another name",
            backend.name,
            backend.prefix
        );
    }
    anyhow::ensure!(
        !taken.iter().any(|other| other == name),
        "you already have a custom agent called {name}"
    );
    Ok(())
}

/// The label to store for a persona, trimmed and bounded — and EMPTY when it says nothing
/// the name does not.
///
/// A label IDENTICAL to the address is stored as nothing rather than as a copy, so
/// [`Persona::label`] has one answer and a rename of the address cannot leave a stale label
/// behind it.
///
/// "Identical" is byte for byte and deliberately NOT without case: `Natacha` over `natacha`
/// is the commonest label there is, since an address must be lowercase and a name a reader
/// sees should not be. Folding the case here dropped exactly the labels the field exists
/// for.
pub fn normalize_label(label: &str, name: &str) -> String {
    let label = label.trim();
    if label.is_empty() || label == name {
        return String::new();
    }
    label.chars().take(MAX_LABEL_CHARS).collect()
}

/// The preprompt to store: trimmed, and bounded at [`MAX_PREPROMPT_CHARS`].
///
/// Bounded here rather than refused, because a preprompt is prose the user pasted and a
/// refusal would cost them the whole edit; the cap is well past any real instruction.
pub fn normalize_preprompt(preprompt: &str) -> String {
    preprompt.trim().chars().take(MAX_PREPROMPT_CHARS).collect()
}

/// What a picture really is, or the sentence to refuse it with — the type sniffed from the
/// BYTES and the shape read out of them.
///
/// Never the type a client declared: the caps in this module are a store invariant, and
/// the same reasoning `custom_emoji::measure_art` is written under applies here. There is
/// no dimension cap, deliberately — a face is drawn inside a fixed box by CSS, and the
/// weight is what costs this machine anything.
pub fn measure_avatar(bytes: &[u8]) -> anyhow::Result<Avatar> {
    let content_type = crate::sender_icon::image_kind(bytes)
        .filter(|kind| AVATAR_TYPES.contains(kind))
        .ok_or_else(|| {
            anyhow::anyhow!("a custom agent's picture must be a PNG, JPEG, GIF or WebP image")
        })?;
    anyhow::ensure!(
        bytes.len() <= MAX_AVATAR_BYTES,
        "that picture is too large ({} KB, max {} KB)",
        bytes.len() / 1024,
        MAX_AVATAR_BYTES / 1024
    );
    let (width, height) = crate::sender_icon::image_dimensions(bytes).unwrap_or((0, 0));
    Ok(Avatar { content_type: content_type.to_string(), width, height })
}

/// The model to store for a persona, or `None` to inherit the provider's.
///
/// Re-checked against [`agent_policy::is_valid_model`] rather than trusted, because this
/// value ends up as one argument on a command line — the rule that module states, applied
/// at the second of the two doors a model can come through.
pub fn normalize_model(model: Option<&str>) -> Option<String> {
    model
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .filter(|model| agent_policy::is_valid_model(model))
        .map(str::to_string)
}

/// The persona in `personas` that `name` addresses, without case.
pub fn named<'a>(personas: &'a [Persona], name: &str) -> Option<&'a Persona> {
    personas.iter().find(|persona| persona.name.eq_ignore_ascii_case(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn persona(name: &str, backend: &str) -> Persona {
        Persona {
            name: name.to_string(),
            label: String::new(),
            backend: agent_policy::backend_named(backend).expect("a backend"),
            model: None,
            preprompt: String::new(),
            avatar: None,
            added_ms: 0,
            updated_ms: 0,
        }
    }

    #[test]
    fn a_name_is_one_lowercase_word() {
        for good in ["bebou", "natacha", "review-bot", "r2_d2", "b"] {
            assert!(is_valid_name(good), "{good}");
        }
        // Each of these would break the address rules `agent_policy` reads a `@…` with:
        // a capital is another spelling of one name, a space is two words, and a `.`
        // collides with a sentence ending on an address.
        for bad in ["", "Bebou", "review bot", "bebou.", "bebou!", "@bebou", "-bebou", "é"] {
            assert!(!is_valid_name(bad), "{bad}");
        }
        assert!(!is_valid_name(&"a".repeat(MAX_NAME_CHARS + 1)));
        assert!(is_valid_name(&"a".repeat(MAX_NAME_CHARS)));
    }

    /// The rule that keeps a persona from shadowing a provider: `@claude` is a provider's
    /// address, so a persona of that name could never be summoned and its preprompt would
    /// silently lead nothing.
    #[test]
    fn a_persona_may_not_take_a_providers_name() {
        for reserved in ["claude", "opencode"] {
            let error = check_name(reserved, &[]).expect_err("refused");
            assert!(
                error.to_string().contains(reserved),
                "the refusal names the provider: {error}"
            );
        }
        assert!(check_name("bebou", &[]).is_ok());
    }

    #[test]
    fn a_name_already_taken_is_refused() {
        let taken = vec!["bebou".to_string()];
        assert!(check_name("bebou", &taken).is_err());
        assert!(check_name("natacha", &taken).is_ok());
    }

    #[test]
    fn the_label_is_the_name_until_one_is_given() {
        let mut p = persona("natacha", "claude");
        assert_eq!(p.label(), "natacha");
        p.label = "Natacha".into();
        assert_eq!(p.label(), "Natacha");
        // A label that only restates the address is stored as nothing, so there is one
        // answer to "what is this called".
        assert_eq!(normalize_label("natacha", "natacha"), "");
        assert_eq!(normalize_label("  Natacha  ", "natacha"), "Natacha");
        assert_eq!(normalize_label("", "natacha"), "");
    }

    #[test]
    fn the_prefix_and_the_signature_are_built_from_the_row() {
        let p = persona("bebou", "claude");
        assert_eq!(p.prefix(), "@bebou");
        // The signature carries both halves: the name draws the face, the backend draws
        // the fallback mark and is what the loop guard recognises.
        assert_eq!(p.signature_name(), "bebou (claude)");
        assert_eq!(persona("bebou", "opencode").signature_name(), "bebou (opencode)");
    }

    /// The preprompt LEADS, so a slash command is still the first thing the CLI reads.
    #[test]
    fn the_preprompt_leads_the_prompt_and_an_empty_one_changes_nothing() {
        let mut p = persona("bebou", "claude");
        assert_eq!(p.lead("which port?"), "which port?");
        p.preprompt = "/bebou".into();
        assert_eq!(p.lead("which port?"), "/bebou\n\nwhich port?");
        p.preprompt = "   ".into();
        assert_eq!(p.lead("which port?"), "which port?");
    }

    #[test]
    fn a_preprompt_is_bounded_rather_than_refused() {
        let long = "x".repeat(MAX_PREPROMPT_CHARS + 100);
        assert_eq!(normalize_preprompt(&long).chars().count(), MAX_PREPROMPT_CHARS);
        assert_eq!(normalize_preprompt("  be nice  "), "be nice");
    }

    /// A model reaches a command line, so the shape is re-checked here as well as at the
    /// RPC — the discipline `agent::model_of` already follows.
    #[test]
    fn a_model_that_could_pass_for_a_flag_is_dropped() {
        assert_eq!(normalize_model(Some("opus")), Some("opus".to_string()));
        assert_eq!(normalize_model(Some("  opus  ")), Some("opus".to_string()));
        assert_eq!(normalize_model(Some("--dangerously-skip-permissions")), None);
        assert_eq!(normalize_model(Some("")), None);
        assert_eq!(normalize_model(None), None);
    }

    #[test]
    fn a_picture_is_measured_from_its_bytes_and_never_from_a_claim() {
        let png = [
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, b'I', b'H', b'D', b'R',
            0, 0, 0, 8, 0, 0, 0, 4,
        ];
        let measured = measure_avatar(&png).expect("a png");
        assert_eq!(measured.content_type, "image/png");
        assert_eq!((measured.width, measured.height), (8, 4));
        // Not a raster image at all, and an SVG in particular: a document is refused
        // whatever a client called it.
        assert!(measure_avatar(b"<svg xmlns='http://www.w3.org/2000/svg'/>").is_err());
        assert!(measure_avatar(&[]).is_err());
    }

    #[test]
    fn a_picture_over_the_cap_is_refused_by_weight() {
        let mut huge = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        huge.resize(MAX_AVATAR_BYTES + 1, 0);
        let error = measure_avatar(&huge).expect_err("refused");
        assert!(error.to_string().contains("too large"), "{error}");
    }

    #[test]
    fn a_persona_is_found_by_name_without_case() {
        let personas = vec![persona("bebou", "claude"), persona("natacha", "opencode")];
        assert_eq!(named(&personas, "BEBOU").map(|p| p.name.as_str()), Some("bebou"));
        assert_eq!(named(&personas, "nobody"), None);
    }
}
