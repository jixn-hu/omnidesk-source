#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <io.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <freerdp/freerdp.h>
#include <freerdp/client.h>
#include <freerdp/client/channels.h>
#include <freerdp/client/cmdline.h>
#include <freerdp/client/cliprdr.h>
#include <freerdp/client/disp.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/codec/color.h>
#include <freerdp/graphics.h>
#include <freerdp/input.h>
#include <freerdp/error.h>
#include <freerdp/settings.h>
#include <freerdp/constants.h>
#include <freerdp/addin.h>
#include <freerdp/version.h>
#include <freerdp/utils/helpers.h>
#include <winpr/wlog.h>
#include <winpr/ssl.h>
#include "file-clipboard.h"
#include "virtual-files.h"

#define MAX_PACKET (4u * 1024u * 1024u + 128u)
#define MAX_PIXELS (16u * 1024u * 1024u)
#define MAX_QUEUE (8u * 1024u * 1024u)
#ifndef OMNIDESK_RDP_LOG_LEVEL
#define OMNIDESK_RDP_LOG_LEVEL WLOG_OFF
#endif

typedef struct Command {
  BYTE* data;
  UINT32 length;
  struct Command* next;
} Command;

typedef struct {
  rdpClientContext common;
  CRITICAL_SECTION outputLock;
  CRITICAL_SECTION queueLock;
  CRITICAL_SECTION clipboardLock;
  HANDLE commandEvent;
  HANDLE certificateEvent;
  HANDLE readerThread;
  volatile LONG stopped;
  volatile LONG certificateAccepted;
  volatile LONG resuming;
  volatile LONG resumeTimedOut;
  BOOL resumeRejected;
  UINT32 resumeLogonId;
  UINT32 resumeAttempts;
  HANDLE resumeFinished;
  HANDLE resumeThread;
  Command* first;
  Command* last;
  UINT32 queuedBytes;
  UINT32 flags;
  UINT32 scale;
  UINT32 lastWidth;
  UINT32 lastHeight;
  UINT32 requestedWidth;
  UINT32 requestedHeight;
  UINT32 requestedScale;
  BOOL displayReady;
  UINT16 mouseX;
  UINT16 mouseY;
  BYTE keys[512];
  BYTE unicode[65536];
  BYTE buttons[5];
  WCHAR* clipboardText;
  UINT32 clipboardBytes;
  BYTE* clipboardFiles;
  UINT32 clipboardFilesBytes;
  UINT32 clipboardFileId;
  UINT32 remoteFileFormat;
  UINT32 remoteClipboardGeneration;
  UINT32 pendingClipboardGeneration;
  UINT32 requestedFilesGeneration;
  UINT32 pendingClipboardFormat;
  UINT32 remoteClipboardFlags;
  BOOL remoteTextFormat;
  BOOL clipboardReady;
  CliprdrClientContext* clipboard;
  DispClientContext* display;
} Host;

static BOOL pre_connect(freerdp* instance);
static BOOL post_connect(freerdp* instance);
static void post_disconnect(freerdp* instance);
static void release_inputs(Host* host);
static BOOL drain_commands(Host* host);
static BOOL read_configuration(Host* host);

static UINT32 read_u32(const BYTE* data) {
  return (UINT32)data[0] | ((UINT32)data[1] << 8) | ((UINT32)data[2] << 16) | ((UINT32)data[3] << 24);
}

static void write_u32(BYTE* data, UINT32 value) {
  data[0] = (BYTE)value;
  data[1] = (BYTE)(value >> 8);
  data[2] = (BYTE)(value >> 16);
  data[3] = (BYTE)(value >> 24);
}

static BOOL read_exact(BYTE* data, UINT32 length) {
  while (length) {
    DWORD received = 0;
    if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), data, length, &received, NULL) || !received) return FALSE;
    data += received;
    length -= received;
  }
  return TRUE;
}

static BOOL write_exact(const BYTE* data, UINT32 length) {
  while (length) {
    DWORD sent = 0;
    if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), data, length, &sent, NULL) || !sent) return FALSE;
    data += sent;
    length -= sent;
  }
  return TRUE;
}

static BOOL emit(Host* host, BYTE kind, const BYTE* data, UINT32 length) {
  BYTE header[5];
  write_u32(header, length + 1);
  header[4] = kind;
  EnterCriticalSection(&host->outputLock);
  BOOL result = write_exact(header, sizeof(header)) && (!length || write_exact(data, length));
  LeaveCriticalSection(&host->outputLock);
  if (!result) InterlockedExchange(&host->stopped, 1);
  return result;
}

#include "safe-reconnect.h"

static BOOL valid_size(UINT32 width, UINT32 height) {
  return width >= 200 && width <= 8192 && height >= 200 && height <= 8192 && (UINT64)width * height <= MAX_PIXELS;
}

static void emit_size(Host* host) {
  rdpGdi* gdi = host->common.context.gdi;
  BYTE payload[8];
  write_u32(payload, (UINT32)gdi->width);
  write_u32(payload + 4, (UINT32)gdi->height);
  emit(host, 1, payload, sizeof(payload));
}

static BOOL begin_paint(rdpContext* context) {
  if (!context->gdi || !context->gdi->primary || !context->gdi->primary->hdc->hwnd) return FALSE;
  context->gdi->primary->hdc->hwnd->invalid->null = TRUE;
  return TRUE;
}

static BOOL end_paint(rdpContext* context) {
  Host* host = (Host*)context;
  rdpGdi* gdi = context->gdi;
  if (!gdi || !gdi->primary || !gdi->primary->hdc->hwnd) return FALSE;
  const GDI_RGN* dirty = gdi->primary->hdc->hwnd->invalid;
  if (dirty->null || dirty->w <= 0 || dirty->h <= 0) return TRUE;
  if (dirty->x < 0 || dirty->y < 0 || dirty->x + dirty->w > gdi->width || dirty->y + dirty->h > gdi->height) return FALSE;
  UINT32 bytes = (UINT32)dirty->w * (UINT32)dirty->h * 4;
  BYTE header[21];
  write_u32(header, bytes + 17);
  header[4] = 2;
  write_u32(header + 5, (UINT32)dirty->x);
  write_u32(header + 9, (UINT32)dirty->y);
  write_u32(header + 13, (UINT32)dirty->w);
  write_u32(header + 17, (UINT32)dirty->h);
  EnterCriticalSection(&host->outputLock);
  BOOL result = write_exact(header, sizeof(header));
  for (INT32 row = 0; result && row < dirty->h; row++) {
    BYTE* pixels = gdi->primary_buffer + (size_t)(dirty->y + row) * gdi->stride + (size_t)dirty->x * 4;
    for (INT32 column = 0; column < dirty->w; column++) pixels[column * 4 + 3] = 255;
    result = write_exact(pixels, (UINT32)dirty->w * 4);
  }
  LeaveCriticalSection(&host->outputLock);
  return result;
}

