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
}

export const BETAS: Record<string, Beta> = {
  ignis: {
    name: "Ignis Aura",
    platforms: ["iPhone", "Android", "Web"],
    // The terms' date says which version they agreed to.
    consent:
      "Email me about the Ignis Aura beta. I agree to the Beta Tester Terms (22 October 2026) and I've read the privacy policy.",
    terms: true,
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
  },
};

/** The beta a form names, or null for one there isn't. Forms from before there were two name none: Ignis Aura's. */
export function betaOf(project: unknown): string | null {
  if (project === undefined) return "ignis";
  return typeof project === "string" && Object.hasOwn(BETAS, project) ? project : null;
}
