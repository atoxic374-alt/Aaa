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
  openExternal: (url) => { window.open(url, '_blank'); },

  /* ── Tokens ─────────────────────────────────────────────── */
  getTokens:   ()            => api('GET',    '/tokens'),
  saveToken:   (name, token) => api('POST',   '/tokens', { name, token }),
  deleteToken: (name)        => api('DELETE', `/tokens/${encodeURIComponent(name)}`),

  /* ── Updates ────────────────────────────────────────────── */
  checkUpdates:   ()    => api('GET', '/updates'),
  downloadUpdate: (url) => { window.open(url, '_blank'); },

  /* ── Discord connection ─────────────────────────────────── */
  connectDiscord: (token) => api('POST', '/discord/connect', { token }),

  /* ── Friends ─────────────────────────────────────────────── */
  getFriends:   ()   => api('GET',    '/discord/friends'),
  deleteFriend: (id) => api('DELETE', `/discord/friends/${id}`),

  /* ── Servers ─────────────────────────────────────────────── */
  getServers:   () => api('GET', '/discord/servers'),
  leaveServer:  (id) => api('POST', `/discord/servers/${id}/leave`),
  muteServer:   (id) => api('POST', `/discord/servers/${id}/mute`),
  unmuteServer: (id) => api('POST', `/discord/servers/${id}/unmute`),
  readAll:      ()   => api('POST', '/discord/servers/readall'),

  getServerChannels: (id)            => api('GET', `/discord/servers/${id}/channels`),
  getServerMembers:  (id, channelId) => api('GET', `/discord/servers/${id}/members${channelId && channelId !== 'all' ? `?channel=${channelId}` : '?channel=all'}`),

  /* ── DMs ─────────────────────────────────────────────────── */
  getDMs:          () => api('GET', '/discord/dms'),
  getDMMessages:   (id, before) => api('GET', `/discord/dms/${id}/messages${before ? `?before=${before}` : ''}`),
  deleteDMMessage: (channelId, messageId) => api('DELETE', `/discord/dms/${channelId}/messages/${messageId}`),
  closeDM:         (id) => api('POST', `/discord/dms/${id}/close`),
  sendDM:          (userId, message) => api('POST', '/discord/dms/send', { userId, message }),

  /* ── Groups ──────────────────────────────────────────────── */
  getGroups:          () => api('GET', '/discord/groups'),
  leaveGroup:         (id) => api('POST', `/discord/groups/${id}/leave`),
  getGroupMessages:   (id, before) => api('GET', `/discord/groups/${id}/messages${before ? `?before=${before}` : ''}`),
  deleteGroupMessage: (channelId, messageId) => api('DELETE', `/discord/groups/${channelId}/messages/${messageId}`),

  /* ── Multi-DM Blast ──────────────────────────────────────── */
  multiDMStart:    (accountList, userIds, message, images, speedMode) =>
    api('POST', '/multi-dm/start', { accountList, userIds, message, images, speedMode }),
  multiDMStop:     (jobId) => api('POST',  `/multi-dm/stop/${jobId}`),
  multiDMPause:    (jobId) => api('POST',  `/multi-dm/pause/${jobId}`),
  multiDMResume:   (jobId) => api('POST',  `/multi-dm/resume/${jobId}`),
  multiDMValidate: (accountList) => api('POST', '/multi-dm/validate', { accountList }),
  multiDMState:    (jobId) => api('GET',   `/multi-dm/state/${jobId}`),
  multiDMJobs:     ()      => api('GET',   '/multi-dm/jobs'),

  /* ── Blast-specific (work without main Discord connection) ── */
  getBlastServers:  ()                     => api('GET', '/blast/servers'),
  getBlastMembers:  (guildId, channelId)   => api('GET', `/blast/members?guildId=${guildId}${channelId && channelId !== 'all' ? `&channelId=${channelId}` : ''}`),
  getBlastChannels: (guildId)              => api('GET', `/blast/channels/${guildId}`),
};