static BOOL desktop_resize(rdpContext* context) {
  UINT32 width = freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopWidth);
  UINT32 height = freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopHeight);
  if (!valid_size(width, height) || !gdi_resize(context->gdi, width, height)) return FALSE;
  emit_size((Host*)context);
  return TRUE;
}

static int verify_certificate(freerdp* instance, const BYTE* data, size_t length, const char* hostname, UINT16 port, DWORD flags) {
  Host* host = (Host*)instance->context;
  (void)hostname; (void)port; (void)flags;
  if (host->flags & 1) return 2;
  if (length > 256 * 1024 || host->stopped) return 0;
  ResetEvent(host->certificateEvent);
  InterlockedExchange(&host->certificateAccepted, 0);
  if (!emit(host, 6, data, (UINT32)length)) return 0;
  if (WaitForSingleObject(host->certificateEvent, 120000) != WAIT_OBJECT_0 || host->stopped) return 0;
  return host->certificateAccepted ? 2 : 0;
}

static BOOL authenticate(freerdp* instance, char** username, char** password, char** domain, rdp_auth_reason reason) {
  (void)instance; (void)username; (void)password; (void)domain; (void)reason;
  return FALSE;
}

static DWORD WINAPI read_commands(LPVOID argument) {
  Host* host = argument;
  while (!host->stopped) {
    BYTE header[4];
    if (!read_exact(header, 4)) break;
    UINT32 length = read_u32(header);
    if (!length || length > MAX_PACKET) break;
    BYTE* data = malloc(length);
    if (!data || !read_exact(data, length)) { free(data); break; }
    if (data[0] == 5) { free(data); break; }
    if (data[0] == 6) {
      if (length == 5) { InterlockedExchange(&host->certificateAccepted, read_u32(data + 1) == 1); SetEvent(host->certificateEvent); }
      free(data);
      continue;
    }
    if (host->resuming) { SecureZeroMemory(data, length); free(data); continue; }
    Command* command = calloc(1, sizeof(Command));
    if (!command) { free(data); break; }
    command->data = data;
    command->length = length;
    EnterCriticalSection(&host->queueLock);
    if (host->queuedBytes + length > MAX_QUEUE) {
      LeaveCriticalSection(&host->queueLock);
      free(command->data); free(command); break;
    }
    if (host->last) host->last->next = command;
    else host->first = command;
    host->last = command;
    host->queuedBytes += length;
    SetEvent(host->commandEvent);
    LeaveCriticalSection(&host->queueLock);
  }
  InterlockedExchange(&host->stopped, 1);
  SetEvent(host->certificateEvent);
  SetEvent(host->commandEvent);
  freerdp_abort_connect_context(&host->common.context);
  return 0;
}

static UINT announce_clipboard(Host* host) {
  if (!host->clipboard) return CHANNEL_RC_OK;
  CLIPRDR_FORMAT format = { .formatId = host->clipboardFiles ? 0xc001 : CF_UNICODETEXT, .formatName = host->clipboardFiles ? "FileGroupDescriptorW" : NULL };
  CLIPRDR_FORMAT_LIST list = { 0 };
  list.numFormats = host->clipboardFiles || host->clipboardText ? 1 : 0;
  list.formats = &format;
  return host->clipboard->ClientFormatList(host->clipboard, &list);
}

static void emit_file(Host* host, UINT32 action, const UINT32* values, UINT32 count, const BYTE* data, UINT32 length) {
  if (count > 8 || length > MAX_PACKET - 64) return;
  BYTE* payload = malloc(4 + count * 4 + length);
  if (!payload) return;
  write_u32(payload, action);
  for (UINT32 index = 0; index < count; index++) write_u32(payload + 4 + index * 4, values[index]);
  if (length) memcpy(payload + 4 + count * 4, data, length);
  emit(host, 9, payload, 4 + count * 4 + length);
  free(payload);
}

static UINT clipboard_capabilities(CliprdrClientContext* clipboard, const CLIPRDR_CAPABILITIES* capabilities) {
  Host* host = clipboard->custom;
  const BYTE* current = (const BYTE*)capabilities->capabilitySets;
  EnterCriticalSection(&host->clipboardLock);
  host->remoteClipboardFlags = 0;
  for (UINT32 index = 0; current && index < capabilities->cCapabilitiesSets && index < 64; index++) {
    const CLIPRDR_CAPABILITY_SET* capability = (const CLIPRDR_CAPABILITY_SET*)current;
    if (capability->capabilitySetLength < sizeof(*capability)) break;
    if (capability->capabilitySetType == CB_CAPSTYPE_GENERAL && capability->capabilitySetLength >= CB_CAPSTYPE_GENERAL_LEN) host->remoteClipboardFlags = ((const CLIPRDR_GENERAL_CAPABILITY_SET*)current)->generalFlags;
    current += capability->capabilitySetLength;
  }
  LeaveCriticalSection(&host->clipboardLock);
  return CHANNEL_RC_OK;
}

