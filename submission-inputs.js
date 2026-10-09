import { maxImageBytes } from './image-files.js';
import { fileFormats } from './public/library-format.js';

// How a submission's inputs reach each native target, and the request limits
// Frameboard knows. Pure: callers resolve and verify bytes first. Anything a
// target cannot take is a problem that stops the whole submission; nothing is
// dropped, truncated, converted or rerouted to make it fit.
const MiB = 1024 * 1024;
export const rasterFormats = ['png', 'jpg', 'gif', 'webp'];
export const limits = {
  // Frameboard's reference limit for every native image route.
  imageBytes: maxImageBytes,
  // Claude's documented per-image, per-request image and request size limits.
  // Images travel base64 encoded, a third larger than their bytes.
  claudeImageBytes: 5 * MiB, claudeImages: 100, claudeRequestBytes: 32 * MiB,
  // No current Codex or Claude model accepts more than a million tokens, and
  // no tokenizer averages more than eight bytes per token: above this the
  // request is known not to fit. Frameboard cannot read the chosen model's
  // context window, so above a typical estimate (four bytes per token) of the
  // smallest windows in use it warns and lets the native attempt decide.
  certainTextBytes: 8 * 1000000, warnTextBytes: 4 * 128000,
};
const megabytes = (bytes) => `${Math.round(bytes / MiB)} MB`;

// Routes with no evidence for the installed harnesses stay unavailable.
const claudeFileReason = (item) => ({
  PDF: `Claude PDF delivery is not enabled in Frameboard, and Claude chats have no file tools, so ${item.label} cannot be delivered. Remove it, or send it to Codex.`,
  audio: `Claude card chats take no audio input and have no file tools, so ${item.label} cannot be delivered. Remove it, supply a transcript, or send it to Codex.`,
  video: `Claude card chats take no video input and have no file tools, so ${item.label} cannot be delivered. Remove it, supply stills or a transcript, or send it to Codex.`,
  'audio or video': `Claude card chats take no audio or video input and have no file tools, so ${item.label} cannot be delivered. Remove it, supply a transcript, or send it to Codex.`,
})[fileFormats[item.format]?.media] ?? `Claude chats have no file tools, so ${item.label} cannot be delivered. Remove it, or send it to Codex.`;
// Codex reads a workspace copy only with its shell tool, which the effective
// configuration can turn off. A discovery that does not say leaves it on.
export const hasShellTool = (discovery) => discovery?.tools?.shell !== false;
export const noShellTool = 'This Codex setup has its shell tool turned off (features.shell_tool), so it has no tool to read workspace copies. Turn the shell tool on';

// items: [{ key, label, kind: 'text' | 'image' | 'file', format?, size }] in
// delivery order. textBytes counts the prompt and card text sent with them.
// A model that reports its input modalities is held to them; otherwise the
// provider decides. shellTool is false when the Codex setup cannot read a
// workspace copy.
export function planInputs(provider, items, { textBytes, model = null, shellTool = true }) {
  const claude = provider === 'claude';
  const problems = []; const warnings = [];
  const refuse = (item, reason, phase = 'limit') => problems.push({ key: item?.key ?? null, label: item?.label ?? 'This request', phase, reason });
  const inputs = items.map((item) => {
    if (item.kind === 'text') return { ...item, method: 'text' };
    if (item.kind === 'image') {
      if (Array.isArray(model?.inputModalities) && !model.inputModalities.includes('image')) refuse(item, `The model ${model.id} accepts text only, so ${item.label} cannot be sent. Choose a model that accepts images, or remove it.`, 'capability');
      else if (claude && !rasterFormats.includes(item.format)) refuse(item, `Claude accepts PNG, JPEG, GIF and WebP images. Remove ${item.label} or convert it first.`, 'capability');
      else if (item.size > limits.imageBytes) refuse(item, `${item.label} is larger than ${megabytes(limits.imageBytes)}, the image limit.`);
      else if (claude && item.size > limits.claudeImageBytes) refuse(item, `${item.label} is larger than ${megabytes(limits.claudeImageBytes)}, Claude's image limit.`);
      return { ...item, method: 'image' };
    }
    if (claude && item.format === 'text') refuse(item, `${item.label} is too much text to send inline, and Claude chats have no file tools to read it. Remove it, or send it to Codex.`);
    else if (claude) refuse(item, claudeFileReason(item), 'capability');
    else if (!shellTool) refuse(item, `${noShellTool}, or remove ${item.label}.`, 'capability');
    return { ...item, method: 'copy' };
  });
  const images = inputs.filter((input) => input.method === 'image').length;
  if (claude && images > limits.claudeImages) refuse(null, `Claude accepts up to ${limits.claudeImages} images in one request; this one has ${images}. Remove some references.`);
  const text = textBytes + inputs.filter((input) => input.method === 'text').reduce((sum, input) => sum + input.size, 0);
  const encoded = text + inputs.filter((input) => input.method === 'image').reduce((sum, input) => sum + Math.ceil(input.size / 3) * 4, 0);
  if (claude && encoded > limits.claudeRequestBytes) refuse(null, `This request is about ${megabytes(encoded)} once images are encoded, more than Claude's ${megabytes(limits.claudeRequestBytes)} request limit. Remove some references.`);
  if (text > limits.certainTextBytes) refuse(null, `This request has ${megabytes(text)} of text, more than any model accepts. Remove some Library text.`);
  else if (text > limits.warnTextBytes) warnings.push(`This request has about ${Math.ceil(text / 4).toLocaleString('en-US')} tokens of text, which may exceed the model's context. Frameboard cannot check this model's limit, so the provider decides.`);
  return { inputs, problems, warnings };
}
