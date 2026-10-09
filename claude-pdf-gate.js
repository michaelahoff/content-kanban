// Claude's native PDF route is enabled only by recorded evidence: a live check
// (npm run test:claude-pdf) in which the installed Claude Code, with tools
// disabled, delivered a PDF document block that the model then read on a
// subscribed account. A record covers its exact harness version, resolved
// model, account kind and retained-data protection state, nothing wider.
import recorded from './claude-pdf-evidence.json' with { type: 'json' };

export const claudePdfEvidence = recorded;
const describe = ({ harness, model, account }) => `Claude Code ${harness ?? '(unknown version)'} with ${model ?? 'this model'} on ${account?.subscriptionType ? `a ${account.subscriptionType} account` : 'this account'}`;

// setup: { harness, model, account: { apiProvider, subscriptionType }, retainedDataProtection }
export const sameSetup = (a, b) => a.harness === b.harness && a.model === b.model && a.retainedDataProtection === b.retainedDataProtection
  && a.account?.apiProvider === b.account?.apiProvider && a.account?.subscriptionType === b.account?.subscriptionType;
export function claudePdfRoute(setup, evidence = claudePdfEvidence) {
  const record = evidence.find((entry) => sameSetup(entry, setup));
  if (record) return { available: true, pages: record.pages, checked: record.checked };
  if (setup.retainedDataProtection) return { available: false, reason: 'Claude has no configuration proven inside retained-data protection, so no PDF check can pass with protection on.' };
  return { available: false, reason: `No passing PDF check is recorded for ${describe(setup)}.` };
}