static UINT clipboard_ready(CliprdrClientContext* clipboard, const CLIPRDR_MONITOR_READY* ready) {
  (void)ready;
  CLIPRDR_GENERAL_CAPABILITY_SET general = { 0 };
  general.capabilitySetType = CB_CAPSTYPE_GENERAL;
  general.capabilitySetLength = CB_CAPSTYPE_GENERAL_LEN;
  general.version = CB_CAPS_VERSION_2;
  general.generalFlags = CB_USE_LONG_FORMAT_NAMES | CB_STREAM_FILECLIP_ENABLED | CB_FILECLIP_NO_FILE_PATHS | CB_HUGE_FILE_SUPPORT_ENABLED;
  CLIPRDR_CAPABILITIES capabilities = { 0 };
  capabilities.cCapabilitiesSets = 1;
  capabilities.capabilitySets = (CLIPRDR_CAPABILITY_SET*)&general;
  UINT result = clipboard->ClientCapabilities(clipboard, &capabilities);
  Host* host = clipboard->custom;
  EnterCriticalSection(&host->clipboardLock);
  host->clipboardReady = result == CHANNEL_RC_OK;
  if (result == CHANNEL_RC_OK) result = announce_clipboard(host);
  LeaveCriticalSection(&host->clipboardLock);
  return result;
}

static void invalidate_remote_clipboard(Host* host) {
  host->remoteClipboardGeneration++;
  if (!host->remoteClipboardGeneration) host->remoteClipboardGeneration++;
  host->remoteFileFormat = 0;
  host->remoteTextFormat = FALSE;
  host->requestedFilesGeneration = 0;
}

static UINT request_clipboard(Host* host) {
  if (host->pendingClipboardFormat) return CHANNEL_RC_OK;
  UINT32 format = 0;
  if (host->remoteFileFormat && host->requestedFilesGeneration == host->remoteClipboardGeneration) {
    format = host->remoteFileFormat;
    host->requestedFilesGeneration = 0;
  } else if (!host->remoteFileFormat && host->remoteTextFormat) format = CF_UNICODETEXT;
  if (!format) return CHANNEL_RC_OK;
  host->pendingClipboardFormat = format;
  host->pendingClipboardGeneration = host->remoteClipboardGeneration;
  CLIPRDR_FORMAT_DATA_REQUEST request = { 0 };
  request.requestedFormatId = format;
  host->clipboard->lastRequestedFormatId = format;
  return host->clipboard->ClientFormatDataRequest(host->clipboard, &request);
}

static UINT clipboard_formats(CliprdrClientContext* clipboard, const CLIPRDR_FORMAT_LIST* formats) {
  CLIPRDR_FORMAT_LIST_RESPONSE response = { 0 };
  response.common.msgFlags = CB_RESPONSE_OK;
  UINT result = clipboard->ClientFormatListResponse(clipboard, &response);
  if (result != CHANNEL_RC_OK) return result;
  Host* host = clipboard->custom;
  EnterCriticalSection(&host->clipboardLock);
  invalidate_remote_clipboard(host);
  for (UINT32 index = 0; index < formats->numFormats; index++) {
    const CLIPRDR_FORMAT* format = &formats->formats[index];
    if (format->formatId == CF_UNICODETEXT) host->remoteTextFormat = TRUE;
    if (format->formatId >= 0xc000 && format->formatName && !strcmp(format->formatName, "FileGroupDescriptorW")) host->remoteFileFormat = format->formatId;
  }
  UINT32 values[] = { host->remoteClipboardGeneration, host->remoteFileFormat != 0, GetClipboardSequenceNumber() };
  emit_file(host, 1, values, 3, NULL, 0);
  result = request_clipboard(host);
  LeaveCriticalSection(&host->clipboardLock);
  return result;
}

static UINT clipboard_request(CliprdrClientContext* clipboard, const CLIPRDR_FORMAT_DATA_REQUEST* request) {
  Host* host = clipboard->custom;
  CLIPRDR_FORMAT_DATA_RESPONSE response = { 0 };
  response.common.msgFlags = CB_RESPONSE_FAIL;
  EnterCriticalSection(&host->clipboardLock);
  if (request->requestedFormatId == CF_UNICODETEXT && host->clipboardText) {
    response.common.msgFlags = CB_RESPONSE_OK;
    response.common.dataLen = host->clipboardBytes;
    response.requestedFormatData = (const BYTE*)host->clipboardText;
  } else if (request->requestedFormatId == 0xc001 && host->clipboardFiles) {
    response.common.msgFlags = CB_RESPONSE_OK;
    response.common.dataLen = host->clipboardFilesBytes;
    response.requestedFormatData = host->clipboardFiles;
  }
  UINT result = clipboard->ClientFormatDataResponse(clipboard, &response);
  LeaveCriticalSection(&host->clipboardLock);
  return result;
}

static UINT clipboard_text_received(CliprdrClientContext* clipboard, const CLIPRDR_FORMAT_DATA_RESPONSE* response) {
  if (!(response->common.msgFlags & CB_RESPONSE_OK) || response->common.dataLen > MAX_PACKET - 128 || response->common.dataLen % 2 || !response->requestedFormatData) return CHANNEL_RC_OK;
  const WCHAR* wide = (const WCHAR*)response->requestedFormatData;
  UINT32 count = response->common.dataLen / 2;
  if (count > 1024 * 1024 + 1) return CHANNEL_RC_OK;
  UINT32 length = 0;
  while (length < count && wide[length]) length++;
  if (!length) return emit(clipboard->custom, 5, NULL, 0) ? CHANNEL_RC_OK : ERROR_INTERNAL_ERROR;
  int needed = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide, (int)length, NULL, 0, NULL, NULL);
  if (needed < 0 || needed > (int)MAX_PACKET - 128 || (length && !needed)) return CHANNEL_RC_OK;
  BYTE* text = malloc((size_t)needed + 1);
  if (!text) return ERROR_NOT_ENOUGH_MEMORY;
  if (needed) WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide, (int)length, (char*)text, needed, NULL, NULL);
  emit(clipboard->custom, 5, text, (UINT32)needed);
  free(text);
  return CHANNEL_RC_OK;
}

