import { updateTokensList } from './domManager.js';

export async function loadSavedTokens() {
    try {
        const result = await window.electronAPI.getTokens();
        if (!result.success) {
            console.error('Failed to load tokens:', result.error);
            return;
        }

        const tokenManagement = document.getElementById('tokenManagement');
        if (!result.tokens.length) {
            tokenManagement.innerHTML = '<p class="text-muted">No saved tokens</p>';
            return;
        }

        updateTokensList(result.tokens, {
            useToken: (token) => {
                document.getElementById('tokenInput').value = token;
                document.getElementById('connectBtn').click();
            },
            deleteToken: async (name) => {
                const result = await window.electronAPI.deleteToken(name);
                if (result.success) {
                    loadSavedTokens();
                }
            }
        });
    } catch (error) {
        console.error('Failed to load tokens:', error);
    }
}

export async function saveToken(token, status) {
    if (!token) {
        status.textContent = 'Please enter a token';
        status.className = 'error';
        return;
    }

    try {
        const result = await window.electronAPI.saveToken('Main Account', token);
        if (result.success) {
            status.textContent = 'Token saved (single account mode)';
            status.className = 'success';
            await loadSavedTokens();
        } else {
            status.textContent = result.error;
            status.className = 'error';
        }
    } catch (error) {
        status.textContent = 'Failed to save token';
        status.className = 'error';
    }
}
