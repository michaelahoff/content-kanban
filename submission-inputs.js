// How a submission's inputs reach each native target, and the request limits
// Frameboard knows. Pure: callers resolve and verify bytes first. Anything a
// target cannot take is a problem that stops the whole submission; nothing is
// dropped, truncated, converted or rerouted to make it fit.
const MiB = 1024 * 1024;
export const rasterFormats = ['png', 'jpg', 'gif', 'webp'];
export const limits = {
  // Frameboard's reference limit for every native image route.
  imageBytes: 20 * MiB,
  // Claude's documented per-image and per-request image limits.
  claudeImageBytes: 5 * MiB, claudeImages: 100,
  // No current Codex or Claude model accepts more than a million tokens, and
  // no tokenizer averages more than eight bytes per token: above this the
  // request is known not to fit. Frameboard cannot read the chosen model's
  // context window, so above a typical estimate (four bytes per token) of the
  // smallest windows in use it warns and lets the native attempt decide.
  certainTextBytes: 8 * 1000000, warnTextBytes: 4 * 128000,
};
const megabytes = (bytes) => `${Math.round(bytes / MiB)} MB`;

// items: [{ key, label, kind: 'text' | 'image' | 'file', format?, size }] in
// delivery order. textBytes counts the prompt and card text sent with them.
export function planInputs(provider, items, { textBytes }) {
  const claude = provider === 'claude';
  const problems = []; const warnings = [];
  const refuse = (item, reason, phase = 'limit') => problems.push({ key: item?.key ?? null, label: item?.label ?? 'This request', phase, reason });
  const inputs = items.map((item) => {
    if (item.kind === 'text') return { ...item, method: 'text' };
    if (item.kind === 'image') {
      if (claude && !rasterFormats.includes(item.format)) refuse(item, `Claude accepts PNG, JPEG, GIF and WebP images. Remove ${item.label} or convert it first.`, 'capability');
      else if (item.size > limits.imageBytes) refuse(item, `${item.label} is larger than ${megabytes(limits.imageBytes)}, the image limit.`);
      else if (claude && item.size > limits.claudeImageBytes) refuse(item, `${item.label} is larger than ${megabytes(limits.claudeImageBytes)}, Claude's image limit.`);
      return { ...item, method: 'image' };
    }
    if (claude) refuse(item, `Claude chats have no file tools, so ${item.label} cannot be delivered. Remove it, or send it to Codex.`, 'capability');
    return { ...item, method: 'copy' };
  });
  const images = inputs.filter((input) => input.method === 'image').length;
  if (claude && images > limits.claudeImages) refuse(null, `Claude accepts up to ${limits.claudeImages} images in one request; this one has ${images}. Remove some references.`);
  const text = textBytes + inputs.filter((input) => input.method === 'text').reduce((sum, input) => sum + input.size, 0);
  if (text > limits.certainTextBytes) refuse(null, `This request has ${megabytes(text)} of text, more than any model accepts. Remove some Library text.`);
  else if (text > limits.warnTextBytes) warnings.push(`This request has about ${Math.ceil(text / 4).toLocaleString('en-US')} tokens of text, which may exceed the model's context. Frameboard cannot check this model's limit, so the provider decides.`);
  return { inputs, problems, warnings };
}
