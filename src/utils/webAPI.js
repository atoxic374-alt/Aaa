async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`/api${path}`, opts);
  return res.json();
}

window.electronAPI = {
  minimize: () => {},
  maximize: () => {},
  close:    () => {},

  getTokens:   ()            => api('GET',    '/tokens'),
  saveToken:   (name, token) => api('POST',   '/tokens', { name, token }),
  deleteToken: (name)        => api('DELETE', `/tokens/${encodeURIComponent(name)}`),

  checkUpdates:   ()    => api('GET', '/updates'),
  downloadUpdate: (url) => { window.open(url, '_blank'); },
  openExternal:   (url) => { window.open(url, '_blank'); },

  connectDiscord: (token)    => api('POST',   '/discord/connect', { token }),

  getFriends:    ()         => api('GET',    '/discord/friends'),
  deleteFriend:  (id)       => api('DELETE', `/discord/friends/${id}`),

  getServers:    ()         => api('GET',    '/discord/servers'),
  leaveServer:   (id)       => api('POST',   `/discord/servers/${id}/leave`),
  muteServer:    (id)       => api('POST',   `/discord/servers/${id}/mute`),
  unmuteServer:  (id)       => api('POST',   `/discord/servers/${id}/unmute`),
  readAll:       ()         => api('POST',   '/discord/servers/readall'),

  getServerChannels: (id)              => api('GET', `/discord/servers/${id}/channels`),
  getServerMembers:  (id, channelId)   => api('GET', `/discord/servers/${id}/members${channelId && channelId !== 'all' ? `?channel=${channelId}` : '?channel=all'}`),

  getDMs:          ()                       => api('GET',    '/discord/dms'),
  getDMMessages:   (id, before)             => api('GET',    `/discord/dms/${id}/messages${before ? `?before=${before}` : ''}`),
  deleteDMMessage: (channelId, messageId)   => api('DELETE', `/discord/dms/${channelId}/messages/${messageId}`),
  closeDM:         (id)                     => api('POST',   `/discord/dms/${id}/close`),
  sendDM:          (userId, message)        => api('POST',   '/discord/dms/send', { userId, message }),

  getGroups:          ()                      => api('GET',    '/discord/groups'),
  leaveGroup:         (id)                    => api('POST',   `/discord/groups/${id}/leave`),
  getGroupMessages:   (id, before)            => api('GET',    `/discord/groups/${id}/messages${before ? `?before=${before}` : ''}`),
  deleteGroupMessage: (channelId, messageId)  => api('DELETE', `/discord/groups/${channelId}/messages/${messageId}`),

  // TrueStudio (Bot-Studio) Endpoints
  tsState:               () => api('GET', '/ts/state'),
  tsSaveAccount:         (email, password, totpSecret) => api('POST', '/ts/accounts', { email, password, totpSecret }),
  tsDeleteAccount:       (email) => api('DELETE', `/ts/accounts/${encodeURIComponent(email)}`),
  tsTestAccount:         (email) => api('POST', '/ts/test-account', { email }),
  tsLibrary:             (email) => api('GET', `/ts/library?email=${encodeURIComponent(email)}`),
  tsResetBot:            (email, appId) => api('POST', '/ts/reset-bot', { email, appId }),
  tsStart:               (email, rules, count, prefix, waitMinutes) => api('POST', '/ts/start', { email, rules, count, prefix, waitMinutes }),
  tsStop:                () => api('POST', '/ts/stop'),
  tsResolveCaptcha:      (id, token) => api('POST', '/ts/captcha-resolve', { id, token }),
  tsCancelCaptcha:       (id) => api('POST', '/ts/captcha-cancel', { id }),
  tsCaptchaSettings:     () => api('GET', '/ts/captcha-settings'),
  tsSaveCaptchaSettings: (settings) => api('POST', '/ts/captcha-settings', { settings }),
  tsExportUrl:           (format) => `/api/ts/export?format=${format}`,
};
