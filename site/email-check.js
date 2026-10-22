// Is this email address right? Used by the sign-up form (as a friendly check, with a "did you
// mean…?") and by the sign-up service (which turns bad ones away), so both judge alike.
//
//   emailProblem("kodi@gmail.con") → { error: "email-typo", suggestion: "kodi@gmail.com" }
//   emailProblem("kodi")           → { error: "bad-email" }
//   emailProblem("kodi@gmail.com") → null

// One @, a name before it, and a domain after: labels of letters, digits and dashes, ending in
// a top-level domain of two or more letters.
const SHAPE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;

// Endings that are slips of the finger, never real top-level domains.
const ENDINGS = {
  con: "com", cmo: "com", ocm: "com", comm: "com", coom: "com", comn: "com", cpm: "com",
  vom: "com", xom: "com", cim: "com", cok: "com", clm: "com",
  nte: "net", nett: "net", ogr: "org", orgg: "org", rog: "org", eud: "edu",
};

// Misspellings of the email services people use most.
const DOMAINS = {
  "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gamil.com": "gmail.com",
  "gmal.com": "gmail.com", "gnail.com": "gmail.com", "gmaill.com": "gmail.com",
  "gmail.co": "gmail.com", "gmail.cm": "gmail.com", "gmail.om": "gmail.com",
  "hotmial.com": "hotmail.com", "hotmal.com": "hotmail.com", "hotmai.com": "hotmail.com",
  "hotmail.co": "hotmail.com", "yaho.com": "yahoo.com", "yahooo.com": "yahoo.com",
  "yahoo.co": "yahoo.com", "iclod.com": "icloud.com", "icoud.com": "icloud.com",
  "icloud.co": "icloud.com", "outlok.com": "outlook.com", "outllok.com": "outlook.com",
  "outlook.co": "outlook.com", "aol.co": "aol.com",
};

/** What's wrong with an email address, and the likely right one when it's a typo; or null. */
export function emailProblem(email) {
  const address = String(email ?? "").trim();
  if (address.length > 254 || !SHAPE.test(address)) return { error: "bad-email" };
  const at = address.lastIndexOf("@");
  const name = address.slice(0, at);
  const domain = address.slice(at + 1).toLowerCase();
  const ending = domain.slice(domain.lastIndexOf(".") + 1);
  let fixed = DOMAINS[domain];
  if (!fixed && ENDINGS[ending]) fixed = `${domain.slice(0, -ending.length)}${ENDINGS[ending]}`;
  if (fixed && DOMAINS[fixed]) fixed = DOMAINS[fixed];
  return fixed ? { error: "email-typo", suggestion: `${name}@${fixed}` } : null;
}

// For the sign-up form's own script.
globalThis.IgnisEmail = { emailProblem };
