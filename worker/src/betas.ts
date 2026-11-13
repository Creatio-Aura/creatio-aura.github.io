// The apps with a beta, by the name the sign-up forms and the service use for each.

export interface Beta {
  /** Its name, as the emails and pages say it. */
  name: string;
  /** Where it can be played or used, as the form offers them. */
  platforms: string[];
  /** Exactly what people agree to by ticking the box; kept with each sign-up. */
  consent: string;
  /** Whether the Beta Tester Terms (/beta/terms/, written for Ignis Aura) cover it. */
  terms: boolean;
  /** Guides on the website, linked from the "You're in" email (Andrew, 2026-11-09). Add one when it exists. */
  guides?: { label: string; url: string; about: string }[];
  /**
   * Android testers let themselves in on Google Play (Andrew, 2026-11-12): join the closed test's Google Group, then
   * opt in. Without it, Andrew adds each tester's Google account to the test by hand. Set it only once Google has
   * approved the closed test, so its opt-in link works.
   */
  playGroup?: { join: string; optIn: string };
}

export const BETAS: Record<string, Beta> = {
  ignis: {
    name: "Ignis Aura",
    platforms: ["iPhone", "Android", "Web"],
    // The terms' date says which version they agreed to.
    consent:
      "Email me about the Ignis Aura beta. I agree to the Beta Tester Terms (22 October 2026) and I've read the privacy policy.",
    terms: true,
    // On since 2026-11-13: Google published the closed test.
    playGroup: { join: "https://groups.google.com/g/ignis-aura-testers", optIn: "https://play.google.com/apps/testing/com.creatioaura.ignisaura" },
  },
  effugium: {
    name: "Effugium Aura",
    platforms: ["iPhone", "Android"],
    consent: "Email me about the Effugium Aura beta. I've read the privacy policy.",
    terms: false,
    guides: [
      { label: "Tester guide", url: "https://creatio-aura.com/effugium/testers/", about: "What to try first, and how to send us feedback." },
      { label: "User guide", url: "https://creatio-aura.com/effugium/guide/", about: "Every feature, explained." },
    ],
    // On since 2026-11-13: Google published the closed test (2026-11-12, 12:50 MST).
    playGroup: { join: "https://groups.google.com/g/effugium-aura-testers", optIn: "https://play.google.com/apps/testing/com.creatioaura.effugiumaura" },
  },
};

/** The beta a form names, or null for one there isn't. Forms from before there were two name none: Ignis Aura's. */
export function betaOf(project: unknown): string | null {
  if (project === undefined) return "ignis";
  return typeof project === "string" && Object.hasOwn(BETAS, project) ? project : null;
}