static UINT clipboard_received(CliprdrClientContext* clipboard, const CLIPRDR_FORMAT_DATA_RESPONSE* response) {
  Host* host = clipboard->custom;
  EnterCriticalSection(&host->clipboardLock);
  UINT32 generation = host->pendingClipboardGeneration;
  UINT32 format = host->pendingClipboardFormat;
  host->pendingClipboardFormat = 0;
  if (format && format != CF_UNICODETEXT) {
    BOOL valid = (response->common.msgFlags & CB_RESPONSE_OK) && response->common.dataLen <= 4 + 4096 * 592 && response->requestedFormatData;
    UINT32 values[] = { generation, valid };
    emit_file(host, 2, values, 2, valid ? response->requestedFormatData : NULL, valid ? response->common.dataLen : 0);
  } else if (format == CF_UNICODETEXT && generation == host->remoteClipboardGeneration) clipboard_text_received(clipboard, response);
  UINT result = generation != host->remoteClipboardGeneration || host->requestedFilesGeneration ? request_clipboard(host) : CHANNEL_RC_OK;
  LeaveCriticalSection(&host->clipboardLock);
  return result;
}

static UINT clipboard_file_request(CliprdrClientContext* clipboard, const CLIPRDR_FILE_CONTENTS_REQUEST* request) {
  Host* host = clipboard->custom;
  EnterCriticalSection(&host->clipboardLock);
  UINT32 values[] = { host->clipboardFileId, request->streamId, request->listIndex, request->dwFlags, request->nPositionLow, request->nPositionHigh, request->cbRequested };
  emit_file(host, 3, values, 7, NULL, 0);
  LeaveCriticalSection(&host->clipboardLock);
  return CHANNEL_RC_OK;
}

static UINT clipboard_file_received(CliprdrClientContext* clipboard, const CLIPRDR_FILE_CONTENTS_RESPONSE* response) {
  BOOL valid = (response->common.msgFlags & CB_RESPONSE_OK) && response->cbRequested <= 256 * 1024 && (!response->cbRequested || response->requestedData);
  UINT32 values[] = { response->streamId, valid };
  emit_file(clipboard->custom, 4, values, 2, valid ? response->requestedData : NULL, valid ? response->cbRequested : 0);
  return CHANNEL_RC_OK;
}

static BOOL clipboard_file_command(Host* host, const BYTE* data, UINT32 length) {
  if (length < 4) return FALSE;
  UINT32 action = read_u32(data);
  EnterCriticalSection(&host->clipboardLock);
  if (action == 1 && length >= 12 && length <= 12 + 4096 * 592) {
    UINT32 count = read_u32(data + 8);
    BOOL valid = host->clipboard && host->clipboardReady && (host->remoteClipboardFlags & CB_STREAM_FILECLIP_ENABLED) && count && count <= 4096 && length == 12 + count * 592;
    if (valid && !(host->remoteClipboardFlags & CB_HUGE_FILE_SUPPORT_ENABLED)) {
      for (UINT32 index = 0; index < count; index++) if (read_u32(data + 12 + index * 592 + 64)) valid = FALSE;
    }
    BYTE* files = valid ? malloc(length - 8) : NULL;
    if (files) {
      memcpy(files, data + 8, length - 8);
      free(host->clipboardFiles); host->clipboardFiles = files; host->clipboardFilesBytes = length - 8;
      host->clipboardFileId = read_u32(data + 4);
      invalidate_remote_clipboard(host);
      valid = announce_clipboard(host) == CHANNEL_RC_OK;
    } else valid = FALSE;
    UINT32 values[] = { read_u32(data + 4), valid };
    emit_file(host, 5, values, 2, NULL, 0);
  } else if (action == 2 && length == 8) {
    UINT32 generation = read_u32(data + 4);
    if (host->clipboard && host->remoteFileFormat && generation == host->remoteClipboardGeneration) { host->requestedFilesGeneration = generation; request_clipboard(host); }
    else { UINT32 values[] = { generation, 0 }; emit_file(host, 2, values, 2, NULL, 0); }
  } else if (action == 3 && length == 28 && host->clipboard) {
    CLIPRDR_FILE_CONTENTS_REQUEST request = { 0 };
    request.streamId = read_u32(data + 4); request.listIndex = read_u32(data + 8); request.dwFlags = read_u32(data + 12);
    request.nPositionLow = read_u32(data + 16); request.nPositionHigh = read_u32(data + 20); request.cbRequested = read_u32(data + 24);
    host->clipboard->ClientFileContentsRequest(host->clipboard, &request);
  } else if (action == 4 && length >= 12 && length <= MAX_PACKET - 64 && host->clipboard) {
    CLIPRDR_FILE_CONTENTS_RESPONSE response = { 0 };
    response.streamId = read_u32(data + 4); response.common.msgFlags = read_u32(data + 8) ? CB_RESPONSE_OK : CB_RESPONSE_FAIL;
    response.cbRequested = length - 12; response.requestedData = data + 12;
    host->clipboard->ClientFileContentsResponse(host->clipboard, &response);
  } else if (action == 5 && length == 4) {
    free(host->clipboardFiles); host->clipboardFiles = NULL; host->clipboardFilesBytes = 0;
    host->clipboardFileId = 0;
  } else { LeaveCriticalSection(&host->clipboardLock); return FALSE; }
  LeaveCriticalSection(&host->clipboardLock);
  return TRUE;
}

static UINT send_layout(Host* host) {
  if (!host->displayReady || !host->display || !(host->flags & 8)) return CHANNEL_RC_OK;
  UINT32 width = host->requestedWidth;
  UINT32 height = host->requestedHeight;
  UINT32 scale = host->requestedScale;
  if (host->lastWidth == width && host->lastHeight == height && host->scale == scale) return CHANNEL_RC_OK;
  DISPLAY_CONTROL_MONITOR_LAYOUT monitor = { 0 };
  monitor.Flags = DISPLAY_CONTROL_MONITOR_PRIMARY;
  monitor.Width = width;
  monitor.Height = height;
  monitor.PhysicalWidth = width * 254 / (96 * 10);
  monitor.PhysicalHeight = height * 254 / (96 * 10);
  monitor.DesktopScaleFactor = scale;
  monitor.DeviceScaleFactor = 100;
  UINT result = host->display->SendMonitorLayout(host->display, 1, &monitor);
  if (result == CHANNEL_RC_OK) { host->lastWidth = width; host->lastHeight = height; host->scale = scale; }
  return result;
}

static UINT display_caps(DispClientContext* display, UINT32 monitors, UINT32 factorA, UINT32 factorB) {
  Host* host = display->custom;
  host->displayReady = monitors > 0 && factorA > 0 && factorB > 0;
  UINT result = send_layout(host);
  (void)result;
  return CHANNEL_RC_OK;
}

