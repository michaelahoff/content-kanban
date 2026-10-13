// Claude's native PDF route is always on. Recorded checks (npm run
// test:claude-pdf) supply each model's documented page limit, which previews
// show as a warning; Claude itself decides what it accepts.
import recorded from './claude-pdf-evidence.json' with { type: 'json' };

export const claudePdfEvidence = recorded;
// The page limit for models without a recorded check.
const defaultPages = 100;

// Whether two recorded checks cover the same setup, for npm run test:claude-pdf.
// setup: { harness, model, account: { apiProvider, subscriptionType }, retainedDataProtection }
export const sameSetup = (a, b) => a.harness === b.harness && a.model === b.model && a.retainedDataProtection === b.retainedDataProtection
  && a.account?.apiProvider === b.account?.apiProvider && a.account?.subscriptionType === b.account?.subscriptionType;
export function claudePdfRoute(model, evidence = claudePdfEvidence) {
  return { available: true, pages: evidence.find((entry) => entry.model === model)?.pages ?? defaultPages };
}
