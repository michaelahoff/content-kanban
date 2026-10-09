// Claude's native PDF route is enabled only by recorded evidence: a live check
// (npm run test:claude-pdf) in which the installed Claude Code, with tools
// disabled, delivered a PDF document block that the model then read on a
// subscribed account. A record covers its exact harness version, resolved
// model, account kind and retained-data protection state, nothing wider.
import recorded from './claude-pdf-evidence.json' with { type: 'json' };

export const claudePdfEvidence = recorded;
const describe = ({ harness, model, account }) => `Claude Code ${harness ?? '(unknown version)'} with ${model ?? 'this model'} on ${account?.subscriptionType ? `a ${account.subscriptionType} account` : 'this account'}`;

// setup: { harness, model, account: { apiProvider, subscriptionType }, retainedDataProtection }
export function claudePdfRoute(setup, evidence = claudePdfEvidence) {
  const record = evidence.find((entry) => entry.harness === setup.harness && entry.model === setup.model
    && entry.account.apiProvider === setup.account?.apiProvider && entry.account.subscriptionType === setup.account?.subscriptionType
    && entry.retainedDataProtection === setup.retainedDataProtection);
  if (record) return { available: true, pages: record.pages, checked: record.checked };
  if (setup.retainedDataProtection) return { available: false, reason: 'Claude has no configuration proven inside retained-data protection, so no PDF check can pass with protection on.' };
  return { available: false, reason: `No passing PDF check is recorded for ${describe(setup)}.` };
}