static void channel_connected(void* context, const ChannelConnectedEventArgs* arguments) {
  Host* host = context;
  if (!strcmp(arguments->name, CLIPRDR_SVC_CHANNEL_NAME)) {
    host->clipboard = arguments->pInterface;
    host->clipboard->custom = host;
    host->clipboard->MonitorReady = clipboard_ready;
    host->clipboard->ServerCapabilities = clipboard_capabilities;
    host->clipboard->ServerFormatList = clipboard_formats;
    host->clipboard->ServerFormatDataRequest = clipboard_request;
    host->clipboard->ServerFormatDataResponse = clipboard_received;
    host->clipboard->ServerFileContentsRequest = clipboard_file_request;
    host->clipboard->ServerFileContentsResponse = clipboard_file_received;
  } else if (!strcmp(arguments->name, DISP_DVC_CHANNEL_NAME)) {
    host->display = arguments->pInterface;
    host->display->custom = host;
    host->displayReady = FALSE;
    host->display->DisplayControlCaps = display_caps;
  } else freerdp_client_OnChannelConnectedEventHandler(context, arguments);
}

static void channel_disconnected(void* context, const ChannelDisconnectedEventArgs* arguments) {
  Host* host = context;
  if (!strcmp(arguments->name, CLIPRDR_SVC_CHANNEL_NAME)) {
    EnterCriticalSection(&host->clipboardLock);
    host->clipboard = NULL; host->clipboardReady = FALSE;
    invalidate_remote_clipboard(host);
    host->pendingClipboardFormat = 0;
    host->pendingClipboardGeneration = 0;
    LeaveCriticalSection(&host->clipboardLock);
  }
  else if (!strcmp(arguments->name, DISP_DVC_CHANNEL_NAME)) { host->display = NULL; host->displayReady = FALSE; }
  else freerdp_client_OnChannelDisconnectedEventHandler(context, arguments);
}

static BOOL pointer_new(rdpContext* context, rdpPointer* pointer) {
  (void)context; (void)pointer;
  return TRUE;
}

static void pointer_free(rdpContext* context, rdpPointer* pointer) { (void)context; (void)pointer; }

static BOOL pointer_set(rdpContext* context, rdpPointer* pointer) {
  if (!pointer->width || !pointer->height || pointer->width > 384 || pointer->height > 384) {
    BYTE hidden = 0;
    return emit((Host*)context, 8, &hidden, 1);
  }
  UINT32 bytes = pointer->width * pointer->height * 4;
  BYTE* payload = calloc(1, bytes + 16);
  if (!payload) return FALSE;
  write_u32(payload, pointer->width);
  write_u32(payload + 4, pointer->height);
  write_u32(payload + 8, pointer->xPos);
  write_u32(payload + 12, pointer->yPos);
  BOOL result = freerdp_image_copy_from_pointer_data(payload + 16, PIXEL_FORMAT_RGBA32, pointer->width * 4, 0, 0, pointer->width, pointer->height, pointer->xorMaskData, pointer->lengthXorMask, pointer->andMaskData, pointer->lengthAndMask, pointer->xorBpp, &context->gdi->palette);
  if (result) result = emit((Host*)context, 7, payload, bytes + 16);
  free(payload);
  return result;
}

static BOOL client_new(freerdp* instance, rdpContext* context) {
  Host* host = (Host*)context;
  InitializeCriticalSection(&host->outputLock);
  InitializeCriticalSection(&host->queueLock);
  InitializeCriticalSection(&host->clipboardLock);
  host->commandEvent = CreateEvent(NULL, TRUE, FALSE, NULL);
  host->certificateEvent = CreateEvent(NULL, TRUE, FALSE, NULL);
  instance->PreConnect = pre_connect;
  instance->PostConnect = post_connect;
  instance->PostDisconnect = post_disconnect;
  instance->AuthenticateEx = authenticate;
  instance->VerifyX509Certificate = verify_certificate;
  instance->RetryDialog = NULL;
  instance->GetAccessToken = NULL;
  return host->commandEvent && host->certificateEvent;
}

static void client_free(freerdp* instance, rdpContext* context) {
  (void)instance;
  Host* host = (Host*)context;
  while (host->first) {
    Command* command = host->first;
    host->first = command->next;
    SecureZeroMemory(command->data, command->length);
    free(command->data);
    free(command);
  }
  if (host->clipboardText) {
    SecureZeroMemory(host->clipboardText, host->clipboardBytes);
    free(host->clipboardText);
  }
  finish_resume_watchdog(host);
  if (host->readerThread) CloseHandle(host->readerThread);
  if (host->commandEvent) CloseHandle(host->commandEvent);
  if (host->certificateEvent) CloseHandle(host->certificateEvent);
  DeleteCriticalSection(&host->outputLock);
  DeleteCriticalSection(&host->queueLock);
  DeleteCriticalSection(&host->clipboardLock);
  free(host->clipboardFiles);
}

