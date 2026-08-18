// Bundles the shared skills into ./skills at a pinned ref.
//
// The planning-workflow and tdd skills are authored in the separate
// `felixnorden/skills` repository. We shallow-clone that repo at a pinned
// tag and copy just the two skill directories this package ships. `prepare`
// runs this on `bun install` (development) and `prepack` runs it before
// `bun pm pack` (bundle time), so ./skills is always present when tests or
// packaging need it and never has to be committed.
import { $ } from "bun";

const SKILLS_REPO = "https://github.com/felixnorden/skills";
const PINNED_REF = "v0.1.0";
const SKILL_NAMES = ["planning-workflow", "tdd"] as const;
const TMP_DIR = "/tmp/qrspi-skills";

await $`rm -rf ${TMP_DIR} ./skills`.quiet();
await $`git clone --depth 1 --branch ${PINNED_REF} ${SKILLS_REPO} ${TMP_DIR}`.quiet();
await $`mkdir -p ./skills`;
for (const name of SKILL_NAMES) {
  await $`cp -R ${TMP_DIR}/skills/${name} ./skills/`.quiet();
}
// planning-workflow ships a nested empty `skills/` directory; drop it from the bundle.
await $`rm -rf ./skills/planning-workflow/skills`.quiet();
await $`rm -rf ${TMP_DIR}`.quiet();

console.log(`Fetched skills ${SKILL_NAMES.join(", ")} from ${SKILLS_REPO} @ ${PINNED_REF}`);
