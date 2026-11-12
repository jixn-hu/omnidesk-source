#include <freerdp/session.h>

/* ARC-only session recovery. Never submit an ordinary password logon after a disconnect. */
static void emit_diagnostic(Host* host, UINT32 phase, UINT32 error) {
  BYTE data[20];
  write_u32(data, phase); write_u32(data + 4, error);
  write_u32(data + 8, freerdp_error_info(host->common.context.instance));
  write_u32(data + 12, host->resumeAttempts); write_u32(data + 16, GetLastError());
  emit(host, 12, data, sizeof(data));
}
static void emit_resume_state(Host* host, UINT32 state) {
  BYTE data[8]; write_u32(data, state); write_u32(data + 4, host->resumeAttempts);
  emit(host, 11, data, sizeof(data));
}
static DWORD WINAPI resume_watchdog(LPVOID argument) {
  Host* host = argument;
  if (WaitForSingleObject(host->resumeFinished, 45000) == WAIT_TIMEOUT) {
    InterlockedExchange(&host->resumeTimedOut, 1);
    freerdp_abort_connect_context(&host->common.context);
  }
  return 0;
}
static void finish_resume_watchdog(Host* host) {
  if (host->resumeFinished) SetEvent(host->resumeFinished);
  if (host->resumeThread) {
    if (WaitForSingleObject(host->resumeThread, 5000) != WAIT_OBJECT_0) ExitProcess(4);
    CloseHandle(host->resumeThread); host->resumeThread = NULL;
  }
  if (host->resumeFinished) { CloseHandle(host->resumeFinished); host->resumeFinished = NULL; }
}
static BOOL session_resume_info(rdpContext* context, UINT32 type, const void* data) {
  Host* host = (Host*)context;
  if (!host->resuming) return TRUE;
  const ARC_SC_PRIVATE_PACKET* cookie = freerdp_settings_get_pointer(context->settings, FreeRDP_ServerAutoReconnectCookie);
  const logon_info_ex* info = type == INFO_TYPE_LOGON_EXTENDED_INF ? data : NULL;
  if (info && info->haveErrorInfo) { host->resumeRejected = TRUE; freerdp_abort_connect_context(context); return FALSE; }
  if (!info || !info->haveCookie) return TRUE;
  if (!cookie || cookie->cbLen != 28 || cookie->version != 1 || cookie->logonId != host->resumeLogonId || info->haveErrorInfo) {
    host->resumeRejected = TRUE;
    freerdp_abort_connect_context(context); return FALSE;
  }
  InterlockedExchange(&host->resuming, 0);
  if (host->resumeFinished) SetEvent(host->resumeFinished);
  emit_diagnostic(host, 3, 0); emit_resume_state(host, 0);
  return TRUE;
}
static BOOL try_session_resume(Host* host, UINT32 error) {
  rdpContext* context = &host->common.context;
  const ARC_SC_PRIVATE_PACKET* cookie = freerdp_settings_get_pointer(context->settings, FreeRDP_ServerAutoReconnectCookie);
  if (host->stopped || host->resumeTimedOut || error != FREERDP_ERROR_CONNECT_TRANSPORT_FAILED || freerdp_error_info(context->instance) != ERRINFO_SUCCESS) {
    if (host->resuming && !host->stopped && !host->resumeTimedOut) host->resumeRejected = TRUE;
    return FALSE;
  }
  if (!cookie || cookie->cbLen != 28 || cookie->version != 1 || !cookie->logonId) return FALSE;
  if (!host->resuming) {
    finish_resume_watchdog(host);
    host->resumeLogonId = cookie->logonId; host->resumeAttempts = 0; host->resumeRejected = FALSE;
    InterlockedExchange(&host->resuming, 1);
    host->resumeFinished = CreateEvent(NULL, TRUE, FALSE, NULL);
    if (!host->resumeFinished) return FALSE;
    host->resumeThread = CreateThread(NULL, 0, resume_watchdog, host, 0, NULL);
    if (!host->resumeThread) return FALSE;
    SecureZeroMemory(host->keys, sizeof(host->keys));
    SecureZeroMemory(host->unicode, sizeof(host->unicode));
    SecureZeroMemory(host->buttons, sizeof(host->buttons));
  }
  while (!host->stopped && !host->resumeTimedOut && host->resumeAttempts < 3) {
    host->resumeAttempts++;
    emit_resume_state(host, 1); emit_diagnostic(host, 2, error);
    for (UINT32 tick = 0; tick < (100u << (host->resumeAttempts - 1)); tick++) {
      if (host->stopped || host->resumeTimedOut) return FALSE;
      Sleep(10);
    }
    if (!freerdp_settings_set_uint32(context->settings, FreeRDP_TcpConnectTimeout, 5000)) return FALSE;
    if (freerdp_reconnect(context->instance)) return TRUE;
    error = freerdp_get_last_error(context);
    if (error != FREERDP_ERROR_CONNECT_TRANSPORT_FAILED || freerdp_error_info(context->instance) != ERRINFO_SUCCESS) {
      if (!host->stopped && !host->resumeTimedOut) host->resumeRejected = TRUE;
      return FALSE;
    }
    cookie = freerdp_settings_get_pointer(context->settings, FreeRDP_ServerAutoReconnectCookie);
    if (!cookie || cookie->cbLen != 28 || cookie->logonId != host->resumeLogonId) { host->resumeRejected = TRUE; return FALSE; }
  }
  return FALSE;
}