int main(int argc, char** argv) {
  int virtualResult = virtual_files_cli(argc, argv);
  if (virtualResult >= 0) return virtualResult;
  int clipboardResult = file_clipboard_cli(argc, argv);
  if (clipboardResult >= 0) return clipboardResult;
  if (argc == 2 && !strcmp(argv[1], "--version")) {
    printf("OmniDesk FreeRDP %s protocol=6\n", FREERDP_VERSION_FULL);
    return 0;
  }
  if (argc != 1) return 2;
  WSADATA sockets;
  if (WSAStartup(MAKEWORD(2, 2), &sockets)) return 3;
  if (!WLog_SetLogLevel(WLog_GetRoot(), OMNIDESK_RDP_LOG_LEVEL)) return 3;
  if (!winpr_InitializeSSL(WINPR_SSL_INIT_DEFAULT)) return 3;
  if (!freerdp_setApplicationDetails("OmniDesk", "FreeRDPHost", 1)) return 3;
  if (freerdp_register_addin_provider(freerdp_channels_load_static_addin_entry, 0) != 0) return 3;
  RDP_CLIENT_ENTRY_POINTS entry = { 0 };
  entry.Size = sizeof(entry);
  entry.Version = RDP_CLIENT_INTERFACE_VERSION;
  entry.ContextSize = sizeof(Host);
  entry.ClientNew = client_new;
  entry.ClientFree = client_free;
  rdpContext* context = freerdp_client_context_new(&entry);
  if (!context) return 3;
  Host* host = (Host*)context;
  UINT32 error = FREERDP_ERROR_CONNECT_FAILED;
  BOOL connected = FALSE;
  if (!read_configuration(host)) goto done;
  host->readerThread = CreateThread(NULL, 0, read_commands, host, 0, NULL);
  if (!host->readerThread) goto done;
  connected = freerdp_connect(context->instance);
  if (!connected) {
    error = freerdp_get_last_error(context);
    if (!error) error = FREERDP_ERROR_CONNECT_FAILED;
    goto done;
  }
  error = FREERDP_ERROR_SUCCESS;
  while (!host->stopped) {
    HANDLE handles[MAXIMUM_WAIT_OBJECTS];
    DWORD count = freerdp_get_event_handles(context, handles, MAXIMUM_WAIT_OBJECTS - 1);
    if (!count || count >= MAXIMUM_WAIT_OBJECTS) { error = FREERDP_ERROR_CONNECT_FAILED; break; }
    handles[count] = host->commandEvent;
    DWORD waited = WaitForMultipleObjects(count + 1, handles, FALSE, 1000);
    if (waited == WAIT_FAILED || !drain_commands(host) || !freerdp_check_event_handles(context) || freerdp_shall_disconnect_context(context)) {
      error = freerdp_get_last_error(context);
      if (!error) error = FREERDP_ERROR_CONNECT_FAILED;
      emit_diagnostic(host, 1, error);
      if (try_session_resume(host, error)) { error = FREERDP_ERROR_SUCCESS; continue; }
      if (host->resuming) error = freerdp_get_last_error(context) ? freerdp_get_last_error(context) : error;
      break;
    }
  }
  if (!error) error = freerdp_get_last_error(context);
done:
  emit_diagnostic(host, 4, error);
  finish_resume_watchdog(host);
  if (error == FREERDP_ERROR_LOGOFF_BY_USER || error == FREERDP_ERROR_RPC_INITIATED_LOGOFF || error == FREERDP_ERROR_RPC_INITIATED_DISCONNECT_BY_USER) error = FREERDP_ERROR_SUCCESS;
  if (connected) release_inputs(host);
  BOOL cancelled = host->stopped;
  InterlockedExchange(&host->stopped, 1);
  SetEvent(host->certificateEvent);
  if (host->readerThread) {
    CancelSynchronousIo(host->readerThread);
    if (WaitForSingleObject(host->readerThread, 5000) != WAIT_OBJECT_0) ExitProcess(4);
  }
  if (!cancelled && error && error != FREERDP_ERROR_SUCCESS) {
    const char* name = host->resumeRejected ? "OMNIDESK_SESSION_RESUME_REJECTED" : host->resumeTimedOut ? "OMNIDESK_SESSION_RESUME_TIMEOUT" : freerdp_get_last_error_name(error);
    size_t length = name ? strlen(name) : 0;
    BYTE payload[260] = { 0 };
    if (length > sizeof(payload) - 4) length = sizeof(payload) - 4;
    write_u32(payload, error);
    if (length) memcpy(payload + 4, name, length);
    emit(host, 3, payload, (UINT32)length + 4);
  }
  BYTE ended[4];
  write_u32(ended, cancelled ? 0 : error);
  emit(host, 4, ended, 4);
  BOOL disconnected = freerdp_disconnect(context->instance);
  (void)disconnected;
  freerdp_client_context_free(context);
  WSACleanup();
  return !cancelled && error ? 1 : 0;
}

static BOOL pointer_hide(rdpContext* context) { BYTE hidden = 1; return emit((Host*)context, 8, &hidden, 1); }
static BOOL pointer_default(rdpContext* context) { BYTE hidden = 0; return emit((Host*)context, 8, &hidden, 1); }

static BOOL pre_connect(freerdp* instance) {
  if (PubSub_SubscribeChannelConnected(instance->context->pubSub, channel_connected) < 0) return FALSE;
  if (PubSub_SubscribeChannelDisconnected(instance->context->pubSub, channel_disconnected) < 0) return FALSE;
  return TRUE;
}

static BOOL post_connect(freerdp* instance) {
  rdpContext* context = instance->context;
  UINT32 width = freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopWidth);
  UINT32 height = freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopHeight);
  if (!valid_size(width, height) || !gdi_init(instance, PIXEL_FORMAT_RGBA32)) return FALSE;
  context->update->BeginPaint = begin_paint;
  context->update->EndPaint = end_paint;
  context->update->SaveSessionInfo = session_resume_info;
  context->update->DesktopResize = desktop_resize;
  rdpPointer pointer = { 0 };
  pointer.size = sizeof(rdpPointer);
  pointer.New = pointer_new;
  pointer.Free = pointer_free;
  pointer.Set = pointer_set;
  pointer.SetNull = pointer_hide;
  pointer.SetDefault = pointer_default;
  graphics_register_pointer(context->graphics, &pointer);
  emit_size((Host*)context);
  return TRUE;
}

static void post_disconnect(freerdp* instance) {
  PubSub_UnsubscribeChannelConnected(instance->context->pubSub, channel_connected);
  PubSub_UnsubscribeChannelDisconnected(instance->context->pubSub, channel_disconnected);
  gdi_free(instance);
}

static BOOL keyboard_event(Host* host, UINT32 scan, BOOL down) {
  UINT16 flags = down ? 0 : KBD_FLAGS_RELEASE;
  if ((scan & 0xff00) == 0xe000) flags |= KBD_FLAGS_EXTENDED;
  UINT32 index = (scan & 0xff) + ((flags & KBD_FLAGS_EXTENDED) ? 256 : 0);
  host->keys[index] = (BYTE)down;
  return freerdp_input_send_keyboard_event(host->common.context.input, flags, (BYTE)scan);
}

