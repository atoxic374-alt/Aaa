import { showNotification } from './ui.js';

export const copyToClipboard = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    showNotification('Copied to clipboard!', 'success');
  } catch (error) {
    console.error('Failed to copy:', error);
    showNotification('Copy failed', 'error');
  }
};
