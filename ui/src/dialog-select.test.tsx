// Unit (no backend): the DialogSelect behaves like opencode's — it fuzzy-filters,
// arrow-key navigation moves the selection (with wrap-around), the current value
// is marked with a ●, Enter selects the highlighted option, and Escape closes.

import { testRender } from "@opentui/solid";
import { DialogSelect } from "./dialog-select";

type Fruit = { title: string; value: string };
const OPTIONS: Fruit[] = [
  { title: "Apple", value: "apple" },
  { title: "Banana", value: "banana" },
  { title: "Cherry", value: "cherry" },
  { title: "Orange", value: "orange" },
];

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const settle = async (r: () => Promise<void>) => {
  await r();
  await new Promise((x) => setTimeout(x, 60));
  await r();
};

let ok = true;
const check = (cond: boolean, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) ok = false;
};

// --- scenario A: browse view, current marker, ↓ + Enter selects 2nd ----------
{
  let picked: string | undefined;
  const { renderOnce, captureCharFrame, mockInput, resize } = await testRender(
    () => (
      <DialogSelect
        title="Pick a fruit"
        current="cherry"
        options={OPTIONS}
        onSelect={(o) => (picked = o.value)}
        onClose={() => {}}
      />
    ),
    { width: 80, height: 24 },
  );
  resize(80, 24);
  await settle(renderOnce);

  const frame = strip(captureCharFrame());
  check(frame.includes("Pick a fruit"), "renders the title");
  check(
    ["Apple", "Banana", "Cherry", "Orange"].every((t) => frame.includes(t)),
    "browse view lists every option",
  );
  check(frame.includes("●"), "current value is marked with ●");

  mockInput.pressArrow("down");
  await settle(renderOnce);
  mockInput.pressEnter();
  await settle(renderOnce);
  check(picked === "banana", "↓ then Enter selects the second option");
}

// --- scenario B: ↑ from the top wraps to the last option ---------------------
{
  let picked: string | undefined;
  const { renderOnce, mockInput, resize } = await testRender(
    () => (
      <DialogSelect title="Pick a fruit" options={OPTIONS} onSelect={(o) => (picked = o.value)} onClose={() => {}} />
    ),
    { width: 80, height: 24 },
  );
  resize(80, 24);
  await settle(renderOnce);

  mockInput.pressArrow("up"); // wrap from index 0 to the last item
  await settle(renderOnce);
  mockInput.pressEnter();
  await settle(renderOnce);
  check(picked === "orange", "↑ from the top wraps to the last option");
}

// --- scenario C: fuzzy narrowing, Enter selects match, Escape closes ---------
{
  let picked: string | undefined;
  let closed = false;
  const { renderOnce, captureCharFrame, mockInput, resize } = await testRender(
    () => (
      <DialogSelect
        title="Pick a fruit"
        options={OPTIONS}
        onSelect={(o) => (picked = o.value)}
        onClose={() => (closed = true)}
      />
    ),
    { width: 80, height: 24 },
  );
  resize(80, 24);
  await settle(renderOnce);

  await mockInput.typeText("ban");
  await settle(renderOnce);
  const frame = strip(captureCharFrame());
  check(frame.includes("Banana"), "fuzzy query keeps the match");
  check(!frame.includes("Apple") && !frame.includes("Orange"), "fuzzy query drops non-matches");

  mockInput.pressEnter();
  await settle(renderOnce);
  check(picked === "banana", "Enter selects the fuzzy match");

  mockInput.pressEscape();
  await settle(renderOnce);
  check(closed, "Escape closes the dialog");
}

process.exit(ok ? 0 : 1);