static BOOL mouse_button_event(Host* host, UINT32 button, BOOL down) {
  if (button >= 5) return FALSE;
  host->buttons[button] = (BYTE)down;
  rdpInput* input = host->common.context.input;
  if (button < 3) {
    const UINT16 flags[] = { PTR_FLAGS_BUTTON1, PTR_FLAGS_BUTTON3, PTR_FLAGS_BUTTON2 };
    return freerdp_input_send_mouse_event(input, flags[button] | (down ? PTR_FLAGS_DOWN : 0), host->mouseX, host->mouseY);
  }
  const UINT16 flags = button == 3 ? PTR_XFLAGS_BUTTON1 : PTR_XFLAGS_BUTTON2;
  return freerdp_input_send_extended_mouse_event(input, flags | (down ? PTR_XFLAGS_DOWN : 0), host->mouseX, host->mouseY);
}

static void release_inputs(Host* host) {
  rdpInput* input = host->common.context.input;
  for (UINT32 index = 0; index < 512; index++) if (host->keys[index]) {
    keyboard_event(host, (index & 0xff) | (index >= 256 ? 0xe000 : 0), FALSE);
  }
  for (UINT32 index = 0; index < 65536; index++) if (host->unicode[index]) {
    freerdp_input_send_unicode_keyboard_event(input, KBD_FLAGS_RELEASE, (UINT16)index);
    host->unicode[index] = 0;
  }
  for (UINT32 index = 0; index < 5; index++) if (host->buttons[index]) mouse_button_event(host, index, FALSE);
}

static BOOL apply_inputs(Host* host, const BYTE* data, UINT32 length) {
  if (length < 4) return FALSE;
  UINT32 count = read_u32(data);
  if (count > 4096 || length != 4 + count * 12) return FALSE;
  rdpInput* input = host->common.context.input;
  for (UINT32 index = 0; index < count; index++) {
    const BYTE* event = data + 4 + index * 12;
    UINT32 kind = read_u32(event);
    UINT32 first = read_u32(event + 4);
    UINT32 second = read_u32(event + 8);
    BOOL result = FALSE;
    if (kind == 1 || kind == 2) {
      if (first > 0xff && ((first & 0xff00) != 0xe000 || first > 0xe0ff)) return FALSE;
      result = keyboard_event(host, first, kind == 1);
    } else if (kind == 3 || kind == 4) {
      if (first > 65535) return FALSE;
      host->unicode[first] = kind == 3;
      result = freerdp_input_send_unicode_keyboard_event(input, kind == 3 ? 0 : KBD_FLAGS_RELEASE, (UINT16)first);
    } else if (kind == 5) {
      rdpGdi* gdi = host->common.context.gdi;
      if (first >= (UINT32)gdi->width) first = (UINT32)gdi->width - 1;
      if (second >= (UINT32)gdi->height) second = (UINT32)gdi->height - 1;
      host->mouseX = (UINT16)first;
      host->mouseY = (UINT16)second;
      result = freerdp_input_send_mouse_event(input, PTR_FLAGS_MOVE, host->mouseX, host->mouseY);
    } else if (kind == 6 || kind == 7) {
      result = mouse_button_event(host, first, kind == 6);
    } else if (kind == 8) {
      INT32 amount = (INT32)first;
      if (amount < -255 || amount > 255) return FALSE;
      UINT16 flags = second ? PTR_FLAGS_HWHEEL : PTR_FLAGS_WHEEL;
      flags |= (UINT16)(amount & 0x1ff);
      result = freerdp_input_send_mouse_event(input, flags, host->mouseX, host->mouseY);
    }
    if (!result) return FALSE;
  }
  return TRUE;
}

static BOOL apply_command(Host* host, const BYTE* data, UINT32 length) {
  if (!length) return FALSE;
  if (data[0] == 2) return apply_inputs(host, data + 1, length - 1);
  if (data[0] == 8 && (host->flags & 2)) return clipboard_file_command(host, data + 1, length - 1);
  if (data[0] == 7 && length == 1) { release_inputs(host); return TRUE; }
  if (data[0] == 3 && length == 13) {
    UINT32 width = read_u32(data + 1);
    UINT32 height = read_u32(data + 5);
    UINT32 scale = read_u32(data + 9);
    if (!valid_size(width, height) || width % 2 || scale < 100 || scale > 200) return FALSE;
    host->requestedWidth = width;
    host->requestedHeight = height;
    host->requestedScale = scale;
    UINT result = send_layout(host);
    (void)result;
    return TRUE;
  }
  if (data[0] == 4 && (host->flags & 2)) {
    int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (const char*)data + 1, (int)length - 1, NULL, 0);
    if ((length > 1 && count <= 0) || count > 1024 * 1024) return FALSE;
    WCHAR* wide = calloc((size_t)count + 1, sizeof(WCHAR));
    if (!wide) return FALSE;
    if (count) MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (const char*)data + 1, (int)length - 1, wide, count);
    EnterCriticalSection(&host->clipboardLock);
    free(host->clipboardText);
    host->clipboardText = wide;
    host->clipboardBytes = ((UINT32)count + 1) * 2;
    free(host->clipboardFiles); host->clipboardFiles = NULL; host->clipboardFilesBytes = 0;
    host->clipboardFileId = 0;
    invalidate_remote_clipboard(host);
    UINT result = announce_clipboard(host);
    LeaveCriticalSection(&host->clipboardLock);
    return result == CHANNEL_RC_OK;
  }
  return FALSE;
}

static BOOL drain_commands(Host* host) {
  for (;;) {
    EnterCriticalSection(&host->queueLock);
    Command* command = host->first;
    if (command) {
      host->first = command->next;
      if (!host->first) host->last = NULL;
      host->queuedBytes -= command->length;
    } else ResetEvent(host->commandEvent);
    LeaveCriticalSection(&host->queueLock);
    if (!command) return TRUE;
    BOOL result = host->resuming || apply_command(host, command->data, command->length);
    SecureZeroMemory(command->data, command->length);
    free(command->data);
    free(command);
    if (!result) return FALSE;
  }
}

static char* config_string(const BYTE** cursor, const BYTE* end) {
  if ((size_t)(end - *cursor) < 4) return NULL;
  UINT32 length = read_u32(*cursor);
  *cursor += 4;
  if (length > 65536 || (size_t)(end - *cursor) < length || memchr(*cursor, 0, length)) return NULL;
  char* value = calloc((size_t)length + 1, 1);
  if (!value) return NULL;
  memcpy(value, *cursor, length);
  *cursor += length;
  return value;
}

