const fs = require('node:fs'), path = require('node:path')
// Pinned FreeRDP patch: an ARC rejection must never become a password logon.
module.exports = function patchSessionResume(source) {
  const cp = require('node:child_process'), expected = new Map(), originals = new Map()
  function patch(file, before, after) {
    if (!originals.has(file)) originals.set(file, cp.execFileSync('git', ['-C', source, 'show', 'HEAD:' + file], { encoding: 'utf8', windowsHide: true }).replace(/\r\n/g, '\n'))
    const text = expected.get(file) ?? originals.get(file)
    if (!text.includes(before)) throw new Error('FreeRDP resume patch anchor changed: ' + file)
    expected.set(file, text.replace(before, after))
  }
  patch('libfreerdp/core/info.c', 'if (settings->AutoLogonEnabled)\n\t\tflags |= INFO_AUTOLOGON;', '/* OmniDesk: ARC-only recovery never falls back to automatic logon. */\n\tif (settings->AutoLogonEnabled && !settings->SessionHasBeenReconnected)\n\t\tflags |= INFO_AUTOLOGON;')
  patch('libfreerdp/core/info.c', 'if (!freerdp_settings_get_bool(settings, FreeRDP_RestrictedAdminModeRequired) &&\n\t    !freerdp_settings_get_bool(settings, FreeRDP_DisableCredentialsDelegation))', 'if (!settings->SessionHasBeenReconnected &&\n\t    !freerdp_settings_get_bool(settings, FreeRDP_RestrictedAdminModeRequired) &&\n\t    !freerdp_settings_get_bool(settings, FreeRDP_DisableCredentialsDelegation))')
  patch('libfreerdp/core/rdp.c', 'WLog_Print(rdp->log, WLOG_WARN, "AutoReconnectStatus: 0x%08" PRIX32 "", arcStatus);\n\treturn TRUE;', 'WLog_Print(rdp->log, WLOG_WARN, "AutoReconnectStatus: 0x%08" PRIX32 "", arcStatus);\n\t/* OmniDesk: a rejected ARC cannot proceed into an ordinary logon. */\n\tif (rdp->settings->SessionHasBeenReconnected)\n\t{\n\t\tfreerdp_set_last_error_log(rdp->context, FREERDP_ERROR_CONNECT_ACCESS_DENIED);\n\t\treturn FALSE;\n\t}\n\treturn TRUE;')
  const dirty = cp.execFileSync('git', ['-C', source, 'diff', 'HEAD', '--name-only'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/).filter(Boolean)
  if (dirty.some(file => !expected.has(file))) throw new Error('Unexpected FreeRDP dependency edits')
  for (const [file, text] of expected) {
    const target = path.join(source, file), current = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
    if (current !== originals.get(file) && current !== text) throw new Error('Unreviewed FreeRDP dependency edits: ' + file)
    if (current !== text) fs.writeFileSync(target, text)
  }

}