static BOOL read_configuration(Host* host) {
  BYTE header[4];
  if (!read_exact(header, 4)) return FALSE;
  UINT32 length = read_u32(header);
  if (length < 65 || length > 256 * 1024) return FALSE;
  BYTE* packet = malloc(length);
  if (!packet || !read_exact(packet, length)) { free(packet); return FALSE; }
  BOOL result = FALSE;
  char* strings[7] = { 0 };
  if (packet[0] != 1) goto done;
  const BYTE* data = packet + 1;
  UINT32 width = read_u32(data);
  UINT32 height = read_u32(data + 4);
  UINT32 scale = read_u32(data + 8);
  UINT32 port = read_u32(data + 12);
  UINT32 flags = read_u32(data + 16);
  UINT32 depth = read_u32(data + 20);
  UINT32 proxy = read_u32(data + 24);
  UINT32 proxyPort = read_u32(data + 28);
  UINT32 performance = read_u32(data + 32);
  if (!valid_size(width, height) || width % 2 || scale < 100 || scale > 200 || !port || port > 65535 || flags > 15 || (depth != 16 && depth != 24 && depth != 32) || proxy > 2 || proxyPort > 65535 || (proxy && !proxyPort)) goto done;
  const BYTE* cursor = data + 36;
  const BYTE* end = packet + length;
  for (UINT32 index = 0; index < 7; index++) { strings[index] = config_string(&cursor, end); if (!strings[index]) goto done; }
  if (cursor != end || !strings[0][0] || !strings[1][0] || !strings[2][0] || (proxy && !strings[4][0])) goto done;
  host->flags = flags;
  host->scale = scale;
  host->lastWidth = width;
  host->lastHeight = height;
  host->requestedWidth = width;
  host->requestedHeight = height;
  host->requestedScale = scale;
  rdpSettings* settings = host->common.context.settings;
  result = freerdp_settings_set_string(settings, FreeRDP_ServerHostname, strings[0]) &&
    freerdp_settings_set_string(settings, FreeRDP_Username, strings[1]) &&
    freerdp_settings_set_string(settings, FreeRDP_Password, strings[2]) &&
    freerdp_settings_set_string(settings, FreeRDP_Domain, strings[3]) &&
    freerdp_settings_set_uint32(settings, FreeRDP_ServerPort, port) &&
    freerdp_settings_set_uint32(settings, FreeRDP_DesktopWidth, width) &&
    freerdp_settings_set_uint32(settings, FreeRDP_DesktopHeight, height) &&
    freerdp_settings_set_uint32(settings, FreeRDP_DesktopScaleFactor, scale) &&
    freerdp_settings_set_uint32(settings, FreeRDP_DeviceScaleFactor, 100) &&
    freerdp_settings_set_uint32(settings, FreeRDP_ColorDepth, depth) &&
    freerdp_settings_set_uint32(settings, FreeRDP_PerformanceFlags, performance) &&
    freerdp_settings_set_bool(settings, FreeRDP_RdpSecurity, !!(flags & 4)) &&
    freerdp_settings_set_bool(settings, FreeRDP_TlsSecurity, !(flags & 4)) &&
    freerdp_settings_set_bool(settings, FreeRDP_NlaSecurity, !(flags & 4)) &&
    freerdp_settings_set_bool(settings, FreeRDP_ExtSecurity, !(flags & 4)) &&
    freerdp_settings_set_bool(settings, FreeRDP_IgnoreCertificate, !!(flags & 1)) &&
    freerdp_settings_set_bool(settings, FreeRDP_ExternalCertificateManagement, !(flags & 1)) &&
    freerdp_settings_set_bool(settings, FreeRDP_RedirectClipboard, !!(flags & 2)) &&
    freerdp_settings_set_bool(settings, FreeRDP_SupportDisplayControl, !!(flags & 8)) &&
    freerdp_settings_set_bool(settings, FreeRDP_DynamicResolutionUpdate, !!(flags & 8)) &&
    freerdp_settings_set_bool(settings, FreeRDP_SupportGraphicsPipeline, !(flags & 4)) &&
    freerdp_settings_set_bool(settings, FreeRDP_GfxH264, !(flags & 4)) &&
    freerdp_settings_set_bool(settings, FreeRDP_GfxAVC444, FALSE) &&
    freerdp_settings_set_bool(settings, FreeRDP_GfxCodecAV1, FALSE) &&
    freerdp_settings_set_bool(settings, FreeRDP_AudioPlayback, FALSE) &&
    freerdp_settings_set_bool(settings, FreeRDP_AudioCapture, FALSE) &&
    freerdp_settings_set_bool(settings, FreeRDP_DeviceRedirection, FALSE) &&
    freerdp_settings_set_bool(settings, FreeRDP_NetworkAutoDetect, FALSE) &&
    freerdp_settings_set_bool(settings, FreeRDP_SupportHeartbeatPdu, FALSE) &&
    freerdp_settings_set_bool(settings, FreeRDP_SupportMultitransport, FALSE) &&
    freerdp_settings_set_bool(settings, FreeRDP_AutoReconnectionEnabled, TRUE) &&
    freerdp_settings_set_uint32(settings, FreeRDP_TcpConnectTimeout, 30000) &&
    freerdp_settings_set_uint32(settings, FreeRDP_ProxyType, proxy ? proxy : PROXY_TYPE_IGNORE);
  if (result && proxy) result = freerdp_settings_set_string(settings, FreeRDP_ProxyHostname, strings[4]) &&
    freerdp_settings_set_uint16(settings, FreeRDP_ProxyPort, (UINT16)proxyPort) &&
    freerdp_settings_set_string(settings, FreeRDP_ProxyUsername, strings[5]) &&
    freerdp_settings_set_string(settings, FreeRDP_ProxyPassword, strings[6]);
done:
  for (UINT32 index = 0; index < 7; index++) if (strings[index]) { SecureZeroMemory(strings[index], strlen(strings[index])); free(strings[index]); }
  SecureZeroMemory(packet, length);
  free(packet);
  return result;
}
